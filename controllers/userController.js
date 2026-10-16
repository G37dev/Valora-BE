const { User, KycProfile, Wallet, UserPushToken } = require("../models"); // Pastikan KycProfile dan Wallet di-import
const { sendPushToUser } = require("../services/pushService");
const { normalizePhone } = require("../services/waOtpService");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

// @desc    Get user profile by coreId
// @route   GET /api/users/:coreId
exports.getUser = async (req, res) => {
  try {
    const { coreId } = req.params;

    // Cari user berdasarkan coreId dan sertakan data KYC & Wallet
    const user = await User.findOne({
      where: { coreId },
      include: [
        {
          model: KycProfile,
          as: "KycProfile", // Sesuaikan dengan alias di model, hapus 'as' jika tidak pakai alias
          required: false, // Gunakan false agar melakukan LEFT JOIN (karena user mungkin belum KYC)
        },
        {
          model: Wallet,
          as: "Wallet", // Sesuaikan dengan alias di model, hapus 'as' jika tidak pakai alias
          required: false, // Gunakan false agar melakukan LEFT JOIN (karena user mungkin belum punya Wallet)
        },
      ],
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User tidak ditemukan",
      });
    }

    // Ubah data instance Sequelize menjadi JSON biasa
    const userData = user.toJSON();

    // Sisipkan properti tambahan untuk frontend
    const responseData = {
      ...userData,
      kycStatus: userData.KycProfile
        ? userData.KycProfile.status
        : "UNVERIFIED",
      isWalletActive: userData.Wallet
        ? userData.Wallet.status === "ACTIVE"
        : false,
      walletAddress: userData.Wallet ? userData.Wallet.address : null,
    };

    // Opsional: Hapus object nested agar response JSON lebih bersih
    delete responseData.KycProfile;
    delete responseData.Wallet;

    return res.status(200).json({
      success: true,
      data: responseData,
    });
  } catch (error) {
    console.error("Error get user:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
      error: error.message,
    });
  }
};

// @desc    Edit/Update user profile
// @route   PUT /api/users/:coreId
exports.editUser = async (req, res) => {
  try {
    const { coreId } = req.params;
    const { firstName, lastName, email, phoneNumber, avatarUrl, otpTicket } =
      req.body;

    // 1. Cari user berdasarkan coreId
    const user = await User.findOne({ where: { coreId } });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User tidak ditemukan",
      });
    }

    /*
     * Ganti/tambah nomor HP → wajib otpTicket purpose "change-phone"
     * (dikeluarkan /auth/otp/verify setelah user memasukkan kode WA
     * yang dikirim ke nomor baru).
     */
    const normalizedNewPhone = normalizePhone(phoneNumber);
    if (phoneNumber !== undefined && !normalizedNewPhone) {
      return res.status(400).json({ error: "Invalid phone number." });
    }
    const phoneChanged =
      phoneNumber !== undefined &&
      normalizedNewPhone !== normalizePhone(user.phoneNumber);

    if (phoneChanged) {
      const existingPhone = await User.findOne({
        where: { phoneNumber: normalizedNewPhone },
      });
      if (existingPhone && existingPhone.coreId !== user.coreId) {
        return res
          .status(409)
          .json({ error: "This phone number is already registered." });
      }
      try {
        const ticket = jwt.verify(otpTicket || "", JWT_SECRET);
        if (
          ticket.scope !== "wa_otp" ||
          ticket.purpose !== "change-phone" ||
          ticket.coreId !== user.coreId ||
          normalizePhone(ticket.phone) !== normalizedNewPhone
        ) {
          return res.status(400).json({
            error: "Invalid verification proof. Please verify the new number.",
          });
        }
      } catch {
        return res.status(400).json({
          error: "Verification proof expired. Please request a new OTP.",
        });
      }
    }

    // 2. Update data user
    await user.update({
      firstName: firstName !== undefined ? firstName : user.firstName,
      lastName: lastName !== undefined ? lastName : user.lastName,
      email: email !== undefined ? email : user.email,
      phoneNumber: phoneChanged ? normalizedNewPhone : user.phoneNumber,
      avatarUrl: avatarUrl !== undefined ? avatarUrl : user.avatarUrl,
    });

    return res.status(200).json({
      success: true,
      message: "Profil user berhasil diperbarui",
      data: user,
    });
  } catch (error) {
    console.error("Error edit user:", error);
    return res.status(500).json({
      success: false,
      message: "Gagal memperbarui profil user",
      error: error.message,
    });
  }
};

// @desc    Register/update Expo push token untuk device user
// @route   POST /api/users/push-token
exports.registerPushToken = async (req, res) => {
  try {
    const coreId = req.user?.coreId;
    const { push_token, platform } = req.body;

    if (!coreId) {
      return res.status(401).json({
        success: false,
        message: "Token tidak memiliki identitas user",
      });
    }

    if (!push_token || typeof push_token !== "string") {
      return res.status(400).json({
        success: false,
        message: "push_token wajib diisi",
      });
    }

    const [record, created] = await UserPushToken.findOrCreate({
      where: { pushToken: push_token },
      defaults: {
        coreId,
        platform: platform || null,
        lastSeenAt: new Date(),
      },
    });

    if (!created) {
      await record.update({
        coreId,
        platform: platform || record.platform,
        lastSeenAt: new Date(),
      });
    }

    return res.status(200).json({
      success: true,
      message: "Push token terdaftar",
    });
  } catch (error) {
    console.error("Error register push token:", error);
    return res.status(500).json({
      success: false,
      message: "Gagal mendaftarkan push token",
      error: error.message,
    });
  }
};

// @desc    Kirim test push notification ke device pemanggil
// @route   POST /api/users/push-test
exports.sendTestPush = async (req, res) => {
  try {
    const coreId = req.user?.coreId;

    if (!coreId) {
      return res.status(401).json({
        success: false,
        message: "Token tidak memiliki identitas user",
      });
    }

    const result = await sendPushToUser(coreId, {
      title: "Test Notification 🔔",
      body: "Push notification dari backend ViValora berhasil!",
      data: { type: "test" },
    });

    return res.status(200).json({
      success: true,
      message:
        result.sent > 0
          ? "Test push terkirim"
          : "Tidak ada push token terdaftar untuk user ini",
      data: { sent: result.sent },
    });
  } catch (error) {
    console.error("Error send test push:", error);
    return res.status(500).json({
      success: false,
      message: "Gagal mengirim test push",
      error: error.message,
    });
  }
};
