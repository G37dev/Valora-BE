const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { Op } = require("sequelize");
const { User, AuthIdentity, PasswordResetToken } = require("../models");
const {
  sendOtpWhatsapp,
  normalizePhone,
} = require("../services/waOtpService");
const { sendOtpEmail } = require("../services/emailOtpService");

const JWT_SECRET = process.env.JWT_SECRET;
const ALLOW_DEV_ECHO = process.env.ALLOW_OTP_DEV_ECHO === "true";

const OTP_TTL_MS = 5 * 60 * 1000; // kode berlaku 5 menit
const RESEND_COOLDOWN_MS = 30 * 1000; // resend dibatasi 30 detik
const MAX_ATTEMPTS = 5;
const MAX_SEND_PER_HOUR = 6;
const BCRYPT_ROUNDS = 12;
const TICKET_TTL = "10m";

const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/;
const CHANNELS = new Set(["wa", "email"]);

const hashCode = (code) =>
  crypto.createHash("sha256").update(String(code)).digest("hex");

const normalizeEmail = (e) =>
  String(e || "")
    .trim()
    .toLowerCase();

const maskTarget = (target, channel) => {
  if (channel === "wa") {
    return target.length > 6
      ? `${target.slice(0, 4)}****${target.slice(-3)}`
      : "****";
  }
  const [name, domain] = target.split("@");
  const shown = name.slice(0, Math.min(3, name.length));
  return `${shown}***@${domain}`;
};

/*
 * Resolve akun dari channel + identifier.
 * wa    : identifier = nomor HP (dinormalisasi ke 62xxx, dicocokkan
 *         ke User.phoneNumber — coba juga format mentah user).
 * email : identifier = email akun (User.email → fallback
 *         AuthIdentity providerUserId=LOCAL buat akun lama).
 */
async function resolveAccount(channel, rawIdentifier) {
  if (channel === "wa") {
    const phone = normalizePhone(rawIdentifier);
    if (!phone) {
      return { error: "Invalid phone number.", status: 400 };
    }
    const user = await User.findOne({
      where: {
        phoneNumber: { [Op.in]: [phone, String(rawIdentifier).trim()] },
      },
    });
    return { user, target: phone };
  }

  const email = normalizeEmail(rawIdentifier);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: "Invalid email address.", status: 400 };
  }
  let user = await User.findOne({ where: { email } });
  if (!user) {
    const identity = await AuthIdentity.findOne({
      where: { providerUserId: email, provider: "LOCAL" },
    });
    if (identity) {
      user = await User.findOne({ where: { coreId: identity.coreId } });
    }
  }
  return { user, target: email };
}

