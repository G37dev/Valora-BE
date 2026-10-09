/*
 * Sumber waktu untuk Gold Installment.
 *
 * Urutan (Business Clock Guide v1.0):
 * 1. Override per-request (dev tool): header X-Installment-Now atau
 *    body/query as_of — hanya bila simulasi diizinkan env.
 * 2. BusinessClock global (tabel business_clock) — SIMULATED mode.
 * 3. Real server time.
 *
 * Simulasi hanya aktif bila BUSINESS_CLOCK_SIM=1 (atau env legacy
 * INSTALLMENT_TEST_CLOCK=1) diset. Production harus selalu REAL:
 * unset env tsb untuk rilis.
 *
 * now()/isTest() sekarang ASYNC karena membaca tabel business_clock.
 */

const businessClock = require("../businessClock");

const ENABLED =
  businessClock.SIM_ENABLED ||
  String(process.env.INSTALLMENT_TEST_CLOCK || "").toLowerCase() === "1" ||
  String(process.env.INSTALLMENT_TEST_CLOCK || "").toLowerCase() === "true";

function requestOverride(req) {
  const raw =
    req?.headers?.["x-installment-now"] ??
    req?.body?.as_of ??
    req?.query?.as_of;
  if (!raw) return null;
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d;
}

async function now(req) {
  if (ENABLED) {
    // Worker/scheduler: override global via env
    const envNow = process.env.INSTALLMENT_TEST_NOW;
    if (envNow) {
      const d = new Date(envNow);
      if (!Number.isNaN(d.getTime())) return d;
    }

    // HTTP request: header atau body/query
    const override = requestOverride(req);
    if (override) return override;
  }

  return businessClock.current();
}

/**
 * true bila waktu diproses dalam mode simulasi — dipakai untuk menandai
 * plan sebagai isTest dan menyertakan plan test pada list.
 */
async function isTest(req) {
  if (ENABLED) {
    if (process.env.INSTALLMENT_TEST_NOW) return true;
    if (requestOverride(req) || req?.body?.is_test || req?.query?.is_test) {
      return true;
    }
  }
  return businessClock.isSimulated();
}

// Backward-compat alias
const isOverride = isTest;

module.exports = { now, isTest, isOverride, ENABLED };
