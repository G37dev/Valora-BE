const crypto = require("crypto");
const { earnClaimQueue } = require("../queues/earn-claim.queue");
const { EarnPosition } = require("../models");
const { earnQueue } = require("../queues/earn.queue");
const { createPendingEarn } = require("../services/earn/earn.service");
const { formatEarnError } = require("../utils/earn-error");
const { EARN_STATUS } = require("../services/earn/earn.constants");

const getUserEarnPositions = async (req, res) => {
  try {
    const coreId = req.user?.coreId;

    if (!coreId) {
      return res.status(400).json({
        success: false,
        message: "core_id wajib diisi.",
      });
    }

    const positions = await EarnPosition.findAll({
      where: {
        coreId,
      },
      order: [["created_at", "DESC"]],
    });

    // =========================================
    // SUMMARY
    // =========================================

    const activePositions = positions.filter((position) =>
      ["PENDING", "PROCESSING", "ACTIVE", "CLAIMING"].includes(position.status),
    );

    const finishedPositions = positions.filter((position) =>
      ["CLAIMED", "FINISHED"].includes(position.status),
    );

    // =========================================
    // FORMAT POSITION
    // =========================================

    const formattedPositions = positions.map((position) => {
      const principal = Number(position.principal || 0);
      const aprBps = Number(position.aprBps || 0);
      const termCode = Number(position.termCode || 0);

      const estimatedReward = (principal * aprBps * termCode) / (365 * 10000);

      const maturityAt = position.maturityAt
        ? new Date(position.maturityAt)
        : null;

      const canClaim =
        position.status === "ACTIVE" &&
        maturityAt &&
        maturityAt.getTime() <= Date.now();

      return {
        id: position.id,

        core_id: position.coreId,

        position_id: position.positionId,

        asset: position.asset,

        principal: String(position.principal),

        apr_bps: aprBps,

        apr: aprBps / 100,

        term_code: termCode,

        status: position.status,

        tx_hash: position.txHash,

        created_at:
          position.createdAt ?? position.dataValues?.created_at ?? null,

        updated_at:
          position.updatedAt ?? position.dataValues?.updated_at ?? null,

        completed_at:
          position.completedAt ?? position.dataValues?.completed_at ?? null,

        maturity_at: position.maturityAt,

        estimated_reward: estimatedReward.toString(),

        total_payout: (principal + estimatedReward).toString(),

        can_claim: Boolean(canClaim),
      };
    });

    // =========================================
    // RESPONSE
    // =========================================

    return res.status(200).json({
      success: true,

      summary: {
        active: activePositions.length,
        finished: finishedPositions.length,
        total: positions.length,
      },

      data: formattedPositions,
    });
  } catch (error) {
    console.error("[Earn] get positions error:", error);

    return res.status(500).json({
      success: false,
      message: formatEarnError(error),
    });
  }
};

/**
 * CREATE EARN
 */
const recordEarnPosition = async (req, res) => {
  try {
    const { asset, amount, principal, term_code, idempotency_key } = req.body;

    const core_id = req.user?.coreId;

    if (!core_id) {
      return res.status(400).json({
        success: false,
        message: "core_id wajib diisi.",
      });
    }

    const inputAmount =
      amount !== undefined && amount !== null ? amount : principal;

    if (
      inputAmount === undefined ||
      inputAmount === null ||
      String(inputAmount).trim() === ""
    ) {
      return res.status(400).json({
        success: false,
        message: "amount wajib diisi.",
      });
    }

    /**
     * Client boleh kirim idempotency_key (retry/double-tap safe).
     * Kalau tidak dikirim, generate baru = setiap request transaksi baru.
     */
    const idempotencyKey = idempotency_key || crypto.randomUUID();

    console.log("[Earn] Creating:", {
      coreId: core_id,
      asset,
      amount: inputAmount,
      termCode: term_code,
      idempotencyKey,
    });

    /**
     * CREATE PENDING POSITION
     */
    const result = await createPendingEarn({
      coreId: core_id,
      asset,
      amount: inputAmount,
      termCode: term_code,
      idempotencyKey,
    });

    /**
     * Kalau service menemukan key yang sama.
     */
    if (result.isExisting) {
      const position = result.position;

      /**
       * Posisi FAILED/PENDING tetap bisa di-retry pakai key yang sama —
       * antre ulang dengan jobId unik. JobId lama tidak dipakai lagi
       * supaya tidak ketahan dedupe BullMQ. PROCESSING sengaja diskip:
       * job in-flight bisa race double-create; crash recovery-nya
       * sudah di-handle retry BullMQ.
       */
      if ([EARN_STATUS.PENDING, EARN_STATUS.FAILED].includes(position.status)) {
        await earnQueue.add(
          "process-earn",
          { positionId: position.id },
          { jobId: `earn-${position.id}-${Date.now()}` },
        );
      }

      return res.status(200).json({
        success: true,
        message: "Earn sudah pernah dibuat.",
        data: {
          id: position.id,
          core_id: position.coreId,
          asset: position.asset,
          amount: position.principal,
          position_id: position.positionId,
          term_code: position.termCode,
          status: position.status,
          tx_hash: position.txHash,
        },
      });
    }

    /**
     * MASUK BULLMQ
     */
    const job = await earnQueue.add(
      "process-earn",
      {
        positionId: result.position.id,
      },
      {
        jobId: `earn-${result.position.id}`,
      },
    );

    console.log("[Earn] Job queued:", {
      jobId: job.id,
      positionId: result.position.id,
    });

    /**
     * RESPONSE
     */
    return res.status(202).json({
      success: true,
      message: "Earn sedang diproses.",
      data: {
        id: result.position.id,
        core_id,
        asset: result.position.asset,
        amount: result.position.principal,
        position_id: result.position.positionId,
        term_code: result.position.termCode,
        status: result.position.status,
      },
    });
  } catch (error) {
    console.error("[Earn] create error:", error);

    return res.status(400).json({
      success: false,
      message: formatEarnError(error),
    });
  }
};

