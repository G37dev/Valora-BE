const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const passkeyController = require("../controllers/passkeyController");
const otpController = require("../controllers/otpController");
const rateLimit = require("../middleware/rateLimit");

// ==========================================
// RATE LIMITS — proteksi brute-force
// ==========================================
const loginLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 10 });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 15 });
const googleLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 20 });
const otpLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 10 });
const setupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

// ==========================================
// 1. ROUTE UTAMA (LANGKAH 1)
// ==========================================
router.post("/register", registerLimiter, authController.register);
router.post("/login/password", loginLimiter, authController.loginWithPassword);
router.post("/login/google", googleLimiter, authController.loginWithGoogle);

// ==========================================
// 2. ROUTE 2FA - AUTHENTICATOR (TOTP)
// ==========================================
// Meminta Secret Key & QR Code URI (Setup awal)
router.post("/2fa/setup", setupLimiter, authController.setupAuthenticator);
// Memverifikasi 6 digit kode dari aplikasi Authenticator (Untuk Setup maupun Login)
router.post("/2fa/verify", otpLimiter, authController.verifyAuthenticator);
router.post("/2fa/verify-tx", otpLimiter, authController.verifyTransaction2FA);
// Status 2FA aktif/tidak (butuh JWT login)
router.get("/2fa/status", authController.get2FAStatus);
// Nonaktifkan authenticator (butuh JWT + kode OTP aktif)
router.post("/2fa/disable", otpLimiter, authController.disableAuthenticator);

// ==========================================
// 3. ROUTE PASSKEY (WEBAUTHN)
// ==========================================
// Setup passkey baru (butuh JWT login penuh)
router.post(
  "/passkey/register-options",
  setupLimiter,
  passkeyController.getRegisterOptions,
);
router.post(
  "/passkey/register-verify",
  setupLimiter,
  passkeyController.verifyRegister,
);
// Login dengan passkey (butuh pre_auth token)
router.post(
  "/passkey/auth-options",
  otpLimiter,
  passkeyController.getAuthOptions,
);
router.post("/passkey/auth-verify", otpLimiter, passkeyController.verifyAuth);
// Manajemen passkey (butuh JWT login penuh)
router.get("/passkey/list", passkeyController.listPasskeys);
router.delete("/passkey/:id", passkeyController.deletePasskey);

// ==========================================
// 4. ROUTE WHATSAPP OTP
// ==========================================
router.post("/otp/send", otpLimiter, otpController.sendOtp);
router.post("/otp/verify", otpLimiter, otpController.verifyOtp);

module.exports = router;
