const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { Op } = require("sequelize");
const { User, WaOtpToken } = require("../models");
const { sendOtpWhatsapp, normalizePhone } = require("../services/waOtpService");
const authController = require("./authController");

const JWT_SECRET = process.env.JWT_SECRET;
const ALLOW_DEV_ECHO = process.env.ALLOW_OTP_DEV_ECHO === "true";

const OTP_TTL_MS = 5 * 60 * 1000; // kode berlaku 5 menit
const RESEND_COOLDOWN_MS = 60 * 1000; // minimal 60 detik antar kirim
const MAX_ATTEMPTS = 5;
const MAX_SEND_PER_HOUR = 6;

const PURPOSES = new Set([
  "register",
  "login",
  "transaction",
  "verify-phone",
  "change-phone",
]);
const PURPOSES_WITH_AUTH = new Set([
  "login",
  "transaction",
  "verify-phone",
  "change-phone",
]);

function decodeAuthToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  try {
    return jwt.verify(authHeader.split(" ")[1], JWT_SECRET);
  } catch {
    return null;
  }
}

const hashCode = (code) =>
  crypto.createHash("sha256").update(String(code)).digest("hex");

/*
 * Tentukan nomor tujuan berdasarkan purpose:
 *  - register   : phone dari body (user belum punya akun)
 *  - login      : phone dari user via pre_auth token
 *  - transaction/verify-phone : phone dari user via JWT penuh
 *  - change-phone : nomor BARU dari body, tetap butuh JWT penuh
 */
async function resolveTarget(req, purpose) {
  if (purpose === "register") {
    const phone = normalizePhone(req.body.phone);
    return { phone, coreId: null };
  }

  const decoded = decodeAuthToken(req);
  if (!decoded?.coreId) return { error: "Invalid token.", status: 401 };
  if (purpose === "login" && decoded.scope !== "pre_auth") {
    return { error: "Invalid token.", status: 401 };
  }
  if (purpose !== "login" && decoded.scope === "pre_auth") {
    return { error: "Invalid token.", status: 401 };
  }

  const user = await User.findOne({ where: { coreId: decoded.coreId } });
  if (!user) {
    return { error: "User not found.", status: 404 };
  }

  // change-phone: nomor baru dari body — pastikan belum dipakai akun lain
  if (purpose === "change-phone") {
    const phone = normalizePhone(req.body.phone);
    if (!phone) {
      return { error: "Invalid phone number.", status: 400 };
    }
    const existing = await User.findOne({ where: { phoneNumber: phone } });
    if (existing && existing.coreId !== decoded.coreId) {
      return {
        error: "This phone number is already registered.",
        status: 409,
      };
    }
    return { phone, coreId: decoded.coreId, tenantId: decoded.tenantId };
  }

  const phone = normalizePhone(user?.phoneNumber);
  if (!phone) {
    return {
      error: "No WhatsApp number registered on this account.",
      status: 400,
    };
  }
  return { phone, coreId: decoded.coreId, tenantId: decoded.tenantId };
}

// ============================================================================
// SEND — generate kode, simpan hash, kirim via WA
// ============================================================================
exports.sendOtp = async (req, res) => {
  try {
    const purpose = String(req.body.purpose || "");
    if (!PURPOSES.has(purpose)) {
      return res.status(400).json({ error: "Invalid OTP purpose." });
    }

    const target = await resolveTarget(req, purpose);
    if (target.error) {
      return res.status(target.status).json({ error: target.error });
    }
    const { phone, coreId } = target;

    // Cooldown resend per (phone, purpose)
    const latest = await WaOtpToken.findOne({
      where: { phone, purpose },
      order: [["created_at", "DESC"]],
    });
    if (
      latest &&
      Date.now() - latest.created_at.getTime() < RESEND_COOLDOWN_MS
    ) {
      const retryAfter = Math.ceil(
        (RESEND_COOLDOWN_MS - (Date.now() - latest.created_at.getTime())) /
          1000,
      );
      return res.status(429).json({
        error: `Please wait ${retryAfter} seconds before resending.`,
        retryAfter,
      });
    }

    // Batas kirim per jam
    const sentLastHour = await WaOtpToken.count({
      where: {
        phone,
        purpose,
        created_at: { [Op.gte]: new Date(Date.now() - 60 * 60 * 1000) },
      },
    });
    if (sentLastHour >= MAX_SEND_PER_HOUR) {
      return res
        .status(429)
        .json({ error: "OTP send limit reached. Please try again later." });
    }

    // Nonaktifkan token lama yang belum dipakai
    await WaOtpToken.update(
      { consumedAt: new Date() },
      { where: { phone, purpose, consumedAt: null } },
    );

    const code = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
    await WaOtpToken.create({
      phone,
      coreId,
      purpose,
      codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    });

    const result = await sendOtpWhatsapp(phone, code);

    res.json({
      ok: true,
      phone,
      expiresIn: OTP_TTL_MS / 1000,
      resendAfter: RESEND_COOLDOWN_MS / 1000,
      ...(result.dev && ALLOW_DEV_ECHO ? { devCode: code } : {}),
    });
  } catch (error) {
    console.error("WA OTP send error:", error);
    res.status(500).json({ error: "Failed to send OTP code." });
  }
};

// ============================================================================
// VERIFY — cek kode, keluarkan tiket bukti (otpTicket) 10 menit
// ============================================================================
exports.verifyOtp = async (req, res) => {
  try {
    const purpose = String(req.body.purpose || "");
    const code = String(req.body.code || "").trim();
    if (!PURPOSES.has(purpose)) {
      return res.status(400).json({ error: "Invalid OTP purpose." });
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "OTP code must be 6 digits." });
    }

    const target = await resolveTarget(req, purpose);
    if (target.error) {
      return res.status(target.status).json({ error: target.error });
    }
    const { phone, coreId, tenantId } = target;

    const record = await WaOtpToken.findOne({
      where: { phone, purpose, consumedAt: null },
      order: [["created_at", "DESC"]],
    });

    if (!record || Date.now() > record.expiresAt.getTime()) {
      return res.status(400).json({ error: "Code not found or expired." });
    }
    if (record.attempts >= MAX_ATTEMPTS) {
      return res
        .status(429)
        .json({ error: "No attempts left. Request a new code." });
    }

    if (record.codeHash !== hashCode(code)) {
      await record.increment("attempts");
      const left = MAX_ATTEMPTS - record.attempts;
      return res.status(401).json({
        error: `Incorrect code.${left > 0 ? ` ${left} attempt(s) left.` : ""}`,
      });
    }

    await record.update({ consumedAt: new Date() });

    // Login 2FA via WA — selesaikan login seperti verifyAuthenticator.
    if (purpose === "login") {
      const authData = await authController.generateAuthResponse(
        coreId,
        tenantId,
      );
      return res.json({
        message: "Login successful via WhatsApp OTP.",
        ...authData,
      });
    }

    /*
     * Tiket bukti — dipakai endpoint sensitif (mis. transaksi, ganti nomor)
     * untuk memastikan pemilik WA sudah verifikasi. Hidup 10 menit.
     */
    const otpTicket = jwt.sign(
      { phone, coreId, purpose, scope: "wa_otp" },
      JWT_SECRET,
      { expiresIn: "10m" },
    );

    res.json({ ok: true, otpTicket });
  } catch (error) {
    console.error("WA OTP verify error:", error);
    res.status(500).json({ error: "Failed to verify OTP code." });
  }
};
