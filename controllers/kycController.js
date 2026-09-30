const { KycProfile, User } = require("../models");

// @desc    Get data KYC berdasarkan coreId
// @route   GET /api/kyc/:coreId
exports.getKyc = async (req, res) => {
  try {
    const { coreId } = req.params;

    // Cari data KYC di database
    const kyc = await KycProfile.findOne({
      where: { core_id: coreId },
    });

    if (!kyc) {
      return res.status(404).json({
        success: false,
        message: "Data KYC tidak ditemukan untuk user ini.",
      });
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
