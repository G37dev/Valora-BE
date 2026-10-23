/*
 * Loyalty & Referral routes (brief 12.4).
 *
 * User (JWT):
 *   GET  /api/rewards/summary            GET  /api/rewards/history
 *   GET  /api/rewards/rules              GET  /api/rewards/catalog
 *   GET  /api/rewards/:reward_id
 *   POST /api/rewards/fee-quote          POST /api/rewards/redeem
 *   POST /api/rewards/redeem/:id/commit  POST /api/rewards/redeem/:id/release
 *   GET  /api/referrals/summary          GET  /api/referrals/validate?code=   (public)
 *   POST /api/referrals/bind             POST /api/referrals/claims (Claim All)
 *   GET  /api/referrals/claims
 *   GET  /api/membership/status          POST /api/membership/refresh
 *
 * Admin (x-clock-key, sama dengan Loan/clock admin):
 *   GET  /api/rewards/admin/dashboard
 *   GET  /api/rewards/admin/config               GET  /api/rewards/admin/config/versions
 *   POST /api/rewards/admin/config/draft         POST /api/rewards/admin/config/:version/transition
 *   POST /api/rewards/admin/grants/:grant_id/reverse
 *   GET  /api/rewards/admin/events/failed        POST /api/rewards/admin/events/ingest
 *   POST /api/rewards/admin/catalog              GET  /api/rewards/admin/customers/:core_id
 *   POST /api/rewards/admin/tick
 *
 * Cron (Vercel, Authorization: Bearer CRON_SECRET):
 *   GET  /api/rewards/cron/loyalty-tick
 */

const express = require("express");
const crypto = require("crypto");
const { verifyToken } = require("../middlewares/auth");
const rateLimit = require("../middleware/rateLimit");
const c = require("../controllers/loyaltyController");

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
function cronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  const bearer = String(req.headers.authorization || "");
  const expected = `Bearer ${secret}`;
  const ok = secret && bearer.length === expected.length && crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(expected));
  if (!ok) return res.status(401).json({ success: false, message: "Unauthorized" });
  next();
}

const byUser = (req) => req.user?.coreId || req.ip;
const claimLimiter = rateLimit({ windowMs: 60_000, max: 10, keyFn: byUser });
const redeemLimiter = rateLimit({ windowMs: 60_000, max: 20, keyFn: byUser });
const refreshLimiter = rateLimit({ windowMs: 60_000, max: 2, keyFn: byUser });
const bindLimiter = rateLimit({ windowMs: 60_000, max: 5, keyFn: byUser });

// ---------------- /api/rewards ----------------
const rewards = express.Router();

rewards.get("/rules", c.rules);
rewards.get("/catalog", c.catalog);

rewards.get("/admin/dashboard", adminAuth, c.adminDashboard);
rewards.get("/admin/config", adminAuth, c.adminConfigActive);
rewards.get("/admin/config/versions", adminAuth, c.adminConfigList);
rewards.post("/admin/config/draft", adminAuth, c.adminConfigDraft);
rewards.post("/admin/config/:version/transition", adminAuth, c.adminConfigTransition);
rewards.post("/admin/grants/:grant_id/reverse", adminAuth, c.adminReverse);
rewards.get("/admin/events/failed", adminAuth, c.adminFailedEvents);
rewards.post("/admin/events/ingest", adminAuth, c.adminIngest);
rewards.post("/admin/catalog", adminAuth, c.adminCatalogUpsert);
rewards.get("/admin/customers/:core_id", adminAuth, c.adminCustomer);
rewards.post("/admin/tick", adminAuth, c.adminTick);
rewards.get("/cron/loyalty-tick", cronAuth, c.adminTick);

rewards.get("/summary", verifyToken, c.summary);
rewards.get("/history", verifyToken, c.history);
rewards.post("/fee-quote", verifyToken, c.feeQuote);
rewards.post("/redeem", verifyToken, redeemLimiter, c.redeem);
rewards.post("/redeem/:redemption_id/commit", verifyToken, c.commitRedemption);
rewards.post("/redeem/:redemption_id/release", verifyToken, c.releaseRedemption);
rewards.get("/:reward_id", verifyToken, c.rewardDetail);

// ---------------- /api/referrals ----------------
const referrals = express.Router();
referrals.get("/validate", c.validateCode);
referrals.get("/summary", verifyToken, c.referralSummary);
referrals.post("/bind", verifyToken, bindLimiter, c.bindReferral);
referrals.post("/claims", verifyToken, claimLimiter, c.claimAll);
referrals.get("/claims", verifyToken, c.claimHistory);

// ---------------- /api/membership ----------------
const membership = express.Router();
membership.get("/status", verifyToken, c.membershipStatus);
membership.post("/refresh", verifyToken, refreshLimiter, c.membershipRefresh);

module.exports = { rewards, referrals, membership };
