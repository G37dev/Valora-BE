const { KycProfile, User } = require("../models");
const veriffService = require("../services/veriffService");
const diditService = require("../services/diditService");
const sumsubService = require("../services/sumsubService");

// @desc    Get data KYC berdasarkan coreId
// @route   GET /api/kyc/:coreId
exports.getKyc = async (req, res) => {
  try {
    const { coreId } = req.params;

    // Cari data KYC di database
    let kyc = await KycProfile.findOne({
      where: { core_id: coreId },
    });

    if (!kyc && sumsubService.isConfigured()) {
      /*
       * Self-heal tanpa webhook: belum ada record tapi user mungkin
       * sudah punya applicant Sumsub (mis. selesai SDK flow sebelum
       * webhook ke-set). Ambil status-nya; kalau sudah lewat 'init'
       * (beneran submit) → buat record.
       */
      try {
        const applicant = await sumsubService.getApplicantByExternalId(coreId);
        if (applicant?.id) {
          const st = await sumsubService.getApplicantStatus(applicant.id);
          const newStatus = sumsubService.mapStatusToLocal({
            reviewStatus: st?.reviewStatus,
            reviewAnswer: st?.reviewResult?.reviewAnswer,
          });
          if (newStatus && st?.reviewStatus !== "init") {
            kyc = await KycProfile.create({
              core_id: coreId,
              status: newStatus,
              provider_id: "sumsub",
              provider_reference: applicant.id,
              verification_source: "sumsub",
              verified_at: newStatus === "VERIFIED" ? new Date() : null,
              metadata: {
                lastDecision:
                  st?.reviewResult?.reviewAnswer || st?.reviewStatus,
                syncedAt: new Date().toISOString(),
              },
            });
          }
        }
      } catch (lookupErr) {
        console.warn("[Sumsub] Lookup applicant gagal:", lookupErr.message);
      }
    }

    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "Data KYC tidak ditemukan untuk user ini.",
      });
    }

    /*
     * Auto-sync: kalau masih PENDING dan punya session Veriff,
     * tanya decision terbaru langsung ke Veriff API. Cadangan
     * kalau webhook belum dikonfigurasi / terlambat.
     */
    if (
      kyc.status === "PENDING" &&
      kyc.provider_id === "veriff" &&
      kyc.provider_reference &&
      veriffService.isConfigured()
    ) {
      try {
        const decision = await veriffService.getDecision(
          kyc.provider_reference,
        );
        const newStatus = veriffService.mapDecisionToStatus(
          decision?.status || decision?.decision || decision,
        );
        if (newStatus && newStatus !== "PENDING") {
          await kyc.update({
            status: newStatus,
            verified_at:
              newStatus === "VERIFIED" ? new Date() : kyc.verified_at,
            metadata: {
              ...(kyc.metadata || {}),
              lastDecision: decision?.status || decision?.decision,
              syncedAt: new Date().toISOString(),
            },
          });
          kyc = await KycProfile.findOne({ where: { core_id: coreId } });
        }
      } catch (syncErr) {
        console.warn("[Veriff] Sync decision gagal:", syncErr.message);
      }
    }

    /*
     * Auto-sync Didit — sama seperti Veriff di atas, tapi pakai
     * GET /v3/session/{id}/decision/ dan status envelope Didit.
     */
    if (
      kyc.status === "PENDING" &&
      kyc.provider_id === "didit" &&
      kyc.provider_reference &&
      diditService.isConfigured()
    ) {
      try {
        const decision = await diditService.getDecision(kyc.provider_reference);
        const status = decision?.status || decision?.session?.status;
        const newStatus = diditService.mapStatusToLocal(status);
        if (newStatus && newStatus !== "PENDING") {
          await kyc.update({
            status: newStatus,
            verified_at:
              newStatus === "VERIFIED" ? new Date() : kyc.verified_at,
            metadata: {
              ...(kyc.metadata || {}),
              lastDecision: status,
              syncedAt: new Date().toISOString(),
            },
          });
          kyc = await KycProfile.findOne({ where: { core_id: coreId } });
        }
      } catch (syncErr) {
        console.warn("[Didit] Sync decision gagal:", syncErr.message);
      }
    }

    /*
     * Self-heal #2: record ada tapi provider lain (didit/veriff) atau
     * status stale — cek applicant Sumsub by externalUserId. Kalau
     * applicant sudah lewat 'init', pindahkan provider + update status.
     */
    if (
      kyc &&
      kyc.status !== "VERIFIED" &&
      (kyc.provider_id !== "sumsub" || !kyc.provider_reference) &&
      sumsubService.isConfigured()
    ) {
      try {
        const applicant = await sumsubService.getApplicantByExternalId(coreId);
        if (applicant?.id) {
          const st = await sumsubService.getApplicantStatus(applicant.id);
          const newStatus = sumsubService.mapStatusToLocal({
            reviewStatus: st?.reviewStatus,
            reviewAnswer: st?.reviewResult?.reviewAnswer,
          });
          if (newStatus && st?.reviewStatus !== "init") {
            await kyc.update({
              status: newStatus,
              provider_id: "sumsub",
              provider_reference: applicant.id,
              verification_source: "sumsub",
              verified_at:
                newStatus === "VERIFIED" ? new Date() : kyc.verified_at,
              metadata: {
                ...(kyc.metadata || {}),
                lastDecision:
                  st?.reviewResult?.reviewAnswer || st?.reviewStatus,
                syncedAt: new Date().toISOString(),
              },
            });
            kyc = await KycProfile.findOne({ where: { core_id: coreId } });
          }
        }
      } catch (lookupErr) {
        console.warn("[Sumsub] Lookup applicant gagal:", lookupErr.message);
      }
    }

    /*
     * Auto-sync Sumsub — GET /resources/applicants/{id}/status,
     * provider_reference menyimpan applicantId.
     */
    if (
      kyc.status !== "VERIFIED" &&
      kyc.provider_id === "sumsub" &&
      kyc.provider_reference &&
      sumsubService.isConfigured()
    ) {
      try {
        const st = await sumsubService.getApplicantStatus(
          kyc.provider_reference,
        );
        const newStatus = sumsubService.mapStatusToLocal({
          reviewStatus: st?.reviewStatus,
          reviewAnswer: st?.reviewResult?.reviewAnswer,
        });
        if (newStatus && newStatus !== kyc.status) {
          await kyc.update({
            status: newStatus,
            verified_at:
              newStatus === "VERIFIED" ? new Date() : kyc.verified_at,
            metadata: {
              ...(kyc.metadata || {}),
              lastDecision: st?.reviewResult?.reviewAnswer || st?.reviewStatus,
              syncedAt: new Date().toISOString(),
            },
          });
          kyc = await KycProfile.findOne({ where: { core_id: coreId } });
        }
      } catch (syncErr) {
        console.warn("[Sumsub] Sync status gagal:", syncErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      data: kyc,
    });
  } catch (error) {
    console.error("Error get KYC:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
      error: error.message,
    });
  }
};

