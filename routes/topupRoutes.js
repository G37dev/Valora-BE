const express = require("express");

const router = express.Router();

const midtransController = require("../controllers/midtransController");
const { verifyToken } = require("../middlewares/auth");

// Create Top Up
router.post("/midtrans", verifyToken, midtransController.createMidtransTopUp);

// Midtrans Webhook
router.post("/midtrans/backend", midtransController.handleMidtransNotification);

// Midtrans Response
router.post("/midtrans/response", midtransController.handleMidtransResponse);

// Status TopUp
router.get("/:refNo", verifyToken, midtransController.getTopUpStatus);

module.exports = router;
