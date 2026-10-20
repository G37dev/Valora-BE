const express = require("express");
const router = express.Router();
const { verifyToken } = require("../middlewares/auth");
const {
  getUserEarnPositions,
  recordEarnPosition,
  claimEarnPosition,
} = require("../controllers/earnController");

// Endpoint untuk melihat posisi earn user
router.get("/positions/:core_id", verifyToken, getUserEarnPositions);

// Endpoint untuk mencatat posisi earn ke database
router.post("/positions", verifyToken, recordEarnPosition);

// Endpoint untuk melakukan claim posisi earn
router.post("/claim/:position_id", verifyToken, claimEarnPosition);

module.exports = router;