// @desc    Submit atau update data KYC
// @route   POST /api/kyc/:coreId/submit
exports.submitKyc = async (req, res) => {
  try {
    const { coreId } = req.params;
    const { provider_id, provider_reference, metadata } = req.body;

    // 1. Cek apakah user murni (coreId) benar-benar ada di tabel User
    const user = await User.findOne({ where: { coreId } });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User tidak ditemukan",
      });
    }

    // 2. Cek apakah user sudah punya record KYC sebelumnya
    let kyc = await KycProfile.findOne({ where: { core_id: coreId } });

    if (kyc) {
      // Jika sudah VERIFIED atau PENDING, tolak request submit baru
      if (kyc.status === "VERIFIED") {
        return res.status(400).json({
          success: false,
          message: "KYC Anda sudah terverifikasi.",
        });
      }
      if (kyc.status === "PENDING") {
        return res.status(400).json({
          success: false,
          message: "KYC Anda sedang dalam proses verifikasi.",
        });
      }

      // Jika statusnya UNVERIFIED atau REJECTED, kita update datanya dan ubah jadi PENDING
      await kyc.update({
        status: "PENDING",
        provider_id: provider_id || kyc.provider_id,
        provider_reference: provider_reference || kyc.provider_reference,
        metadata: metadata || kyc.metadata,
      });
    } else {
      // 3. Jika belum pernah ada datanya sama sekali, buat baru dengan status PENDING
      kyc = await KycProfile.create({
        core_id: coreId,
        status: "PENDING",
        provider_id,
        provider_reference,
        metadata: metadata || {},
      });
    }

    return res.status(200).json({
      success: true,
      message: "Data KYC berhasil disubmit dan sedang diproses.",
      data: kyc,
    });
  } catch (error) {
    console.error("Error submit KYC:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server saat submit KYC",
      error: error.message,
    });
  }
};

