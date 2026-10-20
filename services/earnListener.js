require("dotenv").config();
const {
  createThirdwebClient,
  getContract,
  prepareEvent,
  watchContractEvents,
} = require("thirdweb");
const { sepolia: customSepolia } = require("../utils/chain");
const { toTokens } = require("thirdweb/utils");
const { Op } = require("sequelize");
const { Wallet, Transaction } = require("../models");
const { LEGACY_EARN_POOLS } = require("./earn/earn.constants");

if (!process.env.THIRDWEB_SECRET_KEY) {
  console.error(
    "❌ ERROR: THIRDWEB_SECRET_KEY tidak ditemukan untuk Earn Listener!",
  );
}

const client = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY,
});

const getEarnPoolsToWatch = () => [
  {
    name: "USDT_POOL",
    asset: "USDT",
    address: process.env.EARN_USDT_POOL_CONTRACT_ADDRESS,
  },
  {
    name: "USDC_POOL",
    asset: "USDC",
    address: process.env.EARN_USDC_POOL_CONTRACT_ADDRESS,
  },
  {
    name: "GOLD_POOL",
    asset: "GOLD",
    address: process.env.EARN_GOLD_POOL_CONTRACT_ADDRESS,
  },
  {
    name: "XAUT_POOL",
    asset: "XAUT",
    address: process.env.EARN_XAUT_POOL_CONTRACT_ADDRESS,
  },
  // Pool v1 — tetap discan karena posisi lama masih bisa claim
  {
    name: "USDT_POOL_V1",
    asset: "USDT",
    address: LEGACY_EARN_POOLS.USDT,
  },
  {
    name: "USDC_POOL_V1",
    asset: "USDC",
    address: LEGACY_EARN_POOLS.USDC,
  },
  {
    name: "GOLD_POOL_V1",
    asset: "GOLD",
    address: LEGACY_EARN_POOLS.GOLD,
  },
  {
    name: "XAUT_POOL_V1",
    asset: "XAUT",
    address: LEGACY_EARN_POOLS.XAUT,
  },
];

const handleEarnCreatedEvent = async ({ event, pool }) => {
  const { user, positionId, principal } = event.args;
  const txHash = event.transactionHash;
  const blockNumber = event.blockNumber;

  try {
    const userWallet = await Wallet.findOne({
      where: { address: { [Op.iLike]: user } },
    });

    if (userWallet) {
      console.log(
        `🎯 [Earn Create] User ${userWallet.core_id} membuka posisi #${positionId} (${pool.asset})! Hash: ${txHash}`,
      );

      const existingTx = await Transaction.findOne({
        where: { tx_hash: txHash },
      });

      if (!existingTx) {
        const formattedPrincipal = toTokens(principal, 6);

        await Transaction.create({
          core_id: userWallet.core_id,
          tx_hash: txHash,
          type: "EARN_DEPOSIT",
          asset: pool.asset,
          amount: formattedPrincipal,
          tx_block_number: Number(blockNumber),
          status: "COMPLETED",
        });

        console.log(
          `💾 Transaksi EARN_DEPOSIT ${pool.asset} berhasil dicatat ke database!`,
        );
      }
    }
  } catch (err) {
    console.error(
      `Gagal memproses event EarnPositionCreated ${pool.name}:`,
      err.message,
    );
  }
};

const handleEarnClaimedEvent = async ({ event, pool }) => {
  const { user, positionId, principal, reward } = event.args;
  const txHash = event.transactionHash;
  const blockNumber = event.blockNumber;

  try {
    const userWallet = await Wallet.findOne({
      where: { address: { [Op.iLike]: user } },
    });

    if (userWallet) {
      console.log(
        `💰 [Earn Claim] User ${userWallet.core_id} melakukan claim posisi #${positionId} (${pool.asset})! Hash: ${txHash}`,
      );

      const existingTx = await Transaction.findOne({
        where: { tx_hash: txHash },
      });

      if (!existingTx) {
        // Total payout adalah principal + reward
        const totalPayout = principal + reward;
        const formattedPayout = toTokens(totalPayout, 6);

        await Transaction.create({
          core_id: userWallet.core_id,
          tx_hash: txHash,
          type: "EARN_CLAIM",
          asset: pool.asset,
          amount: formattedPayout,
          tx_block_number: Number(blockNumber),
          status: "COMPLETED",
        });

        console.log(
          `💾 Transaksi EARN_CLAIM ${pool.asset} (Principal + Reward) berhasil dicatat ke database!`,
        );
      }
    }
  } catch (err) {
    console.error(
      `Gagal memproses event EarnPositionClaimed ${pool.name}:`,
      err.message,
    );
  }
};

const startEarnListener = async () => {
  console.log("📡 Memulai Earn Pool Contract Listener (Deposit & Claim)...");

  const earnPoolsToWatch = getEarnPoolsToWatch();

  // 1. Event saat posisi earn dibuat (createEarn)
  const positionCreatedEvent = prepareEvent({
    signature:
      "event EarnPositionCreated(address indexed user, uint256 indexed positionId, uint256 principal, uint64 maturityAt, uint16 aprBps)",
  });

  // 2. Event saat posisi earn di-claim (claim)
  const positionClaimedEvent = prepareEvent({
    signature:
      "event EarnPositionClaimed(address indexed user, uint256 indexed positionId, uint256 principal, uint256 reward)",
  });

  for (const pool of earnPoolsToWatch) {
    if (!pool.address) {
      console.warn(
        `⚠️ Alamat Earn Pool untuk ${pool.name} belum diset di .env! Dilewati.`,
      );
      continue;
    }

    const poolContract = getContract({
      client,
      chain: customSepolia,
      address: pool.address,
    });

    console.log(
      `-> Memantau Earn Pool ${pool.name} di alamat: ${pool.address}`,
    );

    // --- LISTENER 1: EarnPositionCreated (Deposit / Stake) ---
    watchContractEvents({
      contract: poolContract,
      events: [positionCreatedEvent],
      onEvents: async (events) => {
        for (const event of events) {
          await handleEarnCreatedEvent({ event, pool });
        }
      },
    });

    // --- LISTENER 2: EarnPositionClaimed (Claim / Unstake) ---
    watchContractEvents({
      contract: poolContract,
      events: [positionClaimedEvent],
      onEvents: async (events) => {
        for (const event of events) {
          await handleEarnClaimedEvent({ event, pool });
        }
      },
    });
  }
};

module.exports = {
  startEarnListener,
  getEarnPoolsToWatch,
  handleEarnCreatedEvent,
  handleEarnClaimedEvent,
};
