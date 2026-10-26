const { Worker } = require("bullmq");
const Decimal = require("decimal.js");
const Redis = require("ioredis");

const {
  createThirdwebClient,
  getContract,
  prepareContractCall,
  sendTransaction,
  waitForReceipt,
  readContract,
} = require("thirdweb");

const { decimals, balanceOf } = require("thirdweb/extensions/erc20");
const { privateKeyToAccount } = require("thirdweb/wallets");
const { sepolia } = require("../utils/chain");

const {
  Swap,
  SwapRefund,
  SwapEvent,
  InternalWallet,
  InternalTransaction,
  Wallet,
  sequelize,
} = require("../models");

const {
  getUserSmartAccount,
} = require("../services/earn/earn.blockchain.service");

const connection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

if (!process.env.THIRDWEB_SECRET_KEY) {
  throw new Error("THIRDWEB_SECRET_KEY belum dikonfigurasi");
}

if (!process.env.VALORA_ADMIN_PRIVATE_KEY) {
  throw new Error("VALORA_ADMIN_PRIVATE_KEY belum dikonfigurasi");
}

const thirdwebClient = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY,
});

const operatorAccount = privateKeyToAccount({
  client: thirdwebClient,
  privateKey: process.env.VALORA_ADMIN_PRIVATE_KEY,
});

const POOLS = {
  USDT: {
    poolAddress: process.env.SWAP_USDT_POOL_ADDRESS,
    tokenAddress: process.env.USDT_DUMMY_CONTRACT_ADDRESS,
  },
  USDC: {
    poolAddress: process.env.SWAP_USDC_POOL_ADDRESS,
    tokenAddress: process.env.USDC_DUMMY_CONTRACT_ADDRESS,
  },
  GOLD: {
    poolAddress: process.env.SWAP_GOLD_POOL_ADDRESS,
    tokenAddress: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
  },
  XAUT: {
    poolAddress: process.env.SWAP_XAUT_POOL_ADDRESS,
    tokenAddress: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
  },
};