// ============================================================================
// VERIFF — hosted identity verification
// ============================================================================

// @desc    Buat Veriff verification session → return hosted url
// @route   POST /api/kyc/veriff/session
exports.createVeriffSession = async (req, res) => {
  try {
    const coreId = req.user?.coreId;
    if (!coreId) {
      return res
        .status(401)
        .json({ success: false, message: "Token tidak valid." });
    }

    const user = await User.findOne({ where: { coreId } });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User tidak ditemukan." });
    }

    let kyc = await KycProfile.findOne({ where: { core_id: coreId } });
    if (kyc?.status === "VERIFIED") {
      return res.status(400).json({
        success: false,
        message: "KYC Anda sudah terverifikasi.",
      });
    }
    if (kyc?.status === "PENDING" && kyc.provider_id === "veriff") {
      return res.status(400).json({
        success: false,
        message:
          "Verifikasi Anda sedang diproses. Tunggu hasilnya terlebih dahulu.",
      });
    }

    const { documentCountry, documentType } = req.body || {};

    const session = await veriffService.createSession({
      coreId,
      firstName: user.firstName,
      lastName: user.lastName,
      documentCountry,
      documentType,
      callback: "valoramobile://kyc-screen",
    });

    const metadata = { sessionUrl: session.url, documentCountry, documentType };

    if (!kyc) {
      kyc = await KycProfile.create({
        core_id: coreId,
        status: "PENDING",
        provider_id: "veriff",
        provider_reference: session.id,
        verification_source: "veriff",
        metadata,
      });
    } else {
      await kyc.update({
        status: "PENDING",
        provider_id: "veriff",
        provider_reference: session.id,
        verification_source: "veriff",
        metadata,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        url: session.url,
        sessionId: session.id,
      },
    });
  } catch (error) {
    console.error("Error create Veriff session:", error);
    return res.status(500).json({
      success: false,
      message: "Gagal membuat sesi verifikasi.",
    });
  }
};

// @desc    Webhook decision dari Veriff (public — diverifikasi via signature)
// @route   POST /api/kyc/veriff/webhook
exports.veriffWebhook = async (req, res) => {
  try {
    const signature =
      req.headers["x-hmac-signature"] ||
      req.headers["X-HMAC-SIGNATURE".toLowerCase()];

    if (!veriffService.verifyWebhookSignature(req.rawBody || "", signature)) {
      console.warn("[Veriff] Webhook signature tidak valid — ditolak.");
      return res
        .status(401)
        .json({ success: false, message: "Signature tidak valid." });
    }

    const verification = req.body?.verification || req.body;
    const coreId = verification?.vendorData;
    const status = String(verification?.status || "").toLowerCase();
    const sessionId = verification?.id;

    if (!coreId) {
      return res
        .status(400)
        .json({ success: false, message: "vendorData tidak ada." });
    }

    const kyc = await KycProfile.findOne({ where: { core_id: coreId } });
    if (!kyc) {
      return res
        .status(404)
        .json({ success: false, message: "KYC tidak ditemukan." });
    }

    const statusMap = {
      approved: "VERIFIED",
      declined: "REJECTED",
      resubmission_requested: "PENDING",
      // expired/abandoned = sesi lapsed, bukan penolakan dokumen
      expired: "PENDING",
      abandoned: "PENDING",
    };
    const newStatus = statusMap[status];
    if (!newStatus) {
      // event non-decision (started/submitted) — cukup ack
      return res.status(200).json({ success: true, ignored: status });
    }

    /*
     * Profil VERIFIED hanya boleh berubah oleh decision terminal
     * (approved/declined) — event non-final tidak boleh downgrade.
     */
    if (
      kyc.status === "VERIFIED" &&
      newStatus !== "VERIFIED" &&
      newStatus !== "REJECTED"
    ) {
      console.log(
        `[Veriff] KYC ${coreId} VERIFIED — abaikan event non-final '${status}'.`,
      );
      return res.status(200).json({ success: true, ignored: status });
    }

    await kyc.update({
      status: newStatus,
      provider_reference: sessionId || kyc.provider_reference,
      verified_at: newStatus === "VERIFIED" ? new Date() : kyc.verified_at,
      metadata: {
        ...(kyc.metadata || {}),
        lastDecision: status,
        decidedAt: new Date().toISOString(),
      },
    });

    console.log(`[Veriff] KYC ${coreId} → ${newStatus}`);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error Veriff webhook:", error);
    return res.status(500).json({ success: false });
  }
};

