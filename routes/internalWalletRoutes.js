const express = require("express");
const router = express.Router();
const {
  getInternalBalance,
} = require("../controllers/internalWalletController");

// Cek saldo IDR internal user
router.get("/:coreId", getInternalBalance);

module.exports = router;
