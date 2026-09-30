const { Worker } = require("bullmq");

const { EarnPosition, Wallet } = require("../models");

const {
  getAssetTokenAddress,
  getUserSmartAccount,
  getRouterAddress,
  getEarnPoolAddress,
  getPoolRouterAddress,
  client,
} = require("../services/earn/earn.blockchain.service");

const {
  ensureTokenAllowance,
  createEarnTransaction,
} = require("../services/earn/earn.transaction.service");

const {
  parseEarnPositionCreated,
} = require("../services/earn/earn.event.service");

const { sepolia } = require("thirdweb/chains");
const { waitForReceipt } = require("thirdweb");

const { EARN_STATUS } = require("../services/earn/earn.constants");

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT || 6379),
};

// =========================================================
// HELPER
// =========================================================

const failPosition = async (position, error) => {
  try {
    if (position) {
      await position.update({
        status: EARN_STATUS.FAILED,
      });
    }
  } catch (dbError) {
    console.error("[Earn Worker] Gagal update status FAILED:", dbError);
  }

  throw error;
};

// =========================================================
// WORKER
// =========================================================

const earnWorker = new Worker(
  "earn",

  async (job) => {
    const { positionId } = job.data;

    console.log("\n========================================");
    console.log("[Earn Worker] JOB START");
    console.log("[Earn Worker] jobId:", job.id);
    console.log("[Earn Worker] positionId:", positionId);
    console.log("========================================");

    let position = null;

    try {
      // =====================================================
      // 1. GET DATABASE POSITION
      // =====================================================

      position = await EarnPosition.findByPk(positionId);

      if (!position) {
        throw new Error(`EarnPosition ${positionId} tidak ditemukan.`);
      }

      console.log("[Earn Worker] Position:", {
        id: position.id,
        coreId: position.coreId,
        asset: position.asset,
        principal: position.principal,
        termCode: position.termCode,
        status: position.status,
        positionId: position.positionId,
        txHash: position.txHash,
      });

      // =====================================================
      // 2. IDEMPOTENCY / DUPLICATE PROTECTION
      // =====================================================

      if (position.status !== EARN_STATUS.PENDING) {
        console.log(
          `[Earn Worker] Position ${position.id} bukan PENDING. Skip.`,
        );

        return {
          success: true,
          skipped: true,
          positionId: position.id,
          status: position.status,
          txHash: position.txHash,
        };
      }

      // =====================================================
      // 3. VALIDATE DATABASE DATA
      // =====================================================

      if (!position.coreId) {
        throw new Error(
          `coreId tidak ditemukan untuk position ${position.id}.`,
        );
      }

      if (!position.asset) {
        throw new Error(`Asset tidak ditemukan untuk position ${position.id}.`);
      }

      if (!position.principal) {
        throw new Error(
          `Principal tidak ditemukan untuk position ${position.id}.`,
        );
      }

      if (!position.termCode) {
        throw new Error(
          `termCode tidak ditemukan untuk position ${position.id}.`,
        );
      }

      const amount = BigInt(position.principal);

      if (amount <= 0n) {
        throw new Error(`Principal tidak valid: ${position.principal}`);
      }

      const termCode = Number(position.termCode);

      if (!Number.isInteger(termCode) || termCode < 1 || termCode > 255) {
        throw new Error(`termCode tidak valid: ${position.termCode}`);
      }

      console.log("[Earn Worker] Validated:", {
        amount: amount.toString(),
        termCode,
      });

      // =====================================================
      // 4. GET ROUTER
      // =====================================================

      const routerAddress = getRouterAddress();

      console.log("[Earn Worker] Router:", routerAddress);

      // =====================================================
      // 5. GET POOL
      // =====================================================

      const poolAddress = getEarnPoolAddress(position.asset);

      console.log("[Earn Worker] Pool:", poolAddress);

      // =====================================================
      // 6. VERIFY POOL ROUTER
      // =====================================================

      const configuredRouter = await getPoolRouterAddress(poolAddress);

      console.log("[Earn Worker] Router check:", {
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

      console.log("[Earn Worker] Router cocok dengan Pool.");

      // =====================================================
      // 7. GET USER WALLET
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

      console.log("[Earn Worker] User wallet:", wallet.address);

      // =====================================================
      // 8. GET TOKEN
      // =====================================================

      const tokenAddress = getAssetTokenAddress(position.asset);

      if (!tokenAddress) {
        throw new Error(
          `Token address untuk ${position.asset} tidak ditemukan.`,
        );
      }

      console.log("[Earn Worker] Token:", tokenAddress);

      // =====================================================
      // 9. GET SMART ACCOUNT
      // =====================================================

      console.log("[Earn Worker] Membuat smart account...");

      const smartAccount = await getUserSmartAccount(wallet, position.coreId);

      if (!smartAccount?.address) {
        throw new Error("Smart Account tidak berhasil dibuat.");
      }

      console.log("[Earn Worker] Smart Account:", smartAccount.address);

      if (smartAccount.address.toLowerCase() !== wallet.address.toLowerCase()) {
        throw new Error(
          `Smart Account mismatch. DB=${wallet.address}, Thirdweb=${smartAccount.address}`,
        );
      }

      // =====================================================
      // 10. CHECK TOKEN ALLOWANCE
      // =====================================================

      console.log("[Earn Worker] Checking allowance...");

      const allowanceResult = await ensureTokenAllowance({
        tokenAddress,
        asset: position.asset,
        owner: smartAccount.address,
        amount,
        smartAccount,
      });

      console.log("[Earn Worker] Allowance result:", {
        approved: allowanceResult.approved,
        allowance: allowanceResult.allowance.toString(),
        txHash: allowanceResult.txHash,
      });

      // =====================================================
      // 11. CREATE EARN
      // =====================================================

      console.log("");
      console.log("[Earn Worker] ================================");
      console.log("[Earn Worker] MENGIRIM createEarn()");
      console.log("[Earn Worker] ================================");

      console.log("[Earn Worker] Params:", {
        router: routerAddress,
        pool: poolAddress,
        token: tokenAddress,
        amount: amount.toString(),
        termCode,
        user: smartAccount.address,
      });

      const txHash = await createEarnTransaction({
        tokenAddress,
        amount,
        termCode,
        smartAccount,
      });

      if (!txHash) {
        throw new Error("createEarn tidak menghasilkan transaction hash.");
      }

      console.log("[Earn Worker] CREATE EARN TX:", txHash);

      // =====================================================
      // 12. UPDATE PROCESSING
      // =====================================================

      await position.update({
        txHash,
        status: EARN_STATUS.PROCESSING,
      });

      console.log("[Earn Worker] DB updated:", {
        positionId: position.id,
        txHash,
        status: EARN_STATUS.PROCESSING,
      });

      // =====================================================
      // 13. WAIT RECEIPT
      // =====================================================

      console.log("[Earn Worker] Menunggu transaction receipt...");

      const receipt = await waitForReceipt({
        client,
        chain: sepolia,
        transactionHash: txHash,
      });

      if (!receipt) {
        throw new Error(`Receipt tidak ditemukan. tx=${txHash}`);
      }

      console.log("[Earn Worker] Receipt status:", receipt.status);

      // =====================================================
      // 14. CHECK RECEIPT
      // =====================================================

      if (receipt.status !== "success") {
        throw new Error(`createEarn transaction gagal/reverted. tx=${txHash}`);
      }

      // =====================================================
      // 15. PARSE EVENT
      // =====================================================

      console.log("[Earn Worker] Parsing EarnPositionCreated...");

      const event = parseEarnPositionCreated(receipt.logs, poolAddress);

      if (!event) {
        throw new Error(
          `Event EarnPositionCreated tidak ditemukan. tx=${txHash}`,
        );
      }

      console.log("[Earn Worker] Event:", event);

      // =====================================================
      // 16. READ EVENT DATA
      // =====================================================

      const onChainPositionId = event.args?.positionId?.toString();

      const eventUser = event.args?.user;

      const eventPrincipal = event.args?.principal?.toString();

      const maturityAt = event.args?.maturityAt?.toString();

      const aprBps = event.args?.aprBps?.toString();

      // =====================================================
      // 17. VALIDATE EVENT
      // =====================================================

      if (!onChainPositionId) {
        throw new Error(`positionId blockchain tidak ditemukan. tx=${txHash}`);
      }

      if (!eventUser) {
        throw new Error(`user dari event tidak ditemukan. tx=${txHash}`);
      }

      if (eventUser.toLowerCase() !== smartAccount.address.toLowerCase()) {
        throw new Error(
          `Event user mismatch. Event=${eventUser}, Expected=${smartAccount.address}`,
        );
      }

      if (eventPrincipal === undefined || eventPrincipal === null) {
        throw new Error(`principal dari event tidak ditemukan. tx=${txHash}`);
      }

      if (maturityAt === undefined || maturityAt === null) {
        throw new Error(`maturityAt dari event tidak ditemukan. tx=${txHash}`);
      }

      if (aprBps === undefined || aprBps === null) {
        throw new Error(`aprBps dari event tidak ditemukan. tx=${txHash}`);
      }

      // =====================================================
      // 18. VERIFY PRINCIPAL
      // =====================================================

      const eventPrincipalBigInt = BigInt(eventPrincipal);

      console.log("[Earn Worker] Principal comparison:", {
        database: amount.toString(),
        blockchain: eventPrincipalBigInt.toString(),
      });

      /**
       * CATATAN:
       *
       * Jika platformFeeBps = 0:
       *
       * database principal == blockchain principal
       *
       * Jika platformFeeBps > 0:
       *
       * database amount:
       *     amount sebelum fee
       *
       * blockchain principal:
       *     amount setelah fee
       *
       * Jadi jangan langsung throw mismatch kalau fee
       * memang digunakan.
       */

      const platformFeeBps = Number(process.env.EARN_PLATFORM_FEE_BPS || 0);

      if (platformFeeBps === 0) {
        if (eventPrincipalBigInt !== amount) {
          throw new Error(
            `Principal mismatch. DB=${amount.toString()}, Blockchain=${eventPrincipalBigInt.toString()}`,
          );
        }
      }

      // =====================================================
      // 19. VALIDATE MATURITY
      // =====================================================

      const maturityTimestamp = Number(maturityAt);

      if (!Number.isSafeInteger(maturityTimestamp) || maturityTimestamp <= 0) {
        throw new Error(`maturityAt tidak valid: ${maturityAt}`);
      }

      const maturityDate = new Date(maturityTimestamp * 1000);

      if (Number.isNaN(maturityDate.getTime())) {
        throw new Error(`Gagal convert maturityAt: ${maturityAt}`);
      }

      // =====================================================
      // 20. VALIDATE APR
      // =====================================================

      const parsedAprBps = Number(aprBps);

      if (
        !Number.isSafeInteger(parsedAprBps) ||
        parsedAprBps < 0 ||
        parsedAprBps > 65535
      ) {
        throw new Error(`aprBps tidak valid: ${aprBps}`);
      }

      // =====================================================
      // 21. UPDATE DATABASE
      // =====================================================

      const updateData = {
        positionId: onChainPositionId,
        txHash,
        status: EARN_STATUS.ACTIVE,
        aprBps: parsedAprBps,
        maturityAt: maturityDate,
      };

      /**
       * Kalau principal DB memang harus merepresentasikan
       * principal aktual setelah platform fee, maka lebih
       * baik update principal berdasarkan event.
       *
       * Tapi lakukan hanya kalau desain DB kamu memang
       * menginginkan principal = net principal.
       */

      if (platformFeeBps > 0) {
        updateData.principal = eventPrincipalBigInt.toString();
      }

      await position.update(updateData);

      // =====================================================
      // 22. FINAL LOG
      // =====================================================

      console.log("[Earn Worker] DB FINAL UPDATED:", {
        id: position.id,
        coreId: position.coreId,
        asset: position.asset,
        positionId: position.positionId,
        txHash: position.txHash,
        principal: position.principal,
        status: position.status,
        aprBps: position.aprBps,
        maturityAt: position.maturityAt,
      });

      // =====================================================
      // 23. SUCCESS
      // =====================================================

      console.log("");
      console.log("========================================");
      console.log("[Earn Worker] JOB SUCCESS");
      console.log("========================================");
      console.log("[Earn Worker] DB ID:", position.id);
      console.log("[Earn Worker] Blockchain Position ID:", onChainPositionId);
      console.log("[Earn Worker] TX:", txHash);
      console.log("[Earn Worker] Status: ACTIVE");
      console.log("========================================\n");

      return {
        success: true,
        positionId: position.id,
        blockchainPositionId: onChainPositionId,
        txHash,
        status: EARN_STATUS.ACTIVE,
      };
    } catch (error) {
      console.error("[Earn Worker] JOB ERROR:", error);

      // =====================================================
      // 24. MARK FAILED
      // =====================================================

      if (position) {
        try {
          await position.update({
            status: EARN_STATUS.FAILED,
          });

          console.log("[Earn Worker] Position marked FAILED:", position.id);
        } catch (dbError) {
          console.error("[Earn Worker] Gagal update FAILED:", dbError);
        }
      }

      throw error;
    }
  },

  {
    connection,

    /**
     * Untuk transaksi blockchain user,
     * concurrency 1 lebih aman sementara.
     *
     * Nanti bisa dinaikkan setelah mekanisme
     * locking/idempotency diperkuat.
     */
    concurrency: 1,

    /**
     * BullMQ akan retry jika job gagal.
     *
     * HATI-HATI:
     * Jika transaksi blockchain sudah berhasil tetapi
     * worker crash sebelum DB ACTIVE, retry tidak boleh
     * membuat createEarn kedua.
     *
     * Karena itu idealnya recovery berdasarkan txHash.
     */
  },
);

// =========================================================
// COMPLETED
// =========================================================

earnWorker.on("completed", (job, result) => {
  console.log(`[Earn Worker] Job ${job.id} COMPLETED`, result);
});

// =========================================================
// FAILED
// =========================================================

earnWorker.on("failed", (job, error) => {
  console.error(`[Earn Worker] Job ${job?.id} FAILED:`, error);
});

// =========================================================
// ERROR
// =========================================================

earnWorker.on("error", (error) => {
  console.error("[Earn Worker] ERROR:", error);
});

// =========================================================
// READY
// =========================================================

console.log("[Earn Worker] Worker aktif. Menunggu job...");

module.exports = earnWorker;