// ============================================================================
// DIDIT — identity verification (workflow-based)
// ============================================================================

// @desc    Buat Didit verification session → return url + session_token
// @route   POST /api/kyc/didit/session
exports.createDiditSession = async (req, res) => {
  try {
    const coreId = req.user?.coreId;
    if (!coreId) {
      return res
        .status(401)
        .json({ success: false, message: "Token tidak valid." });
    }

    const user = await User.findOne({ where: { coreId } });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User tidak ditemukan." });
    }

    let kyc = await KycProfile.findOne({ where: { core_id: coreId } });
    if (kyc?.status === "VERIFIED") {
      return res.status(400).json({
        success: false,
        message: "KYC Anda sudah terverifikasi.",
      });
    }
    if (kyc?.status === "PENDING" && kyc.provider_id === "didit") {
      return res.status(400).json({
        success: false,
        message:
          "Verifikasi Anda sedang diproses. Tunggu hasilnya terlebih dahulu.",
      });
    }

    const session = await diditService.createSession({
      coreId,
      callback: "valoramobile://kyc-screen",
    });

    // KycProfile sengaja TIDAK ditulis di sini — user bisa saja buka
    // flow Didit lalu cancel. Record baru dibuat oleh webhook begitu
    // user benar-benar submit (status "In Review"/decision final).
    const sessionId = session.session_id || session.id;

    return res.status(200).json({
      success: true,
      data: {
        url: session.url,
        sessionId,
        sessionToken: session.session_token,
      },
    });
  } catch (error) {
    console.error(
      "Error create Didit session:",
      error?.response?.data || error,
    );
    return res.status(500).json({
      success: false,
      message: "Gagal membuat sesi verifikasi.",
    });
  }
};

