require("dotenv").config();

const {
  createThirdwebClient,
  getContract,
  prepareEvent,
  watchContractEvents,
} = require("thirdweb");

const { defineChain } = require("thirdweb/chains");
const { toTokens } = require("thirdweb/utils");
const { Op } = require("sequelize");

const { Wallet, Transaction } = require("../models");

// =========================================================
// RPC ERROR HANDLER
// =========================================================

process.on("unhandledRejection", (reason) => {
  console.error("⚠️ [RPC Polling Error]:", reason?.message || reason);
});

// =========================================================
// THIRDWEB
// =========================================================

if (!process.env.THIRDWEB_SECRET_KEY) {
  console.error("❌ ERROR: THIRDWEB_SECRET_KEY tidak ditemukan! Cek file .env");
}

const client = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY,
});

// =========================================================
// SEPOLIA
// =========================================================

const customSepolia = defineChain({
  id: 11155111,

  rpc:
    process.env.SEPOLIA_RPC_URL ||
    "https://ethereum-sepolia-rpc.publicnode.com",
});

// =========================================================
// HELPERS
// =========================================================

const normalizeAddress = (address) => {
  if (!address) {
    return "";
  }

  return String(address).trim().toLowerCase();
};

// =========================================================
// EARN POOL ADDRESSES
// =========================================================

const getEarnPoolAddresses = () => {
  return [
    process.env.EARN_POOL_USDT_ADDRESS,
    process.env.EARN_POOL_USDC_ADDRESS,
    process.env.EARN_POOL_GOLD_ADDRESS,
    process.env.EARN_POOL_XAUT_ADDRESS,
  ]
    .filter(Boolean)
    .map(normalizeAddress);
};

const earnPoolAddresses = getEarnPoolAddresses();

console.log("[Blockchain Listener] Earn Pool addresses:", earnPoolAddresses);

// =========================================================
// TOKEN CONFIG
// =========================================================

const getTokensToWatch = () => {
  return [
    {
      name: "USDT",
      address: process.env.USDT_DUMMY_CONTRACT_ADDRESS,
      poolAddress: process.env.EARN_POOL_USDT_ADDRESS,
    },

    {
      name: "USDC",
      address: process.env.USDC_DUMMY_CONTRACT_ADDRESS,
      poolAddress: process.env.EARN_POOL_USDC_ADDRESS,
    },

    {
      name: "GOLD",
      address: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
      poolAddress: process.env.EARN_POOL_GOLD_ADDRESS,
    },

    {
      name: "XAUT",
      address: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
      poolAddress: process.env.EARN_POOL_XAUT_ADDRESS,
    },
  ];
};

// =========================================================
// CHECK EARN POOL TRANSFER
// =========================================================

const isTransferFromEarnPool = (from, poolAddress) => {
  const normalizedFrom = normalizeAddress(from);
  const normalizedPool = normalizeAddress(poolAddress);

  if (!normalizedFrom || !normalizedPool) {
    return false;
  }

  return normalizedFrom === normalizedPool;
};

// =========================================================
// CHECK TRANSACTION
// =========================================================

const findExistingTransaction = async (txHash) => {
  if (!txHash) {
    return null;
  }

  return Transaction.findOne({
    where: {
      tx_hash: txHash,
    },
  });
};

// =========================================================
// CREATE DEPOSIT
// =========================================================

const createDepositTransaction = async ({
  receiverWallet,
  token,
  value,
  txHash,
  blockNumber,
}) => {
  const formattedAmount = toTokens(value, 6);

  const transaction = await Transaction.create({
    core_id: receiverWallet.core_id,

    tx_hash: txHash,

    type: "DEPOSIT",

    asset: token.name,

    amount: formattedAmount,

    tx_block_number: Number(blockNumber),

    status: "PENDING",
  });

  return transaction;
};

// =========================================================
// HANDLE TRANSFER
// =========================================================