const POOL_ABI = [
  {
    type: "function",
    name: "tokenBalance",
    stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
];

const SWAP_LOCK_TTL = 30 * 60;

function normalizeAddress(address) {
  return String(address || "")
    .trim()
    .toLowerCase();
}

function getPoolConfig(asset) {
  const normalizedAsset = String(asset || "")
    .trim()
    .toUpperCase();

  const config = POOLS[normalizedAsset];

  if (!config) {
    throw new Error(`Pool ${normalizedAsset} tidak ditemukan`);
  }

  if (!config.poolAddress) {
    throw new Error(`Pool address ${normalizedAsset} belum dikonfigurasi`);
  }

  if (!config.tokenAddress) {
    throw new Error(`Token address ${normalizedAsset} belum dikonfigurasi`);
  }

  return config;
}

async function acquireSwapLock(swapId) {
  const key = `swap:processing:${swapId}`;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;

  const acquired = await connection.set(key, token, "EX", SWAP_LOCK_TTL, "NX");

  return {
    acquired: acquired === "OK",
    key,
    token,
  };
}

async function releaseSwapLock(lock) {
  if (!lock?.key || !lock?.token) {
    return;
  }

  try {
    await connection.eval(
      `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        end
        return 0
      `,
      1,
      lock.key,
      lock.token,
    );
  } catch (error) {
    console.error(
      `[SWAP WORKER] Failed release lock ${lock.key}:`,
      error.message,
    );
  }
}

async function addEvent(
  swapId,
  coreId,
  eventType,
  data = {},
  transaction = null,
) {
  const where = {
    swapId,
    eventType,
  };

  if (data.txHash) {
    where.txHash = data.txHash;
  }

  const existing = await SwapEvent.findOne({
    where,
    ...(transaction
      ? {
          transaction,
          lock: transaction.LOCK.UPDATE,
        }
      : {}),
  });

  if (existing) {
    return existing;
  }

  return SwapEvent.create(
    {
      swapId,
      coreId,
      eventType,
      status: data.status || null,
      txHash: data.txHash || null,
      blockNumber: data.blockNumber || null,
      metadata: data.metadata || {},
    },
    transaction ? { transaction } : undefined,
  );
}

function getPoolContract(asset) {
  const config = getPoolConfig(asset);

  return getContract({
    client: thirdwebClient,
    chain: sepolia,
    address: config.poolAddress,
    abi: POOL_ABI,
  });
}

async function getPoolBalance(asset) {
  const config = getPoolConfig(asset);

  const pool = getPoolContract(asset);

  const token = getContract({
    client: thirdwebClient,
    chain: sepolia,
    address: config.tokenAddress,
  });

  const tokenDecimals = Number(
    await decimals({
      contract: token,
    }),
  );

  const [accountingRaw, erc20Raw] = await Promise.all([
    readContract({
      contract: pool,
      method: "function tokenBalance(address token) view returns (uint256)",
      params: [config.tokenAddress],
    }),

    balanceOf({
      contract: token,
      address: config.poolAddress,
    }),
  ]);

  const divisor = new Decimal(10).pow(tokenDecimals);

  const accountingBalance = new Decimal(accountingRaw.toString()).div(divisor);

  const erc20Balance = new Decimal(erc20Raw.toString()).div(divisor);

  return {
    raw: accountingRaw,
    decimal: accountingBalance,
    decimals: tokenDecimals,
    erc20Raw,
    erc20Balance,
  };
}

async function getSwapInternalTransaction(swapId, transaction) {
  return InternalTransaction.findOne({
    where: {
      swapId,
      type: "DEBIT",
      asset: "IDR",
      status: "SUCCESS",
    },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
}

async function debitIdr(swap, transaction) {
  const existing = await getSwapInternalTransaction(swap.id, transaction);

  if (existing) {
    return existing;
  }

  const wallet = await InternalWallet.findOne({
    where: {
      coreId: swap.coreId,
    },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });

  if (!wallet) {
    throw new Error("Internal wallet tidak ditemukan");
  }

  const amount = new Decimal(swap.fromAmount);
  const before = new Decimal(wallet.balanceIdr || 0);

  if (before.lt(amount)) {
    throw new Error("Saldo IDR tidak cukup");
  }

  const after = before.minus(amount);

  await wallet.update(
    {
      balanceIdr: after.toFixed(2),
    },
    {
      transaction,
    },
  );

  return InternalTransaction.create(
    {
      internalWalletId: wallet.id,
      swapId: swap.id,
      coreId: swap.coreId,
      type: "DEBIT",
      asset: "IDR",
      amount: amount.toFixed(2),
      balanceBefore: before.toFixed(2),
      balanceAfter: after.toFixed(2),
      reference: `SWAP-DEBIT-${swap.id}`,
      status: "SUCCESS",
      description: `Swap ${swap.fromAsset} to ${swap.toAsset}`,
      metadata: {
        swapId: swap.id,
      },
    },
    {
      transaction,
    },
  );
}

async function refundIdr(swap, reason) {
  return sequelize.transaction(async (transaction) => {
    const existingRefund = await SwapRefund.findOne({
      where: {
        swapId: swap.id,
        refundType: "IDR",
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (existingRefund?.status === "COMPLETED") {
      return existingRefund;
    }

    const existingTransaction = await InternalTransaction.findOne({
      where: {
        swapId: swap.id,
        reference: `SWAP-REFUND-${swap.id}`,
        type: "CREDIT",
        status: "SUCCESS",
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (existingTransaction) {
      await swap.update(
        {
          status: "REFUNDED",
          failureReason: reason,
          refundedAt: new Date(),
          failedAt: new Date(),
        },
        {
          transaction,
        },
      );

      if (existingRefund) {
        await existingRefund.update(
          {
            status: "COMPLETED",
            processedAt: new Date(),
            completedAt: new Date(),
            reason,
          },
          {
            transaction,
          },
        );
      }

      return existingRefund;
    }

    const wallet = await InternalWallet.findOne({
      where: {
        coreId: swap.coreId,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!wallet) {
      throw new Error("Internal wallet tidak ditemukan");
    }

    const amount = new Decimal(swap.fromAmount);
    const before = new Decimal(wallet.balanceIdr || 0);
    const after = before.plus(amount);

    await wallet.update(
      {
        balanceIdr: after.toFixed(2),
      },
      {
        transaction,
      },
    );

    const internalTransaction = await InternalTransaction.create(
      {
        internalWalletId: wallet.id,
        swapId: swap.id,
        coreId: swap.coreId,
        type: "CREDIT",
        asset: "IDR",
        amount: amount.toFixed(2),
        balanceBefore: before.toFixed(2),
        balanceAfter: after.toFixed(2),
        reference: `SWAP-REFUND-${swap.id}`,
        status: "SUCCESS",
        description: reason,
        metadata: {
          swapId: swap.id,
          reason,
        },
      },
      {
        transaction,
      },
    );

    let refund = existingRefund;

    if (!refund) {
      refund = await SwapRefund.create(
        {
          swapId: swap.id,
          coreId: swap.coreId,
          asset: "IDR",
          amount: amount.toFixed(2),
          refundType: "IDR",
          status: "COMPLETED",
          reason,
          processedAt: new Date(),
          completedAt: new Date(),
        },
        {
          transaction,
        },
      );
    } else {
      await refund.update(
        {
          status: "COMPLETED",
          processedAt: new Date(),
          completedAt: new Date(),
          reason,
        },
        {
          transaction,
        },
      );
    }

    await swap.update(
      {
        status: "REFUNDED",
        failureReason: reason,
        refundedAt: new Date(),
        failedAt: new Date(),
      },
      {
        transaction,
      },
    );

    await addEvent(
      swap.id,
      swap.coreId,
      "REFUND_COMPLETED",
      {
        status: "COMPLETED",
        metadata: {
          asset: "IDR",
          amount: amount.toFixed(2),
          reason,
          internalTransactionId: internalTransaction.id,
        },
      },
      transaction,
    );

    return refund;
  });
}

async function recoverExistingDeposit(swap) {
  const txHash = swap.depositTxHash;

  if (!txHash) {
    throw new Error("depositTxHash tidak tersedia");
  }

  console.log(`[SWAP WORKER] Recovering deposit ${txHash}`);

  const receipt = await waitForReceipt({
    client: thirdwebClient,
    chain: sepolia,
    transactionHash: txHash,
  });

  if (!receipt) {
    throw new Error(`Receipt tidak ditemukan: ${txHash}`);
  }

  if (receipt.status !== "success") {
    throw new Error(`Deposit transaction gagal: ${txHash}`);
  }

  await swap.update({
    fromBlockNumber: receipt.blockNumber,
    status: "PROCESSING",
  });

  await addEvent(swap.id, swap.coreId, "DEPOSIT_CONFIRMED", {
    status: "SUCCESS",
    txHash,
    blockNumber: receipt.blockNumber,
    metadata: {
      asset: swap.fromAsset,
      amount: swap.fromAmount,
    },
  });

  return receipt;
}

async function recoverExistingWithdrawal(swap) {
  const txHash = swap.withdrawalTxHash;

  if (!txHash) {
    throw new Error("withdrawalTxHash tidak tersedia");
  }

  console.log(`[SWAP WORKER] Recovering withdrawal ${txHash}`);

  const receipt = await waitForReceipt({
    client: thirdwebClient,
    chain: sepolia,
    transactionHash: txHash,
  });

  if (!receipt) {
    throw new Error(`Receipt tidak ditemukan: ${txHash}`);
  }

  if (receipt.status !== "success") {
    throw new Error(`Withdrawal transaction gagal: ${txHash}`);
  }

  await swap.update({
    toBlockNumber: receipt.blockNumber,
    status: "PROCESSING",
  });

  await addEvent(swap.id, swap.coreId, "WITHDRAWAL_CONFIRMED", {
    status: "SUCCESS",
    txHash,
    blockNumber: receipt.blockNumber,
    metadata: {
      asset: swap.toAsset,
      amount: swap.receiveAmount,
    },
  });

  return receipt;
}

async function withdrawFromPool(swap) {
  if (swap.withdrawalTxHash) {
    return recoverExistingWithdrawal(swap);
  }

  const asset = String(swap.toAsset).toUpperCase();

  const config = getPoolConfig(asset);

  if (!swap.toWalletAddress) {
    throw new Error("toWalletAddress tidak tersedia");
  }

  const amount = new Decimal(swap.receiveAmount);

  const { decimal: poolBalance, decimals: tokenDecimals } =
    await getPoolBalance(asset);

  if (poolBalance.lt(amount)) {
    throw new Error(
      `Likuiditas ${asset} tidak cukup. Pool=${poolBalance.toString()} Required=${amount.toString()}`,
    );
  }

  const rawAmount = BigInt(
    amount.mul(new Decimal(10).pow(tokenDecimals)).floor().toFixed(0),
  );

  if (rawAmount <= 0n) {
    throw new Error("Amount withdrawal tidak valid");
  }

  const pool = getPoolContract(asset);

  const transaction = prepareContractCall({
    contract: pool,
    method: "function withdraw(address token,address to,uint256 amount)",
    params: [config.tokenAddress, swap.toWalletAddress, rawAmount],
  });

  console.log(
    `[SWAP WORKER] Sending withdrawal ${amount.toString()} ${asset} -> ${swap.toWalletAddress}`,
  );

  const result = await sendTransaction({
    transaction,
    account: operatorAccount,
  });

  const txHash = result.transactionHash;

  if (!txHash) {
    throw new Error("Withdrawal tidak menghasilkan transaction hash");
  }

  console.log(`[SWAP WORKER] Withdrawal submitted: ${txHash}`);

  await swap.update({
    withdrawalTxHash: txHash,
    status: "PROCESSING",
    processedAt: new Date(),
  });

  await addEvent(swap.id, swap.coreId, "WITHDRAWAL_SUBMITTED", {
    status: "PROCESSING",
    txHash,
    metadata: {
      asset,
      amount: amount.toString(),
      to: swap.toWalletAddress,
      amountRaw: rawAmount.toString(),
    },
  });

  const receipt = await waitForReceipt({
    client: thirdwebClient,
    chain: sepolia,
    transactionHash: txHash,
  });

  if (!receipt) {
    throw new Error(`Receipt tidak ditemukan: ${txHash}`);
  }

  if (receipt.status !== "success") {
    throw new Error(`Withdrawal gagal/reverted: ${txHash}`);
  }

  await swap.update({
    toBlockNumber: receipt.blockNumber,
    status: "PROCESSING",
  });

  await addEvent(swap.id, swap.coreId, "WITHDRAWAL_CONFIRMED", {
    status: "SUCCESS",
    txHash,
    blockNumber: receipt.blockNumber,
    metadata: {
      asset,
      amount: amount.toString(),
      amountRaw: rawAmount.toString(),
    },
  });

  return receipt;
}

async function transferCryptoToPool(swap) {
  if (swap.depositTxHash) {
    return recoverExistingDeposit(swap);
  }

  const asset = String(swap.fromAsset).toUpperCase();

  const config = getPoolConfig(asset);

  if (!swap.fromWalletAddress) {
    throw new Error("fromWalletAddress tidak tersedia");
  }

  const wallet = await Wallet.findOne({
    where: {
      core_id: swap.coreId,
    },
  });

  if (!wallet?.address) {
    throw new Error("Smart Wallet user tidak ditemukan");
  }

  if (
    normalizeAddress(wallet.address) !==
    normalizeAddress(swap.fromWalletAddress)
  ) {
    throw new Error(
      `Wallet mismatch. DB=${wallet.address}, Swap=${swap.fromWalletAddress}`,
    );
  }

  const smartAccount = await getUserSmartAccount(wallet, swap.coreId);

  if (!smartAccount?.address) {
    throw new Error("Smart Account tidak berhasil dibuat");
  }

  if (
    normalizeAddress(smartAccount.address) !== normalizeAddress(wallet.address)
  ) {
    throw new Error(
      `Smart Account mismatch. DB=${wallet.address}, Thirdweb=${smartAccount.address}`,
    );
  }

  const token = getContract({
    client: thirdwebClient,
    chain: sepolia,
    address: config.tokenAddress,
  });

  const tokenDecimals = Number(
    await decimals({
      contract: token,
    }),
  );

  const rawAmount = BigInt(
    new Decimal(swap.fromAmount)
      .mul(new Decimal(10).pow(tokenDecimals))
      .floor()
      .toFixed(0),
  );

  if (rawAmount <= 0n) {
    throw new Error("Amount transfer tidak valid");
  }

  // Race read-after-write: deposit user bisa baru landing — provider
  // round-robin bisa belum sync. Kalau saldo kelihatan kurang, poll
  // beberapa kali sebelum beneran gagal.
  let userBalance = 0n;
  for (let i = 0; i < 5; i++) {
    userBalance = BigInt(
      (
        await balanceOf({
          contract: token,
          address: smartAccount.address,
        })
      ).toString(),
    );
    if (userBalance >= rawAmount) break;
    if (i < 4) await new Promise((r) => setTimeout(r, 2000));
  }

  if (userBalance < rawAmount) {
    throw new Error(`Saldo ${asset} tidak cukup`);
  }

  console.log(
    `[SWAP WORKER] Sending ${swap.fromAmount} ${asset} -> ${config.poolAddress}`,
  );

  const transaction = prepareContractCall({
    contract: token,
    method: "function transfer(address to,uint256 amount) returns (bool)",
    params: [config.poolAddress, rawAmount],
  });

  const result = await sendTransaction({
    transaction,
    account: smartAccount,
  });

  const txHash = result.transactionHash;

  if (!txHash) {
    throw new Error("Transfer crypto tidak menghasilkan transaction hash");
  }

  console.log(`[SWAP WORKER] Deposit submitted: ${txHash}`);

  await swap.update({
    depositTxHash: txHash,
    status: "PROCESSING",
    processedAt: new Date(),
  });

  await addEvent(swap.id, swap.coreId, "DEPOSIT_DETECTED", {
    status: "PROCESSING",
    txHash,
    metadata: {
      asset,
      amount: swap.fromAmount,
      amountRaw: rawAmount.toString(),
      from: smartAccount.address,
      to: config.poolAddress,
    },
  });

  const receipt = await waitForReceipt({
    client: thirdwebClient,
    chain: sepolia,
    transactionHash: txHash,
  });

  if (!receipt) {
    throw new Error(`Receipt tidak ditemukan: ${txHash}`);
  }

  if (receipt.status !== "success") {
    throw new Error(`Transfer ${asset} gagal/reverted: ${txHash}`);
  }

  await swap.update({
    fromBlockNumber: receipt.blockNumber,
    status: "PROCESSING",
  });

  await addEvent(swap.id, swap.coreId, "DEPOSIT_CONFIRMED", {
    status: "SUCCESS",
    txHash,
    blockNumber: receipt.blockNumber,
    metadata: {
      asset,
      amount: swap.fromAmount,
      amountRaw: rawAmount.toString(),
      from: smartAccount.address,
      to: config.poolAddress,
    },
  });

  return receipt;
}

async function processIdrToCrypto(swap) {
  await sequelize.transaction(async (transaction) => {
    await debitIdr(swap, transaction);

    await swap.update(
      {
        status: "PROCESSING",
        processedAt: new Date(),
      },
      {
        transaction,
      },
    );

    await addEvent(
      swap.id,
      swap.coreId,
      "PROCESSING",
      {
        status: "PROCESSING",
      },
      transaction,
    );
  });

  await withdrawFromPool(swap);

  await sequelize.transaction(async (transaction) => {
    const lockedSwap = await Swap.findOne({
      where: {
        id: swap.id,
        coreId: swap.coreId,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!lockedSwap) {
      throw new Error("Swap tidak ditemukan");
    }

    if (String(lockedSwap.status || "").toUpperCase() === "COMPLETED") {
      return;
    }

    await lockedSwap.update(
      {
        status: "COMPLETED",
        completedAt: new Date(),
      },
      {
        transaction,
      },
    );

    await addEvent(
      lockedSwap.id,
      lockedSwap.coreId,
      "COMPLETED",
      {
        status: "SUCCESS",
        txHash: lockedSwap.withdrawalTxHash,
        blockNumber: lockedSwap.toBlockNumber,
        metadata: {
          fromAsset: lockedSwap.fromAsset,
          toAsset: lockedSwap.toAsset,
          receiveAmount: lockedSwap.receiveAmount,
        },
      },
      transaction,
    );
  });
}

async function processCryptoToIdr(swap) {
  const receipt = await transferCryptoToPool(swap);

  await sequelize.transaction(async (transaction) => {
    const lockedSwap = await Swap.findOne({
      where: {
        id: swap.id,
        coreId: swap.coreId,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!lockedSwap) {
      throw new Error("Swap tidak ditemukan");
    }

    if (String(lockedSwap.status || "").toUpperCase() === "COMPLETED") {
      return;
    }

    const wallet = await InternalWallet.findOne({
      where: {
        coreId: lockedSwap.coreId,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!wallet) {
      throw new Error("Internal wallet tidak ditemukan");
    }

    const depositTxHash = lockedSwap.depositTxHash;

    if (!depositTxHash) {
      throw new Error("depositTxHash tidak tersedia");
    }

    await addEvent(
      lockedSwap.id,
      lockedSwap.coreId,
      "DEPOSIT_CONFIRMED",
      {
        status: "SUCCESS",
        txHash: depositTxHash,
        blockNumber: receipt.blockNumber,
        metadata: {
          asset: lockedSwap.fromAsset,
          amount: lockedSwap.fromAmount,
        },
      },
      transaction,
    );

    const existingCredit = await InternalTransaction.findOne({
      where: {
        swapId: lockedSwap.id,
        reference: `SWAP-CREDIT-${lockedSwap.id}`,
        type: "CREDIT",
        asset: "IDR",
        status: "SUCCESS",
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (existingCredit) {
      await lockedSwap.update(
        {
          status: "COMPLETED",
          completedAt: lockedSwap.completedAt || new Date(),
          fromBlockNumber: receipt.blockNumber,
        },
        {
          transaction,
        },
      );

      await addEvent(
        lockedSwap.id,
        lockedSwap.coreId,
        "COMPLETED",
        {
          status: "SUCCESS",
          txHash: depositTxHash,
          blockNumber: receipt.blockNumber,
          metadata: {
            fromAsset: lockedSwap.fromAsset,
            toAsset: lockedSwap.toAsset,
            receiveAmount: lockedSwap.receiveAmount,
            internalTransactionId: existingCredit.id,
          },
        },
        transaction,
      );

      return;
    }

    const amount = new Decimal(lockedSwap.receiveAmount);

    const before = new Decimal(wallet.balanceIdr || 0);

    const after = before.plus(amount);

    await wallet.update(
      {
        balanceIdr: after.toFixed(2),
      },
      {
        transaction,
      },
    );

    const internalTransaction = await InternalTransaction.create(
      {
        internalWalletId: wallet.id,
        swapId: lockedSwap.id,
        coreId: lockedSwap.coreId,
        type: "CREDIT",
        asset: "IDR",
        amount: amount.toFixed(2),
        balanceBefore: before.toFixed(2),
        balanceAfter: after.toFixed(2),
        reference: `SWAP-CREDIT-${lockedSwap.id}`,
        status: "SUCCESS",
        description: `Swap ${lockedSwap.fromAsset} to IDR`,
        metadata: {
          swapId: lockedSwap.id,
          depositTxHash,
          depositAsset: lockedSwap.fromAsset,
          depositAmount: lockedSwap.fromAmount,
        },
      },
      {
        transaction,
      },
    );

    await lockedSwap.update(
      {
        status: "COMPLETED",
        completedAt: new Date(),
        fromBlockNumber: receipt.blockNumber,
        processedAt: lockedSwap.processedAt || new Date(),
      },
      {
        transaction,
      },
    );

    await addEvent(
      lockedSwap.id,
      lockedSwap.coreId,
      "COMPLETED",
      {
        status: "SUCCESS",
        txHash: depositTxHash,
        blockNumber: receipt.blockNumber,
        metadata: {
          fromAsset: lockedSwap.fromAsset,
          toAsset: lockedSwap.toAsset,
          receiveAmount: lockedSwap.receiveAmount,
          internalTransactionId: internalTransaction.id,
        },
      },
      transaction,
    );
  });
}

async function processCryptoToCrypto(swap) {
  const fromAsset = String(swap.fromAsset || "").toUpperCase();

  const toAsset = String(swap.toAsset || "").toUpperCase();

  if (fromAsset === "IDR" || toAsset === "IDR") {
    throw new Error("processCryptoToCrypto hanya untuk Crypto -> Crypto");
  }

  if (fromAsset === toAsset) {
    throw new Error("Asset asal dan tujuan tidak boleh sama");
  }

  getPoolConfig(fromAsset);
  getPoolConfig(toAsset);

  if (!swap.fromWalletAddress) {
    throw new Error("fromWalletAddress tidak tersedia");
  }

  if (!swap.toWalletAddress) {
    throw new Error("toWalletAddress tidak tersedia");
  }

  const wallet = await Wallet.findOne({
    where: {
      core_id: swap.coreId,
    },
  });

  if (!wallet?.address) {
    throw new Error("Smart Wallet user tidak ditemukan");
  }

  if (
    normalizeAddress(wallet.address) !==
    normalizeAddress(swap.fromWalletAddress)
  ) {
    throw new Error(
      `From wallet mismatch. DB=${wallet.address}, Swap=${swap.fromWalletAddress}`,
    );
  }

  if (
    normalizeAddress(wallet.address) !== normalizeAddress(swap.toWalletAddress)
  ) {
    throw new Error(
      `To wallet mismatch. DB=${wallet.address}, Swap=${swap.toWalletAddress}`,
    );
  }

  console.log(`[SWAP WORKER] Crypto -> Crypto ${fromAsset} -> ${toAsset}`);

  await transferCryptoToPool(swap);

  await withdrawFromPool(swap);

  await sequelize.transaction(async (transaction) => {
    const lockedSwap = await Swap.findOne({
      where: {
        id: swap.id,
        coreId: swap.coreId,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    if (!lockedSwap) {
      throw new Error("Swap tidak ditemukan");
    }

    if (String(lockedSwap.status || "").toUpperCase() === "COMPLETED") {
      return;
    }

    await lockedSwap.update(
      {
        status: "COMPLETED",
        completedAt: new Date(),
        processedAt: lockedSwap.processedAt || new Date(),
      },
      {
        transaction,
      },
    );

    await addEvent(
      lockedSwap.id,
      lockedSwap.coreId,
      "COMPLETED",
      {
        status: "SUCCESS",
        txHash: lockedSwap.withdrawalTxHash,
        blockNumber: lockedSwap.toBlockNumber,
        metadata: {
          fromAsset,
          toAsset,
          fromAmount: lockedSwap.fromAmount,
          receiveAmount: lockedSwap.receiveAmount,
          depositTxHash: lockedSwap.depositTxHash,
          withdrawalTxHash: lockedSwap.withdrawalTxHash,
        },
      },
      transaction,
    );
  });

  console.log(
    `[SWAP WORKER] Crypto -> Crypto COMPLETED ${swap.id}: ${fromAsset} -> ${toAsset}`,
  );
}

async function processSwap(swapId, coreId) {
  const swap = await Swap.findOne({
    where: {
      id: swapId,
      coreId,
    },
  });

  if (!swap) {
    throw new Error("Swap tidak ditemukan");
  }

  const status = String(swap.status || "").toUpperCase();

  if (["COMPLETED", "REFUNDED"].includes(status)) {
    return;
  }

  const fromAsset = String(swap.fromAsset).toUpperCase();

  const toAsset = String(swap.toAsset).toUpperCase();

  if (fromAsset === "IDR" && toAsset !== "IDR") {
    try {
      await processIdrToCrypto(swap);
    } catch (error) {
      await swap.reload();

      if (!swap.withdrawalTxHash && swap.status !== "REFUNDED") {
        await refundIdr(swap, error.message);
      }

      throw error;
    }

    return;
  }

  if (fromAsset !== "IDR" && toAsset === "IDR") {
    await processCryptoToIdr(swap);
    return;
  }

  if (fromAsset !== "IDR" && toAsset !== "IDR") {
    await processCryptoToCrypto(swap);
    return;
  }

  throw new Error("Pair swap tidak valid");
}

const worker = new Worker(
  "swap",
  async (job) => {
    if (job.name !== "process-swap") {
      return;
    }

    const { swapId, coreId } = job.data;

    const lock = await acquireSwapLock(swapId);

    if (!lock.acquired) {
      console.log(`[SWAP WORKER] Swap ${swapId} sedang diproses worker lain`);

      return;
    }

    try {
      console.log(`[SWAP WORKER] Processing ${swapId}`);

      const currentSwap = await Swap.findOne({
        where: {
          id: swapId,
          coreId,
        },
      });

      if (!currentSwap) {
        throw new Error("Swap tidak ditemukan");
      }

      const status = String(currentSwap.status || "").toUpperCase();

      if (["COMPLETED", "REFUNDED"].includes(status)) {
        console.log(`[SWAP WORKER] Swap ${swapId} sudah ${status}, skip`);

        return;
      }

      await processSwap(swapId, coreId);

      console.log(`[SWAP WORKER] Completed ${swapId}`);
    } catch (error) {
      console.error(`[SWAP WORKER] Failed ${swapId}:`, error.message);

      throw error;
    } finally {
      await releaseSwapLock(lock);
    }
  },
  {
    connection,
    concurrency: 1,
  },
);

worker.on("completed", (job) => {
  console.log(`[SWAP WORKER] Job completed: ${job.id}`);
});

worker.on("failed", (job, error) => {
  console.error(`[SWAP WORKER] Job failed: ${job?.id}`, error.message);
});

worker.on("error", (error) => {
  console.error("[SWAP WORKER] Worker error:", error);
});

console.log(`[SWAP WORKER] Started. Operator: ${operatorAccount.address}`);

module.exports = worker;
