/*
 * Loan V1 routes.
 *
 * User (JWT):
 *   GET  /api/loans/config
 *   POST /api/loans/quote
 *   GET  /api/loans
 *   POST /api/loans
 *   GET  /api/loans/:position_id
 *   POST /api/loans/:position_id/drawdown
 *   POST /api/loans/:position_id/repayment/quote
 *   POST /api/loans/:position_id/repay
 *   POST /api/loans/:position_id/collateral/add
 *
 * Admin / treasury / QA (header x-clock-key, sama dengan /api/admin/clock):
 *   GET  /api/loans/admin/positions         GET  /api/loans/admin/risk-events
 *   GET  /api/loans/admin/pool              PUT  /api/loans/admin/pool
 *   POST /api/loans/admin/pool/inject-reserve
 *   GET  /api/loans/admin/treasury          POST /api/loans/admin/treasury/sale
 *   GET  /api/loans/admin/policies          POST /api/loans/admin/policies
 *   POST /api/loans/admin/policies/simulate
 *   POST /api/loans/admin/positions/:position_id/liquidate
 *   POST /api/loans/admin/test/price   { asset, price_idr }   (per token)
 *   POST /api/loans/admin/test/tick
 *
 * Time travel QA: POST /api/admin/clock { mode: "SIMULATED", simulated_now }
 * lalu POST /api/loans/admin/test/tick -> engine memproses anniversary,
 * maturity, cure, observation, PDP, liquidation pada waktu simulasi.
 */

const express = require("express");
const crypto = require("crypto");
const { verifyToken } = require("../middlewares/auth");
const c = require("../controllers/loanController");
const clock = require("../services/loan/loan.clock");

const router = express.Router();

function expectedKey() {
  if (process.env.BUSINESS_CLOCK_KEY) return process.env.BUSINESS_CLOCK_KEY;
  if (process.env.LOAN_ADMIN_KEY) return process.env.LOAN_ADMIN_KEY;
  const secret = process.env.JWT_SECRET || "Valoracore77!";
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 24);
}

function adminAuth(req, res, next) {
  if (req.headers["x-clock-key"] !== expectedKey()) {
    return res.status(403).json({ success: false, message: "x-clock-key invalid" });
  }
  next();
}

function testAuth(req, res, next) {
  if (!clock.ENABLED) {
    return res.status(403).json({ success: false, message: "Simulation disabled in this environment" });
  }
  return adminAuth(req, res, next);
}

// Optional auth: quote boleh tanpa login, tapi kalau ada token pakai coreId
function optionalToken(req, res, next) {
  if (!req.headers.authorization) return next();
  return verifyToken(req, res, next);
}

router.get("/config", c.getConfig);
router.post("/quote", optionalToken, c.quoteOpen);

// Admin (sebelum /:position_id agar tidak tertangkap param)
router.get("/admin/positions", adminAuth, c.adminPositions);
router.get("/admin/risk-events", adminAuth, c.adminRiskEvents);
router.get("/admin/pool", adminAuth, c.adminPool);
router.put("/admin/pool", adminAuth, c.adminUpdatePool);
router.post("/admin/pool/inject-reserve", adminAuth, c.adminInjectReserve);
router.get("/admin/treasury", adminAuth, c.adminTreasury);
router.post("/admin/treasury/sale", adminAuth, c.adminTreasurySale);
router.get("/admin/policies", adminAuth, c.adminPolicies);
router.post("/admin/policies", adminAuth, c.adminCreatePolicy);
router.post("/admin/policies/simulate", adminAuth, c.adminSimulatePolicy);
router.post("/admin/positions/:position_id/liquidate", adminAuth, c.adminForceLiquidate);
router.post("/admin/test/price", testAuth, c.testSetPrice);
router.post("/admin/test/tick", testAuth, c.testRunTick);

// User lifecycle
router.get("/", verifyToken, c.listPositions);
router.post("/", verifyToken, c.openPosition);
router.get("/:position_id", verifyToken, c.getPositionDetail);
router.post("/:position_id/drawdown", verifyToken, c.drawdown);
router.post("/:position_id/repayment/quote", verifyToken, c.quoteRepayment);
router.post("/:position_id/repay", verifyToken, c.repay);
router.post("/:position_id/collateral/add", verifyToken, c.topUp);

module.exports = router;