/**
 * CLAIM EARN
 */
const claimEarnPosition = async (req, res) => {
  try {
    const { position_id } = req.params;
    const core_id = req.user?.coreId;

    if (!position_id) {
      return res.status(400).json({
        success: false,
        message: "position_id wajib diisi.",
      });
    }

    if (!core_id) {
      return res.status(400).json({
        success: false,
        message: "core_id wajib diisi.",
      });
    }

    const position = await EarnPosition.findOne({
      where: {
        id: position_id,
        coreId: core_id,
      },
    });

    if (!position) {
      return res.status(404).json({
        success: false,
        message: "Earn position tidak ditemukan.",
      });
    }

    if (position.status === "CLAIMED") {
      return res.status(200).json({
        success: true,
        message: "Earn sudah di-claim.",
        data: {
          id: position.id,
          core_id: position.coreId,
          position_id: position.positionId,
          status: position.status,
          tx_hash: position.txHash,
        },
      });
    }

    /**
     * Gate status: hanya ACTIVE/CLAIMING/FAILED yang boleh di-claim.
     * CLAIMING = job sebelumnya crash -> reset ke ACTIVE.
     * FAILED   = claim sebelumnya gagal -> reset ke ACTIVE (retry aman
     *            karena worker cek state on-chain dulu).
     * PENDING/PROCESSING -> belum ada posisi on-chain.
     */
    const CLAIMABLE_STATUSES = [
      EARN_STATUS.ACTIVE,
      EARN_STATUS.CLAIMING,
      EARN_STATUS.FAILED,
    ];

    if (!CLAIMABLE_STATUSES.includes(position.status)) {
      return res.status(400).json({
        success: false,
        message: `Earn position belum bisa di-claim (status: ${position.status}).`,
      });
    }

    if (!position.positionId) {
      return res.status(400).json({
        success: false,
        message: "Blockchain position_id belum tersedia.",
      });
    }

    if (!position.maturityAt) {
      return res.status(400).json({
        success: false,
        message: "Maturity position belum tersedia.",
      });
    }

    const maturityAt = new Date(position.maturityAt);

    if (Number.isNaN(maturityAt.getTime())) {
      return res.status(400).json({
        success: false,
        message: "maturity_at tidak valid.",
      });
    }

    if (Date.now() < maturityAt.getTime()) {
      return res.status(400).json({
        success: false,
        message: "Earn belum mencapai maturity.",
        data: {
          maturity_at: position.maturityAt,
        },
      });
    }

    // Recovery setelah semua validasi lolos — CLAIMING/FAILED -> ACTIVE
    if (position.status !== EARN_STATUS.ACTIVE) {
      try {
        await position.update({ status: EARN_STATUS.ACTIVE });
      } catch (dbError) {
        console.error("[Earn Claim] Gagal recovery status:", dbError);
      }
    }

    // =====================================================
    // JOB ID
    // =====================================================

    const jobId = `claim-${position.id}`;

    // =====================================================
    // ADD QUEUE
    // =====================================================

    const job = await earnClaimQueue.add(
      "process-claim",
      {
        positionId: position.id,

        coreId: position.coreId,
      },
      {
        jobId,

        removeOnComplete: true,

        /**
         * Failed job dihapus supaya retry berikutnya (jobId sama)
         * benar-benar membuat job baru — kalau dibiarkan, BullMQ
         * mengembalikan job gagal lama dan claim tidak pernah jalan.
         */
        removeOnFail: true,
      },
    );

    console.log("[Earn Claim] Job queued:", {
      jobId: job.id,
      positionId: position.id,
    });

    // =====================================================
    // RESPONSE
    // =====================================================

    return res.status(202).json({
      success: true,

      message: "Claim sedang diproses.",

      data: {
        id: position.id,

        core_id: position.coreId,

        position_id: position.positionId,

        status: position.status,

        maturity_at: position.maturityAt,

        job_id: job.id,
      },
    });
  } catch (error) {
    console.error("[Earn] claim error:", error);

    return res.status(400).json({
      success: false,
      message: formatEarnError(error),
    });
  }
};

module.exports = {
  getUserEarnPositions,
  recordEarnPosition,
  claimEarnPosition,
};
