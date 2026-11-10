const jwt = require("jsonwebtoken");

const verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];

  // Format header biasanya: "Bearer <token>"
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: "Akses ditolak. Token tidak ditemukan.",
    });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decodedUser) => {
    if (err) {
      return res.status(403).json({
        success: false,
        message: "Token tidak valid atau sudah kedaluwarsa.",
      });
    }

    req.user = decodedUser;
    next();
  });
};

/*
 * Proteksi transaksi untuk user yang mengaktifkan 2FA.
 *
 * Dipasang SETELAH verifyToken pada endpoint yang memindahkan
 * dana (withdraw, swap, earn, installment, loan, topup).
 *
 * - User tanpa 2FA aktif  -> lanjut seperti biasa.
 * - User dengan TOTP/passkey aktif -> wajib header `x-tx-auth`
 *   berisi txTicket (JWT scope "tx_auth", umur 5 menit) yang
 *   diterbitkan /auth/2fa/verify-tx atau /auth/passkey/auth-verify.
 *
 * Status 428 (Precondition Required) dipakai supaya tidak
 * tertukar dengan 401/403 sesi login.
 */
const requireTxAuth = async (req, res, next) => {
  try {
    const coreId = req.user?.coreId;
    if (!coreId) {
      return res.status(403).json({
        success: false,
        message: "Token tidak valid.",
      });
    }

    const { AuthIdentity } = require("../models");

    const [totp, passkeyCount] = await Promise.all([
      AuthIdentity.findOne({
        where: {
          coreId,
          provider: "AUTHENTICATOR",
          type: "TOTP",
          status: "ACTIVE",
        },
        attributes: ["id"],
      }),
      AuthIdentity.count({
        where: {
          coreId,
          provider: "PASSKEY",
          type: "WEBAUTHN",
          status: "ACTIVE",
        },
      }),
    ]);

    // User belum aktifkan 2FA -> tidak ada gate tambahan.
    if (!totp && passkeyCount === 0) return next();

    const ticket = req.headers["x-tx-auth"];
    if (!ticket) {
      return res.status(428).json({
        success: false,
        code: "TX_2FA_REQUIRED",
        message: "Verifikasi 2FA diperlukan untuk transaksi ini.",
      });
    }

    try {
      const decoded = jwt.verify(ticket, process.env.JWT_SECRET);
      if (decoded.scope !== "tx_auth" || decoded.coreId !== coreId) {
        throw new Error("invalid scope");
      }
    } catch {
      return res.status(428).json({
        success: false,
        code: "TX_2FA_INVALID",
        message: "Verifikasi 2FA tidak valid atau sudah kedaluwarsa.",
      });
    }

    next();
  } catch (error) {
    console.error("requireTxAuth error:", error);
    res.status(500).json({
      success: false,
      message: "Gagal memeriksa otorisasi transaksi.",
    });
  }
};

module.exports = { verifyToken, requireTxAuth };
