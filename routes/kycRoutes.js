const express = require("express");
const router = express.Router();
const kycController = require("../controllers/kycController");
const { verifyToken } = require("../middlewares/auth"); // Sesuaikan jika kamu pakai middleware auth

// GET data KYC
router.get("/:coreId", verifyToken, kycController.getKyc);

// POST submit KYC
router.post("/:coreId/submit", verifyToken, kycController.submitKyc);

module.exports = router;
