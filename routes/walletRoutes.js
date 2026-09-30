const express = require("express");
const router = express.Router();
const walletController = require("../controllers/walletController");
const balanceController = require("../controllers/balanceController");

const { verifyToken } = require("../middlewares/auth"); // Sesuaikan jika ada middleware

// Route untuk Aktivasi Wallet
router.post("/:coreId/activate", verifyToken, walletController.activateWallet);
router.get("/:coreId/balances", verifyToken, balanceController.getAllBalances);
router.get("/status/:coreId", verifyToken, walletController.checkWalletStatus);

module.exports = router;
