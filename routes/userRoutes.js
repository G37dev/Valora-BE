const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const walletController = require("../controllers/walletController");
const { verifyToken } = require("../middlewares/auth");

// Route Push Token (harus sebelum /:coreId agar tidak ketangkap sebagai param)
router.post("/push-token", verifyToken, userController.registerPushToken);
router.post("/push-test", verifyToken, userController.sendTestPush);

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
