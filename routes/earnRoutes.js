const express = require("express");
const router = express.Router();
const { verifyToken, requireTxAuth } = require("../middlewares/auth");
const {
  getUserEarnPositions,
  recordEarnPosition,
  claimEarnPosition,
  getEarnConfig,
} = require("../controllers/earnController");

// Endpoint konfigurasi earn (APR live per asset/term)
router.get("/config", verifyToken, getEarnConfig);

// Endpoint untuk melihat posisi earn user
router.get("/positions/:core_id", verifyToken, getUserEarnPositions);

// Endpoint untuk mencatat posisi earn ke database
router.post("/positions", verifyToken, requireTxAuth, recordEarnPosition);

// Endpoint untuk melakukan claim posisi earn
router.post("/claim/:position_id", verifyToken, requireTxAuth, claimEarnPosition);

module.exports = router;
