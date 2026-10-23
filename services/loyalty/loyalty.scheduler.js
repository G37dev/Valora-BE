/*
 * Loyalty scheduler tick (Vercel cron / worker):
 *   1. promote config SCHEDULED -> ACTIVE
 *   2. ingest event produk (poller)
 *   3. release time-based holds (First Deposit VP 7d; Referral IDR validation)
 *   4. lepas reservasi redemption kadaluarsa
 *   5. membership: snapshot Qualified Balance + refresh tier (batch)
 */

const { Op } = require("sequelize");
const {
  sequelize,
  LoyaltyCustomer,
  LoyaltyRewardGrant,
} = require("../../models");
const configSvc = require("./loyalty.config");
const ledger = require("./loyalty.ledger");
const ingest = require("./loyalty.ingest");
const redemption = require("./loyalty.redemption");
const membership = require("./loyalty.membership");
const businessClock = require("../businessClock");
const { VP_STATE, IDR_STATE } = require("./loyalty.constants");

const TWAB_BATCH = Number(process.env.LOYALTY_TWAB_BATCH || 25);
const TWAB_MIN_INTERVAL_MS = Number(process.env.LOYALTY_TWAB_MIN_INTERVAL_MS || 30 * 60 * 1000);

async function releaseHolds(now) {
  const { config } = await configSvc.resolve(now);
  const due = await LoyaltyRewardGrant.findAll({
    where: {
      state: { [Op.in]: [VP_STATE.PENDING, IDR_STATE.PENDING] },
      availabilityTrigger: "HOLD_EXPIRY",
      availableAt: { [Op.lte]: now },
    },
    limit: 500,
  });
  let vested = 0;
  for (const g of due) {
    await sequelize.transaction(async (t) => {
      const locked = await LoyaltyRewardGrant.findByPk(g.id, { transaction: t, lock: t.LOCK.UPDATE });
      if (locked.unit === "VP") await ledger.vestGrant(locked, { now, trigger: "HOLD_EXPIRY", config }, t);
      else await ledger.makeClaimable(locked, { now, trigger: "HOLD_EXPIRY", config }, t);
      vested++;
    });
  }
  return vested;
}

async function refreshMembership(now, { limit = TWAB_BATCH } = {}) {
  const customers = await LoyaltyCustomer.findAll({
    where: {
      [Op.or]: [
        { tierComputedAt: null },
        { tierComputedAt: { [Op.lt]: new Date(now.getTime() - TWAB_MIN_INTERVAL_MS) } },
      ],
    },
    order: [["tier_computed_at", "ASC NULLS FIRST"]],
    limit,
  });
  const { config } = await configSvc.resolve(now);
  const out = { refreshed: 0, deferred: 0, tier_changes: 0 };
  for (const c of customers) {
    try {
      const rec = await membership.recordBalanceEvent(c.coreId, { now, config, reason: "TICK" });
      if (rec.reason === "PRICE_DEFERRED") out.deferred++;
      const r = await membership.refreshTier(c.coreId, { now, config });
      if (r.tier !== r.previous) out.tier_changes++;
      out.refreshed++;
    } catch (error) {
      console.error(`[Loyalty] membership refresh ${c.coreId}:`, error.message);
    }
  }
  return out;
}

async function tick(now) {
  now = now || (await businessClock.current());
  const report = { effective_at: now };
  report.config_promoted = await configSvc.promoteScheduled(now).catch((e) => ({ error: e.message }));
  report.ingest = await ingest.pollAll(now);
  report.holds_released = await releaseHolds(now).catch((e) => ({ error: e.message }));
  report.reservations_released = await redemption.releaseExpired(now).catch((e) => ({ error: e.message }));
  report.membership = await refreshMembership(now).catch((e) => ({ error: e.message }));
  return report;
}

let task = null;
function startLoyaltyScheduler() {
  if (task) return task;
  const cron = require("node-cron");
  task = cron.schedule("*/2 * * * *", async () => {
    try {
      await tick();
    } catch (error) {
      console.error("[LOYALTY SCHEDULER] tick error:", error.message);
    }
  });
  return task;
}

module.exports = { tick, releaseHolds, refreshMembership, startLoyaltyScheduler };