// @desc    Webhook event dari Didit (public — diverifikasi via X-Signature)
// @route   POST /api/kyc/didit/webhook
exports.diditWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-signature"];

    if (!diditService.verifyWebhookSignature(req.rawBody || "", signature)) {
      console.warn("[Didit] Webhook signature tidak valid — ditolak.");
      return res
        .status(401)
        .json({ success: false, message: "Signature tidak valid." });
    }

    const payload = req.body || {};
    const coreId = payload.vendor_data;
    const status = payload.status;
    const sessionId = payload.session_id;

    if (!coreId) {
      return res
        .status(400)
        .json({ success: false, message: "vendor_data tidak ada." });
    }

    const newStatus = diditService.mapStatusToLocal(status);
    let kyc = await KycProfile.findOne({ where: { core_id: coreId } });

    if (!kyc) {
      /*
       * Belum ada record → sesi dibuka tapi user belum submit.
       * Baru catat kalau statusnya menandakan submission
       * ("In Review"/"Resubmitted") atau decision final.
       */
      const submitted =
        status === "In Review" ||
        status === "Resubmitted" ||
        newStatus === "VERIFIED" ||
        newStatus === "REJECTED";
      if (!submitted || !newStatus) {
        return res.status(200).json({ success: true, ignored: status });
      }

      const user = await User.findOne({ where: { coreId } });
      if (!user) {
        return res
          .status(404)
          .json({ success: false, message: "KYC tidak ditemukan." });
      }

      kyc = await KycProfile.create({
        core_id: coreId,
        status: newStatus,
        provider_id: "didit",
        provider_reference: sessionId,
        verification_source: "didit",
        verified_at: newStatus === "VERIFIED" ? new Date() : null,
        metadata: {
          lastDecision: status,
          decidedAt: new Date().toISOString(),
          webhookEventId: payload.event_id,
        },
      });

      console.log(`[Didit] KYC ${coreId} → ${newStatus} (${status}) [created]`);
      return res.status(200).json({ success: true });
    }

    if (!newStatus) {
      // event/status yang tidak kita proses — cukup ack
      return res.status(200).json({ success: true, ignored: status });
    }

    /*
     * Guard: profil yang sudah VERIFIED tidak boleh di-downgrade oleh
     * status non-final (Expired → PENDING, In Review, dst.). Hanya
     * decision terminal dari provider yang bisa mengubahnya —
     * Approved (re-verify) atau Declined (penolakan beneran).
     */
    if (
      kyc.status === "VERIFIED" &&
      newStatus !== "VERIFIED" &&
      newStatus !== "REJECTED"
    ) {
      console.log(
        `[Didit] KYC ${coreId} VERIFIED — abaikan event non-final '${status}'.`,
      );
      return res.status(200).json({ success: true, ignored: status });
    }

    await kyc.update({
      status: newStatus,
      provider_id: "didit",
      verification_source: "didit",
      provider_reference: sessionId || kyc.provider_reference,
      verified_at: newStatus === "VERIFIED" ? new Date() : kyc.verified_at,
      metadata: {
        ...(kyc.metadata || {}),
        lastDecision: status,
        decidedAt: new Date().toISOString(),
        webhookEventId: payload.event_id,
      },
    });

    console.log(`[Didit] KYC ${coreId} → ${newStatus} (${status})`);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error Didit webhook:", error);
    return res.status(500).json({ success: false });
  }
};

// ============================================================================
// SUMSUB — identity verification (level-based, applicant + accessToken)
// ============================================================================

// @desc    Buat Sumsub applicant + accessToken untuk launch mobile SDK
// @route   POST /api/kyc/sumsub/session
exports.createSumsubSession = async (req, res) => {
  try {
    const coreId = req.user?.coreId;
    if (!coreId) {
      return res
        .status(401)
        .json({ success: false, message: "Token tidak valid." });
    }

    const user = await User.findOne({ where: { coreId } });
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User tidak ditemukan." });
    }

    let kyc = await KycProfile.findOne({ where: { core_id: coreId } });
    if (kyc?.status === "VERIFIED") {
      return res.status(400).json({
        success: false,
        message: "KYC Anda sudah terverifikasi.",
      });
    }
    /*
     * PENDING + sumsub → JANGAN di-block: applicant pending bisa
     * di-resume pakai accessToken baru (beda dengan didit/veriff).
     * SDK lanjut dari step terakhir user.
     */

    const { levelName } = req.body || {};
    const { applicant, token } = await sumsubService.createAccessToken({
      coreId,
      levelName,
    });

    // KycProfile sengaja TIDAK ditulis di sini — user bisa saja buka
    // flow Sumsub lalu cancel. Record baru dibuat oleh webhook begitu
    // user benar-benar submit / ada decision.

    return res.status(200).json({
      success: true,
      data: {
        accessToken: token?.token,
        applicantId: applicant?.id,
        levelName: levelName || undefined,
      },
    });
  } catch (error) {
    console.error(
      "Error create Sumsub session:",
      error?.response?.data || error,
    );
    return res.status(500).json({
      success: false,
      message: "Gagal membuat sesi verifikasi.",
    });
  }
};

