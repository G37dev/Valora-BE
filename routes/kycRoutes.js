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

// Didit — buat session verifikasi (butuh login)
router.post("/didit/session", verifyToken, kycController.createDiditSession);

// Didit — webhook status update (public, diverifikasi via X-Signature HMAC)
router.post("/didit/webhook", kycController.diditWebhook);

// Sumsub — buat applicant + accessToken (butuh login)
router.post("/sumsub/session", verifyToken, kycController.createSumsubSession);

// Sumsub — refresh accessToken untuk SDK expiration handler
router.post(
  "/sumsub/token/refresh",
  verifyToken,
  kycController.refreshSumsubToken,
);

// Sumsub — webhook status update (public, diverifikasi via X-Payload-Digest)
router.post("/sumsub/webhook", kycController.sumsubWebhook);

module.exports = router;