const handleTransferEvent = async ({ event, token }) => {
  // =======================================================
  // EVENT DATA
  // =======================================================

  const from = event.args?.from;
  const to = event.args?.to;
  const value = event.args?.value;

  const txHash = event.transactionHash;
  const blockNumber = event.blockNumber;

  // =======================================================
  // BASIC VALIDATION
  // =======================================================

  if (!to) {
    console.log(
      `[Blockchain Listener] ${token.name} transfer tanpa receiver. Skip.`,
    );

    return;
  }

  if (!txHash) {
    console.log(
      `[Blockchain Listener] ${token.name} transfer tanpa txHash. Skip.`,
    );

    return;
  }

  if (value === undefined || value === null) {
    console.log(
      `[Blockchain Listener] ${token.name} transfer tanpa value. Skip.`,
    );

    return;
  }

  // =======================================================
  // LOG EVENT
  // =======================================================

  console.log(`[Blockchain Listener] ${token.name} Transfer detected:`, {
    from,
    to,
    value: value?.toString?.() || String(value),
    txHash,
    blockNumber,
  });

  // =======================================================
  // 1. CEK EARN POOL
  // =======================================================

  const isEarnPoolTransfer = isTransferFromEarnPool(from, token.poolAddress);

  if (isEarnPoolTransfer) {
    console.log(
      `🚫 [Blockchain Listener] ${token.name} transfer di-skip karena berasal dari Earn Pool.`,
    );

    console.log(`[Blockchain Listener] Earn Pool: ${token.poolAddress}`);

    console.log(`[Blockchain Listener] TX: ${txHash}`);

    return;
  }

  // =======================================================
  // 2. CEK SEMUA EARN POOL
  // =======================================================

  const normalizedFrom = normalizeAddress(from);

  if (normalizedFrom && earnPoolAddresses.includes(normalizedFrom)) {
    console.log(
      `🚫 [Blockchain Listener] ${token.name} transfer di-skip karena FROM adalah Earn Pool.`,
    );

    console.log(`[Blockchain Listener] FROM: ${from}`);

    console.log(`[Blockchain Listener] TX: ${txHash}`);

    return;
  }

  // =======================================================
  // 3. CEK TRANSACTION YANG SUDAH ADA
  // =======================================================

  const existingTx = await findExistingTransaction(txHash);

  if (existingTx) {
    console.log(`ℹ️ [Blockchain Listener] TX sudah tercatat. Skip.`);

    console.log({
      txHash,
      type: existingTx.type,
      coreId: existingTx.core_id,
      asset: existingTx.asset,
    });

    return;
  }

  // =======================================================
  // 4. CARI USER WALLET
  // =======================================================

  const receiverWallet = await Wallet.findOne({
    where: {
      address: {
        [Op.iLike]: to,
      },
    },
  });

  if (!receiverWallet) {
    console.log(
      `[Blockchain Listener] ${token.name} transfer bukan ke wallet user yang terdaftar.`,
    );

    return;
  }

  // =======================================================
  // 5. EXTRA CHECK EARN CLAIM
  // =======================================================

  const earnClaimTx = await Transaction.findOne({
    where: {
      tx_hash: txHash,

      type: "EARN_CLAIM",
    },
  });

  if (earnClaimTx) {
    console.log(
      `🚫 [Blockchain Listener] TX adalah EARN_CLAIM. Tidak dibuat sebagai deposit.`,
    );

    console.log({
      txHash,
      coreId: earnClaimTx.core_id,
      asset: earnClaimTx.asset,
    });

    return;
  }

  // =======================================================
  // 6. DEPOSIT NORMAL
  // =======================================================

  console.log(
    `✅ Deposit ${token.name} terdeteksi untuk user ${receiverWallet.core_id}! Hash: ${txHash}`,
  );

  // =======================================================
  // 7. CREATE DEPOSIT
  // =======================================================

  const transaction = await createDepositTransaction({
    receiverWallet,
    token,
    value,
    txHash,
    blockNumber,
  });

  console.log(`💾 Transaksi ${token.name} berhasil disimpan sebagai DEPOSIT!`);

  console.log({
    id: transaction.id,
    coreId: transaction.core_id,
    txHash: transaction.tx_hash,
    asset: transaction.asset,
    amount: transaction.amount,
    type: transaction.type,
  });
};

// =========================================================
// START LISTENER
// =========================================================

const startBlockchainListener = async () => {
  console.log("");
  console.log("========================================");
  console.log("📡 MULTI-TOKEN BLOCKCHAIN LISTENER");
  console.log("========================================");

  const tokensToWatch = getTokensToWatch();

  // =======================================================
  // TRANSFER EVENT
  // =======================================================

  const transferEvent = prepareEvent({
    signature:
      "event Transfer(address indexed from,address indexed to,uint256 value)",
  });

  // =======================================================
  // LOOP TOKEN
  // =======================================================

  for (const token of tokensToWatch) {
    // =====================================================
    // TOKEN ADDRESS CHECK
    // =====================================================

    if (!token.address) {
      console.warn(
        `⚠️ Alamat kontrak ${token.name} belum diset di .env. Dilewati.`,
      );

      continue;
    }

    // =====================================================
    // CONTRACT
    // =====================================================

    const contract = getContract({
      client,

      chain: customSepolia,

      address: token.address,
    });

    console.log("");
    console.log(`[Blockchain Listener] Watching ${token.name}`);

    console.log(`[Blockchain Listener] Token: ${token.address}`);

    console.log(
      `[Blockchain Listener] Earn Pool: ${
        token.poolAddress || "NOT CONFIGURED"
      }`,
    );

    // =====================================================
    // WATCH
    // =====================================================

    watchContractEvents({
      contract,

      events: [transferEvent],

      onEvents: async (events) => {
        if (!Array.isArray(events) || events.length === 0) {
          return;
        }

        console.log(
          `[Blockchain Listener] ${token.name}: ${events.length} event(s) diterima.`,
        );

        // =================================================
        // EVENT LOOP
        // =================================================

        for (const event of events) {
          try {
            await handleTransferEvent({
              event,
              token,
            });
          } catch (error) {
            console.error(
              `[Blockchain Listener] Gagal memproses ${token.name} transfer:`,
              error?.message || error,
            );

            console.error(error);
          }
        }
      },
    });
  }

  console.log("");
  console.log("========================================");
  console.log("✅ Blockchain listener aktif.");
  console.log("========================================");
};

// =========================================================
// EXPORT
// =========================================================

module.exports = {
  startBlockchainListener,
};
