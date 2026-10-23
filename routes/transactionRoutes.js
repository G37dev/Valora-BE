const express = require("express");

const router = express.Router();

const transactionController = require("../controllers/transactionController");
const midtransController = require("../controllers/midtransController");

const { verifyToken } = require("../middlewares/auth");
const rateLimit = require("../middleware/rateLimit");

// Withdraw: max 10 request / 5 menit per IP — endpoint ini memindahkan dana.
const withdrawLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 10 });

router.get("/:coreId", verifyToken, transactionController.getUserTransactions);

router.post(
  "/withdraw",
  withdrawLimiter,
  verifyToken,
  transactionController.requestWithdraw,
);

router.post(
  "/midtrans/notification",
  midtransController.handleMidtransNotification,
);

module.exports = router;
