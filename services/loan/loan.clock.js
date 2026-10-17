/*
 * Sumber waktu Loan — mengikuti BusinessClock global (tabel business_clock).
 *
 * Time travel untuk QA: POST /api/admin/clock { mode: "SIMULATED",
 * simulated_now } (gated x-clock-key) -> semua engine Loan (anniversary,
 * maturity, cure, 4h observation, PDP) memakai waktu itu.
 *
 * Override per-request (header X-Loan-Now / body.as_of) hanya aktif bila
 * LOAN_TEST_CLOCK=1 — lever publik, harus opt-in eksplisit.
 * Production: BUSINESS_CLOCK_DISABLED=1 -> selalu REAL.
 */

const businessClock = require("../businessClock");

const REQUEST_OVERRIDE_ENABLED = ["1", "true"].includes(
  String(process.env.LOAN_TEST_CLOCK || "").toLowerCase(),
);

const ENABLED = businessClock.SIM_ENABLED || REQUEST_OVERRIDE_ENABLED;

function requestOverride(req) {
  const raw =
    req?.headers?.["x-loan-now"] ?? req?.body?.as_of ?? req?.query?.as_of;
  if (!raw) return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

async function now(req) {
  if (REQUEST_OVERRIDE_ENABLED) {
    const envNow = process.env.LOAN_TEST_NOW;
    if (envNow) {
      const d = new Date(envNow);
      if (!Number.isNaN(d.getTime())) return d;
    }
    const override = requestOverride(req);
    if (override) return override;
  }
  return businessClock.current();
}

async function isTest(req) {
  if (REQUEST_OVERRIDE_ENABLED) {
    if (process.env.LOAN_TEST_NOW) return true;
    if (requestOverride(req) || req?.body?.is_test || req?.query?.is_test) {
      return true;
    }
  }
  return businessClock.isSimulated();
}

module.exports = { now, isTest, ENABLED };