// ============================================================================
// SEND — generate kode, simpan hash, kirim via WA atau email.
// Respon generik saat akun tidak ditemukan (anti user-enumeration).
// ============================================================================
exports.sendResetOtp = async (req, res) => {
  try {
    const channel = String(req.body.channel || "");
    const identifier = String(req.body.identifier || "").trim();
    if (!CHANNELS.has(channel)) {
      return res.status(400).json({ error: "Invalid channel." });
    }
    if (!identifier) {
      return res.status(400).json({ error: "Identifier is required." });
    }

    const resolved = await resolveAccount(channel, identifier);
    if (resolved.error) {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    const { user, target } = resolved;

    // Akun tidak ketemu → balas sukses generik tanpa kirim apa pun.
    if (!user) {
      return res.json({
        ok: true,
        resendAfter: RESEND_COOLDOWN_MS / 1000,
        expiresIn: OTP_TTL_MS / 1000,
      });
    }

    // Cooldown resend per (identifier, channel)
    const latest = await PasswordResetToken.findOne({
      where: { identifier: target, channel },
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
    const sentLastHour = await PasswordResetToken.count({
      where: {
        identifier: target,
        channel,
        created_at: { [Op.gte]: new Date(Date.now() - 60 * 60 * 1000) },
      },
    });
    if (sentLastHour >= MAX_SEND_PER_HOUR) {
      return res
        .status(429)
        .json({ error: "OTP send limit reached. Please try again later." });
    }

    // Nonaktifkan token lama yang belum dipakai
    await PasswordResetToken.update(
      { consumedAt: new Date() },
      { where: { identifier: target, channel, consumedAt: null } },
    );

    const code = crypto.randomInt(0, 1000000).toString().padStart(6, "0");
    const record = await PasswordResetToken.create({
      identifier: target,
      channel,
      coreId: user.coreId,
      codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    });
    if (!record) throw new Error("Failed to persist reset token");

    const result =
      channel === "wa"
        ? await sendOtpWhatsapp(target, code)
        : await sendOtpEmail(target, code);

    res.json({
      ok: true,
      hint: maskTarget(target, channel),
      resendAfter: RESEND_COOLDOWN_MS / 1000,
      expiresIn: OTP_TTL_MS / 1000,
      ...(result.dev && ALLOW_DEV_ECHO ? { devCode: code } : {}),
    });
  } catch (error) {
    console.error("Password reset send error:", error);
    res.status(502).json({
      error: "Failed to deliver verification code. Please try again.",
    });
  }
};

// ============================================================================
// VERIFY — cek kode, keluarkan resetTicket (scope pwd_reset, 10 menit).
// ============================================================================
exports.verifyResetOtp = async (req, res) => {
  try {
    const channel = String(req.body.channel || "");
    const identifier = String(req.body.identifier || "").trim();
    const code = String(req.body.code || "").trim();
    if (!CHANNELS.has(channel) || !identifier || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "Invalid request." });
    }

    const resolved = await resolveAccount(channel, identifier);
    if (resolved.error || !resolved.user) {
      return res
        .status(400)
        .json({ error: "Code not found or expired." });
    }

    const record = await PasswordResetToken.findOne({
      where: {
        identifier: resolved.target,
        channel,
        consumedAt: null,
      },
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
      return res.status(400).json({
        error: `Incorrect code.${left > 0 ? ` ${left} attempt(s) left.` : ""}`,
      });
    }

    await record.update({ consumedAt: new Date() });

    const resetTicket = jwt.sign(
      { rid: record.id, coreId: record.coreId, scope: "pwd_reset" },
      JWT_SECRET,
      { expiresIn: TICKET_TTL },
    );

    res.json({ ok: true, resetTicket });
  } catch (error) {
    console.error("Password reset verify error:", error);
    res.status(500).json({ error: "Failed to verify code." });
  }
};

// ============================================================================
// RESET — pakai resetTicket, tulis password baru ke credential LOCAL.
// Ticket single-use: resetUsedAt ditandai setelah sukses.
// ============================================================================
exports.resetPassword = async (req, res) => {
  try {
    const { resetTicket, newPassword } = req.body || {};
    if (!resetTicket || !newPassword) {
      return res.status(400).json({ error: "Invalid request." });
    }

    let decoded;
    try {
      decoded = jwt.verify(String(resetTicket), JWT_SECRET);
    } catch {
      return res.status(400).json({
        error: "Reset session expired. Please request a new code.",
      });
    }
    if (decoded?.scope !== "pwd_reset" || !decoded.coreId || !decoded.rid) {
      return res.status(400).json({ error: "Invalid reset session." });
    }
    if (!PASSWORD_REGEX.test(String(newPassword))) {
      return res.status(400).json({
        error:
          "Password must be at least 12 characters and include uppercase, lowercase, a number, and a symbol.",
      });
    }

    const record = await PasswordResetToken.findByPk(decoded.rid);
    if (
      !record ||
      record.coreId !== decoded.coreId ||
      !record.consumedAt ||
      record.resetUsedAt
    ) {
      return res.status(400).json({
        error: "Reset session already used or invalid.",
      });
    }

    const passwordHash = await bcrypt.hash(
      String(newPassword),
      BCRYPT_ROUNDS,
    );

    const identity = await AuthIdentity.findOne({
      where: {
        coreId: decoded.coreId,
        provider: "LOCAL",
        type: "CREDENTIAL",
      },
    });
    if (identity) {
      identity.passwordHash = passwordHash;
      await identity.save();
    } else {
      // Akun Google-only — buat credential LOCAL supaya bisa login password.
      const user = await User.findOne({ where: { coreId: decoded.coreId } });
      if (!user?.email) {
        return res.status(400).json({
          error: "Account cannot be reset via password. Contact support.",
        });
      }
      await AuthIdentity.create({
        coreId: decoded.coreId,
        type: "CREDENTIAL",
        provider: "LOCAL",
        providerUserId: user.email,
        passwordHash,
      });
    }

    await record.update({ resetUsedAt: new Date() });

    res.json({
      ok: true,
      message: "Password reset successfully. You can now sign in.",
    });
  } catch (error) {
    console.error("Password reset error:", error);
    res.status(500).json({ error: "Failed to reset password." });
  }
};
