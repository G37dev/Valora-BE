const express = require("express");

const router = express.Router();

const transactionController = require("../controllers/transactionController");
const midtransController = require("../controllers/midtransController");

const { verifyToken } = require("../middlewares/auth");

router.get("/:coreId", transactionController.getUserTransactions);

router.post("/withdraw", transactionController.requestWithdraw);

router.post(
  "/midtrans/notification",
  midtransController.handleMidtransNotification,
);

module.exports = router;
