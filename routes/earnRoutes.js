const express = require("express");
const router = express.Router();
const {
  getUserEarnPositions,
  recordEarnPosition,
  claimEarnPosition,
} = require("../controllers/earnController");

// Endpoint untuk melihat posisi earn user
router.get("/positions/:core_id", getUserEarnPositions);

// Endpoint untuk mencatat posisi earn ke database
router.post("/positions", recordEarnPosition);

// Endpoint untuk melakukan claim posisi earn
router.post("/claim/:position_id", claimEarnPosition);

module.exports = router;
