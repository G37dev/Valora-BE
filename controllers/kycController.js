const { KycProfile, User } = require("../models");
const veriffService = require("../services/veriffService");
const diditService = require("../services/diditService");

// @desc    Get data KYC berdasarkan coreId
// @route   GET /api/kyc/:coreId
exports.getKyc = async (req, res) => {
  try {
    const { coreId } = req.params;

    // Cari data KYC di database
    let kyc = await KycProfile.findOne({
      where: { core_id: coreId },
    });

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
      expired: "REJECTED",
      abandoned: "UNVERIFIED",
    };
    const newStatus = statusMap[status];
    if (!newStatus) {
      // event non-decision (started/submitted) — cukup ack
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

    const sessionId = session.session_id || session.id;
    const metadata = { sessionUrl: session.url };

    if (!kyc) {
      kyc = await KycProfile.create({
        core_id: coreId,
        status: "PENDING",
        provider_id: "didit",
        provider_reference: sessionId,
        verification_source: "didit",
        metadata,
      });
    } else {
      await kyc.update({
        status: "PENDING",
        provider_id: "didit",
        provider_reference: sessionId,
        verification_source: "didit",
        metadata,
      });
    }

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

    const kyc = await KycProfile.findOne({ where: { core_id: coreId } });
    if (!kyc) {
      return res
        .status(404)
        .json({ success: false, message: "KYC tidak ditemukan." });
    }

    const newStatus = diditService.mapStatusToLocal(status);
    if (!newStatus) {
      // event/status yang tidak kita proses — cukup ack
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
