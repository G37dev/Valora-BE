/*
 * Risk worker / scheduler Loan (brief 21 checklist "Risk worker").
 *
 * Cron hanya PEMICU; waktu efektif = BusinessClock (bisa SIMULATED untuk
 * QA). Tiap tick:
 *  1. rekam price tick (TWAP) dari tabel prices,
 *  2. settle + evaluasi risk semua posisi open yang nextEventAt <= now
 *     (interest posting, PDP, maturity/cure, observation, emergency,
 *     liquidation authorization & execution, retry release).
 */

const cron = require("node-cron");
const { Op } = require("sequelize");
const { LoanPosition, LoanLiquidation } = require("../../models");
const { settlePosition } = require("./loan.service");
const liquidation = require("./loan.liquidation");
const pricing = require("./loan.pricing");
const { getActivePolicy } = require("./loan.policy");
const { OPEN_STATUSES, ASSET } = require("./loan.constants");
const businessClock = require("../businessClock");

const BATCH_SIZE = Number(process.env.LOAN_SCHEDULER_BATCH ?? 100);
let running = false;

async function tick(now) {
  if (running) return { skipped: true };
  if (!now) now = await businessClock.current();
  running = true;
  let processed = 0;
  let failed = 0;
  let liquidated = 0;
  try {
    for (const asset of Object.values(ASSET)) {
      await pricing.recordTickFromPriceTable(asset).catch(() => {});
    }
    const policy = await getActivePolicy(now);
    const priceCache = {};
    for (const asset of Object.values(ASSET)) {
      priceCache[asset] = await pricing.getValidatedPrice(asset, now, { policy });
    }

    const due = await LoanPosition.findAll({
      attributes: ["id"],
      where: {
        status: { [Op.in]: OPEN_STATUSES },
        [Op.or]: [{ nextEventAt: null }, { nextEventAt: { [Op.lte]: now } }],
      },
      order: [["next_event_at", "ASC"]],
      limit: BATCH_SIZE,
    });
    for (const { id } of due) {
      try {
        await settlePosition(id, now, { priceCache });
        processed += 1;
      } catch (error) {
        failed += 1;
        console.error(`[LOAN SCHEDULER] posisi ${id} gagal:`, error.message);
      }
    }

    // Retry liquidation yang belum tereksekusi (chain gagal / crash)
    const pendingLiq = await LoanLiquidation.findAll({
      where: { state: { [Op.in]: ["AUTHORIZED", "FAILED_RETRY"] } },
      limit: BATCH_SIZE,
    });
    for (const l of pendingLiq) {
      try {
        const r = await liquidation.execute(l.id, now);
        if (r?.state === "EXECUTED") liquidated += 1;
      } catch (error) {
        console.error(`[LOAN SCHEDULER] liquidation ${l.id} gagal:`, error.message);
      }
    }
    const pendingPositions = await LoanPosition.findAll({
      attributes: ["id"],
      where: { status: "LIQUIDATION_PENDING" },
      limit: BATCH_SIZE,
    });
    for (const { id } of pendingPositions) {
      try {
        const r = await liquidation.processPending(id, now);
        if (r?.state === "EXECUTED") liquidated += 1;
      } catch (error) {
        console.error(`[LOAN SCHEDULER] pending liquidation ${id} gagal:`, error.message);
      }
    }

    if (processed || failed || liquidated) {
      console.log(`[LOAN SCHEDULER] processed=${processed} failed=${failed} liquidated=${liquidated}`);
    }
  } catch (error) {
    console.error("[LOAN SCHEDULER] tick error:", error.message);
  } finally {
    running = false;
  }
  return { processed, failed, liquidated };
}

function startLoanScheduler() {
  const task = cron.schedule("* * * * *", () => tick());
  console.log("[LOAN SCHEDULER] aktif (tiap 1 menit, business-clock based).");
  return task;
}

module.exports = { startLoanScheduler, tick };
