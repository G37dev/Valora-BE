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

if (!process.env.THIRDWEB_SECRET_KEY) {
  console.error(
    "❌ ERROR: THIRDWEB_SECRET_KEY tidak ditemukan untuk Earn Listener!",
  );
}

const client = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY,
});

const customSepolia = defineChain({
  id: 11155111,
  rpc:
    process.env.SEPOLIA_RPC_URL ||
    "https://ethereum-sepolia-rpc.publicnode.com",
});

const startEarnListener = async () => {
  console.log("📡 Memulai Earn Pool Contract Listener (Deposit & Claim)...");

  const earnPoolsToWatch = [
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
  ];

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
        }
      },
    });

    // --- LISTENER 2: EarnPositionClaimed (Claim / Unstake) ---
    watchContractEvents({
      contract: poolContract,
      events: [positionClaimedEvent],
      onEvents: async (events) => {
        for (const event of events) {
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
        }
      },
    });
  }
};

module.exports = { startEarnListener };
