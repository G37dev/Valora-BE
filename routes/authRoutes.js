const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

// ==========================================
// 1. ROUTE UTAMA (LANGKAH 1)
// ==========================================
router.post("/register", authController.register);
router.post("/login/password", authController.loginWithPassword);
router.post("/login/google", authController.loginWithGoogle);

// ==========================================
// 2. ROUTE 2FA - AUTHENTICATOR (TOTP)
// ==========================================
// Meminta Secret Key & QR Code URI (Setup awal)
router.post("/2fa/setup", authController.setupAuthenticator);
// Memverifikasi 6 digit kode dari aplikasi Authenticator (Untuk Setup maupun Login)
router.post("/2fa/verify", authController.verifyAuthenticator);
router.post("/2fa/verify-tx", authController.verifyTransaction2FA);
// Status 2FA aktif/tidak (butuh JWT login)
router.get("/2fa/status", authController.get2FAStatus);
// Nonaktifkan authenticator (butuh JWT + kode OTP aktif)
router.post("/2fa/disable", authController.disableAuthenticator);

module.exports = router;
