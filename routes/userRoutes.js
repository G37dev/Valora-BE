const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const walletController = require("../controllers/walletController");
const { verifyToken } = require("../middlewares/auth");

// Route Profil User (Sudah kita modifikasi controllernya di atas)
router.get("/:coreId", userController.getUser);
router.put("/:coreId", verifyToken, userController.editUser);

// Route Baru untuk Aktivasi Wallet
router.post(
  "/:coreId/wallet/activate",
  verifyToken,
  walletController.activateWallet,
);

module.exports = router;