// @desc    Refresh Sumsub accessToken (dipanggil SDK saat token expired)
// @route   POST /api/kyc/sumsub/token/refresh
exports.refreshSumsubToken = async (req, res) => {
  try {
    const coreId = req.user?.coreId;
    if (!coreId) {
      return res
        .status(401)
        .json({ success: false, message: "Token tidak valid." });
    }

    const token = await sumsubService.refreshAccessToken({ coreId });
    return res
      .status(200)
      .json({ success: true, data: { accessToken: token?.token } });
  } catch (error) {
    console.error(
      "Error refresh Sumsub token:",
      error?.response?.data || error,
    );
    return res.status(500).json({
      success: false,
      message: "Gagal refresh token verifikasi.",
    });
  }
};

// @desc    Webhook event dari Sumsub (public — diverifikasi via X-Payload-Digest)
// @route   POST /api/kyc/sumsub/webhook
exports.sumsubWebhook = async (req, res) => {
  try {
    const digest = req.headers["x-payload-digest"];
    const alg = req.headers["x-payload-digest-alg"];

    if (!sumsubService.verifyWebhookSignature(req.rawBody || "", digest, alg)) {
      console.warn("[Sumsub] Webhook signature tidak valid — ditolak.");
      return res
        .status(401)
        .json({ success: false, message: "Signature tidak valid." });
    }

    const payload = req.body || {};
    const coreId = payload.externalUserId;
    const applicantId = payload.applicantId;
    const type = payload.type;

    if (!coreId) {
      return res
        .status(400)
        .json({ success: false, message: "externalUserId tidak ada." });
    }

    /*
     * Cuma proses event yang bawa status review. applicantReviewed →
     * decision final; applicantPending → user sudah submit (buat record
     * PENDING kalau belum ada); event lain cukup di-ack.
     */
    const reviewStatus =
      payload.reviewStatus || payload.reviewResult?.reviewStatus;
    const reviewAnswer = payload.reviewResult?.reviewAnswer;
    const newStatus = sumsubService.mapStatusToLocal({
      reviewStatus,
      reviewAnswer,
    });
    const submitted =
      type === "applicantPending" || type === "applicantReviewed";

    let kyc = await KycProfile.findOne({ where: { core_id: coreId } });

    if (!kyc) {
      if (!submitted || !newStatus) {
        return res.status(200).json({ success: true, ignored: type });
      }

      const user = await User.findOne({ where: { coreId } });
      if (!user) {
        return res
          .status(404)
          .json({ success: false, message: "KYC tidak ditemukan." });
      }

      kyc = await KycProfile.create({
        core_id: coreId,
        status: newStatus,
        provider_id: "sumsub",
        provider_reference: applicantId,
        verification_source: "sumsub",
        verified_at: newStatus === "VERIFIED" ? new Date() : null,
        metadata: {
          lastDecision: reviewAnswer || reviewStatus,
          decidedAt: new Date().toISOString(),
          webhookEventId: payload.correlationId,
        },
      });

      console.log(`[Sumsub] KYC ${coreId} → ${newStatus} (${type}) [created]`);
      return res.status(200).json({ success: true });
    }

    if (!newStatus) {
      return res.status(200).json({ success: true, ignored: type });
    }

    /*
     * Profil VERIFIED hanya boleh berubah oleh decision terminal
     * (GREEN/RED) — status review non-final (pending/queued/onHold)
     * tidak boleh downgrade.
     */
    if (
      kyc.status === "VERIFIED" &&
      newStatus !== "VERIFIED" &&
      newStatus !== "REJECTED"
    ) {
      console.log(
        `[Sumsub] KYC ${coreId} VERIFIED — abaikan event non-final '${type}'.`,
      );
      return res.status(200).json({ success: true, ignored: type });
    }

    await kyc.update({
      status: newStatus,
      provider_id: "sumsub",
      verification_source: "sumsub",
      provider_reference: applicantId || kyc.provider_reference,
      verified_at: newStatus === "VERIFIED" ? new Date() : kyc.verified_at,
      metadata: {
        ...(kyc.metadata || {}),
        lastDecision: reviewAnswer || reviewStatus,
        decidedAt: new Date().toISOString(),
        webhookEventId: payload.correlationId,
      },
    });

    console.log(`[Sumsub] KYC ${coreId} → ${newStatus} (${type})`);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Error Sumsub webhook:", error);
    return res.status(500).json({ success: false });
  }
};
