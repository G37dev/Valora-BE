const { Worker } = require("bullmq");

const { EarnPosition, Wallet } = require("../models");
const Redis = require("ioredis");
const {
  getAssetTokenAddress,
  getUserSmartAccount,
  getRouterAddress,
  getEarnPoolAddress,
  getPoolRouterAddress,
  readPoolPosition,
  getTokenDecimals,
  client,
} = require("../services/earn/earn.blockchain.service");

const pushService = require("../services/pushService");

const {
  claimEarnTransaction,
} = require("../services/earn/earn.transaction.service");

const {
  parseEarnPositionClaimed,
} = require("../services/earn/earn.event.service");

const { EARN_STATUS } = require("../services/earn/earn.constants");

const { waitForReceipt } = require("thirdweb");

const { sepolia } = require("../utils/chain");

const connection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
const earnClaimWorker = new Worker(
  "earn-claim",

  async (job) => {
    const { positionId, coreId } = job.data;

    console.log("\n========================================");
    console.log("[Earn Claim Worker] JOB START");
    console.log("[Earn Claim Worker] jobId:", job.id);
    console.log("[Earn Claim Worker] positionId:", positionId);
    console.log("[Earn Claim Worker] coreId:", coreId);
    console.log("========================================");

    let position = null;

    try {
      // =====================================================
      // 1. GET POSITION
      // =====================================================

      position = await EarnPosition.findOne({
        where: {
          id: positionId,
          coreId,
        },
      });

      if (!position) {
        throw new Error(
          `EarnPosition tidak ditemukan. id=${positionId}, coreId=${coreId}`,
        );
      }

      console.log("[Earn Claim Worker] Position:", {
        id: position.id,
        coreId: position.coreId,
        asset: position.asset,
        principal: position.principal,
        positionId: position.positionId,
        status: position.status,
        maturityAt: position.maturityAt,
        txHash: position.txHash,
      });

      // =====================================================
      // 2. STATUS CHECK
      // =====================================================

      if (position.status === EARN_STATUS.CLAIMED) {
        console.log("[Earn Claim Worker] Position sudah CLAIMED. Skip.");

        return {
          success: true,
          skipped: true,
          positionId: position.id,
          status: EARN_STATUS.CLAIMED,
        };
      }

      if (position.status !== EARN_STATUS.ACTIVE) {
        throw new Error(
          `Position belum bisa di-claim. Status=${position.status}`,
        );
      }

      // =====================================================
      // 3. POSITION ID CHECK
      // =====================================================

      if (!position.positionId) {
        throw new Error("Blockchain positionId belum tersedia.");
      }

      const blockchainPositionId = String(position.positionId);

      // =====================================================
      // 4. MATURITY CHECK
      // =====================================================

      if (!position.maturityAt) {
        throw new Error("maturityAt belum tersedia.");
      }

      const maturityAt = new Date(position.maturityAt);

      if (Number.isNaN(maturityAt.getTime())) {
        throw new Error(`maturityAt tidak valid: ${position.maturityAt}`);
      }

      const now = Date.now();

      if (now < maturityAt.getTime()) {
        throw new Error(
          `Earn belum maturity. maturityAt=${maturityAt.toISOString()}`,
        );
      }

      console.log("[Earn Claim Worker] Position sudah maturity.");

      // =====================================================
      // 5. ROUTER
      // =====================================================

      const routerAddress = getRouterAddress();

      console.log("[Earn Claim Worker] Router:", routerAddress);

      // =====================================================
      // 6. POOL
      // =====================================================

      const poolAddress = getEarnPoolAddress(position.asset);

      console.log("[Earn Claim Worker] Pool:", poolAddress);

      // =====================================================
      // 7. VERIFY POOL ROUTER
      // =====================================================

      const configuredRouter = await getPoolRouterAddress(poolAddress);

      console.log("[Earn Claim Worker] Router check:", {
        envRouter: routerAddress,
        poolRouter: configuredRouter,
      });

      if (
        !configuredRouter ||
        configuredRouter.toLowerCase() !== routerAddress.toLowerCase()
      ) {
        throw new Error(
          `Router mismatch. ENV=${routerAddress}, Pool=${configuredRouter}`,
        );
      }

      // =====================================================
      // 8. USER WALLET
      // =====================================================

      const wallet = await Wallet.findOne({
        where: {
          core_id: position.coreId,
        },
      });

      if (!wallet?.address) {
        throw new Error(
          `Smart Wallet untuk coreId ${position.coreId} tidak ditemukan.`,
        );
      }

      console.log("[Earn Claim Worker] User wallet:", wallet.address);

      // =====================================================
      // 9. SMART ACCOUNT
      // =====================================================

      console.log("[Earn Claim Worker] Membuat smart account...");

      const smartAccount = await getUserSmartAccount(wallet, position.coreId);

      if (!smartAccount?.address) {
        throw new Error("Smart Account tidak ditemukan.");
      }

      console.log("[Earn Claim Worker] Smart Account:", smartAccount.address);

      if (smartAccount.address.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error(
          `Smart Account mismatch. DB=${wallet.address}, Thirdweb=${smartAccount.address}`,
        );
      }

      // =====================================================
      // 10. TOKEN
      // =====================================================

      const tokenAddress = getAssetTokenAddress(position.asset);

      if (!tokenAddress) {
        throw new Error(
          `Token address untuk ${position.asset} tidak ditemukan.`,
        );
      }

      console.log("[Earn Claim Worker] Token:", tokenAddress);

      // =====================================================
      // 10.5 ON-CHAIN STATE CHECK (idempotent)
      //
      // Kalau posisi sudah CLAIMED on-chain (claim tx sukses tapi
      // worker crash sebelum update DB), cukup sinkronkan — jangan
      // kirim tx claim kedua yang pasti revert AlreadyClaimed.
      // =====================================================

      const onchainPos = await readPoolPosition(
        poolAddress,
        blockchainPositionId,
      );

      console.log("[Earn Claim Worker] On-chain position:", onchainPos);

      if (!onchainPos.exists) {
        throw new Error(`Position ${blockchainPositionId} tidak ada on-chain.`);
      }

      if (onchainPos.owner.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error(
          `On-chain owner mismatch. OnChain=${onchainPos.owner}, DB=${wallet.address}`,
        );
      }

      if (onchainPos.status === 1) {
        console.log(
          "[Earn Claim Worker] Sudah CLAIMED on-chain — sinkronisasi DB.",
        );

        await position.update({
          status: EARN_STATUS.CLAIMED,
          completedAt: new Date(),
        });

        return {
          success: true,
          onchainSynced: true,
          positionId: position.id,
          blockchainPositionId,
          status: EARN_STATUS.CLAIMED,
        };
      }

      // =====================================================
      // 11. CLAIMING
      // =====================================================

      await position.update({
        status: EARN_STATUS.CLAIMING,
      });

      console.log("[Earn Claim Worker] Status → CLAIMING");

      // =====================================================
      // 12. SEND CLAIM
      // =====================================================

      console.log("");
      console.log("[Earn Claim Worker] ================================");
      console.log("[Earn Claim Worker] MENGIRIM router.claim()");
      console.log("[Earn Claim Worker] ================================");

      console.log("[Earn Claim Worker] Params:", {
        router: routerAddress,
        pool: poolAddress,
        token: tokenAddress,
        positionId: blockchainPositionId,
        user: smartAccount.address,
      });

      const claimTxHash = await claimEarnTransaction({
        tokenAddress,
        positionId: blockchainPositionId,
        smartAccount,
      });

      console.log("[Earn Claim Worker] CLAIM TX:", claimTxHash);

      // =====================================================
      // 13. SAVE CLAIM TX
      // =====================================================

      await position.update({
        txHash: claimTxHash,
      });

      // =====================================================
      // 14. WAIT RECEIPT
      // =====================================================

      console.log("[Earn Claim Worker] Menunggu receipt...");

      const receipt = await waitForReceipt({
        client,
        chain: sepolia,
        transactionHash: claimTxHash,
      });

      if (!receipt) {
        throw new Error(`Receipt claim tidak ditemukan. tx=${claimTxHash}`);
      }

      console.log("[Earn Claim Worker] Receipt status:", receipt.status);

      // =====================================================
      // 15. CHECK RECEIPT
      // =====================================================

      if (receipt.status !== "success") {
        throw new Error(`Claim transaction gagal/reverted. tx=${claimTxHash}`);
      }

      // =====================================================
      // 16. PARSE CLAIM EVENT
      // =====================================================

      console.log("[Earn Claim Worker] Parsing EarnPositionClaimed...");

      const event = parseEarnPositionClaimed(receipt.logs, poolAddress);

      if (!event) {
        throw new Error(
          `Event EarnPositionClaimed tidak ditemukan. tx=${claimTxHash}`,
        );
      }

      console.log("[Earn Claim Worker] Claim event:", event);

      // =====================================================
      // 17. EVENT DATA
      // =====================================================

      const eventUser = event.args?.user;

      const eventPositionId = event.args?.positionId?.toString();

      const eventPrincipal = event.args?.principal?.toString();

      const eventReward = event.args?.reward?.toString();

      console.log("[Earn Claim Worker] Event data:", {
        user: eventUser,
        positionId: eventPositionId,
        principal: eventPrincipal,
        reward: eventReward,
      });

      // =====================================================
      // 18. VALIDATE USER
      // =====================================================

      if (!eventUser) {
        throw new Error("User dari event claim tidak ditemukan.");
      }

      if (eventUser.toLowerCase() !== smartAccount.address.toLowerCase()) {
        throw new Error(
          `Claim event user mismatch. Event=${eventUser}, Expected=${smartAccount.address}`,
        );
      }

      // =====================================================
      // 19. VALIDATE POSITION ID
      // =====================================================

      if (!eventPositionId) {
        throw new Error("positionId dari event claim tidak ditemukan.");
      }

      if (eventPositionId !== blockchainPositionId) {
        throw new Error(
          `Claim position mismatch. Event=${eventPositionId}, DB=${blockchainPositionId}`,
        );
      }

      // =====================================================
      // 20. VALIDATE PRINCIPAL
      // =====================================================

      if (eventPrincipal === undefined || eventPrincipal === null) {
        throw new Error("Principal dari claim event tidak ditemukan.");
      }

      // =====================================================
      // 21. VALIDATE REWARD
      // =====================================================

      if (eventReward === undefined || eventReward === null) {
        throw new Error("Reward dari claim event tidak ditemukan.");
      }

      const principal = BigInt(eventPrincipal);

      const reward = BigInt(eventReward);

      const totalPayout = principal + reward;

      console.log("[Earn Claim Worker] Payout:", {
        principal: principal.toString(),
        reward: reward.toString(),
        total: totalPayout.toString(),
      });

      // =====================================================
      // 22. UPDATE DATABASE
      // =====================================================

      await position.update({
        status: EARN_STATUS.CLAIMED,
        txHash: claimTxHash,
        completedAt: new Date(),
      });

      // =====================================================
      // 22.5 PUSH NOTIFICATION
      //
      // Fire-and-forget — gagal push tidak boleh menggagalkan
      // claim yang sudah sukses on-chain.
      // =====================================================

      try {
        const decimals = await getTokenDecimals(tokenAddress);

        const fmtToken = (raw) => {
          const value = Number(raw) / 10 ** decimals;

          return value.toLocaleString("en-US", {
            minimumFractionDigits: 0,
            maximumFractionDigits: decimals > 6 ? 6 : decimals,
          });
        };

        await pushService.sendPushToUser(position.coreId, {
          title: "Earn Claimed",
          body: `${fmtToken(totalPayout)} ${position.asset} has been sent to your wallet.`,
          data: {
            type: "earn",
            event: "earn_claimed",
            position_id: String(position.id),
            tx_hash: claimTxHash,
          },
        });
      } catch (pushError) {
        console.log(
          `[Earn Claim Worker] push gagal position ${position.id}:`,
          pushError.message,
        );
      }

      console.log("[Earn Claim Worker] DB updated:", {
        id: position.id,
        positionId: position.positionId,
        txHash: position.txHash,
        status: position.status,
      });

      // =====================================================
      // 23. SUCCESS
      // =====================================================

      console.log("");
      console.log("========================================");
      console.log("[Earn Claim Worker] JOB SUCCESS");
      console.log("========================================");
      console.log("[Earn Claim Worker] DB ID:", position.id);
      console.log(
        "[Earn Claim Worker] Blockchain Position ID:",
        blockchainPositionId,
      );
      console.log("[Earn Claim Worker] Principal:", principal.toString());
      console.log("[Earn Claim Worker] Reward:", reward.toString());
      console.log("[Earn Claim Worker] Total Payout:", totalPayout.toString());
      console.log("[Earn Claim Worker] TX:", claimTxHash);
      console.log("[Earn Claim Worker] Status: CLAIMED");
      console.log("========================================\n");

      return {
        success: true,

        positionId: position.id,

        blockchainPositionId: blockchainPositionId,

        txHash: claimTxHash,

        principal: principal.toString(),

        reward: reward.toString(),

        totalPayout: totalPayout.toString(),

        status: EARN_STATUS.CLAIMED,
      };
    } catch (error) {
      console.error("[Earn Claim Worker] ERROR:", error);

      // =====================================================
      // 24. RECOVERY STATUS
      // =====================================================

      if (position) {
        try {
          /**
           * Jangan ubah CLAIMED kembali menjadi FAILED.
           */
          if (position.status !== EARN_STATUS.CLAIMED) {
            await position.update({
              status: EARN_STATUS.FAILED,
              errorMessage: String(error?.message || error).slice(0, 2000),
              failedAt: new Date(),
            });

            console.log("[Earn Claim Worker] Position → FAILED:", position.id);
          }
        } catch (dbError) {
          console.error("[Earn Claim Worker] Gagal update FAILED:", dbError);
        }
      }

      throw error;
    }
  },

  {
    connection,

    concurrency: 1,
  },
);

// =========================================================
// COMPLETED
// =========================================================

earnClaimWorker.on("completed", (job, result) => {
  console.log(`[Earn Claim Worker] Job ${job.id} COMPLETED`, result);
});

// =========================================================
// FAILED
// =========================================================

earnClaimWorker.on("failed", (job, error) => {
  console.error(`[Earn Claim Worker] Job ${job?.id} FAILED:`, error);
});

// =========================================================
// ERROR
// =========================================================

earnClaimWorker.on("error", (error) => {
  console.error("[Earn Claim Worker] ERROR:", error);
});

console.log("[Earn Claim Worker] Worker aktif. Menunggu claim job...");

module.exports = earnClaimWorker;
