const express = require("express");
const {
  createSwap,
  getSwapStatus,
  getUserSwaps,
  getTokenBalance,
} = require("../controllers/swapController");
const { verifyToken } = require("../middlewares/auth");

const router = express.Router();
router.post("/", verifyToken, createSwap);
router.get("/balance/:asset", verifyToken, getTokenBalance);
router.get("/", verifyToken, getUserSwaps);
router.get("/:swapId", verifyToken, getSwapStatus);
module.exports = router;
