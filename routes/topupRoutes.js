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

// List TopUps (history + pending) milik user
router.get("/", verifyToken, midtransController.listTopUps);

// Status TopUp
router.get("/:refNo", verifyToken, midtransController.getTopUpStatus);

module.exports = router;
