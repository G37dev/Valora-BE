const express = require("express");
const { verifyToken } = require("../middlewares/auth");
const {
  getConfig,
  quote,
  createRequest,
  pay,
  cancel,
  restructure,
  listPlans,
  getPlanDetail,
} = require("../controllers/installmentController");

const router = express.Router();

// Konfigurasi rate/rule (publik, untuk UI)
router.get("/config", getConfig);

// Preview perhitungan tanpa membuat request
router.post("/quote", quote);

// Lifecycle (butuh JWT; coreId diambil dari token)
router.get("/", verifyToken, listPlans);
router.post("/", verifyToken, createRequest);
router.get("/:plan_id", verifyToken, getPlanDetail);
router.post("/:plan_id/pay", verifyToken, pay);
router.post("/:plan_id/cancel", verifyToken, cancel);
router.post("/:plan_id/restructure", verifyToken, restructure);

module.exports = router;
