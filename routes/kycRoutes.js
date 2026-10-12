const express = require("express");
const router = express.Router();
const kycController = require("../controllers/kycController");
const { verifyToken } = require("../middlewares/auth"); // Sesuaikan jika kamu pakai middleware auth

// GET data KYC
router.get("/:coreId", verifyToken, kycController.getKyc);

// POST submit KYC
router.post("/:coreId/submit", verifyToken, kycController.submitKyc);

// Veriff — buat session verifikasi (butuh login)
router.post("/veriff/session", verifyToken, kycController.createVeriffSession);

// Veriff — webhook decision (public, diverifikasi via HMAC signature)
router.post("/veriff/webhook", kycController.veriffWebhook);

module.exports = router;
