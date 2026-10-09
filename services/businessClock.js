/*
 * BusinessClock service — sumber waktu resmi financial engines.
 * (VIVALORA Business Clock & Time Simulation Developer Guide v1.0)
 *
 * REAL mode    -> waktu server nyata.
 * SIMULATED    -> simulated_now dari tabel business_clock.
 *
 * Security rule (guide step 2): simulasi hanya aktif bila env
 * BUSINESS_CLOCK_SIM=1 diset. Tanpa env itu, mode selalu dipaksa REAL
 * dan admin endpoint menolak — production tidak bisa tersimulasi
 * secara tidak sengaja. Matikan/unset env ini untuk rilis produksi.
 */

const { BusinessClock } = require("../models");

const SIM_ENABLED =
  String(process.env.BUSINESS_CLOCK_SIM || "") === "1" ||
  String(process.env.INSTALLMENT_TEST_CLOCK || "").toLowerCase() === "1" ||
  String(process.env.INSTALLMENT_TEST_CLOCK || "").toLowerCase() === "true";

const CLOCK_ROW_ID = 1;
const CACHE_TTL_MS = 2000; // hemat query saat satu request memanggil current() berkali-kali

let cache = { row: null, at: 0 };

async function getRow() {
  if (cache.row && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.row;
  }
  const [row] = await BusinessClock.findOrCreate({
    where: { id: CLOCK_ROW_ID },
    defaults: {
      environment:
        process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
      clockMode: "REAL",
      businessTimezone: "Asia/Jakarta",
    },
  });
  cache = { row, at: Date.now() };
  return row;
}

function invalidate() {
  cache = { row: null, at: 0 };
}

/** Waktu bisnis efektif sekarang. */
async function current() {
  if (!SIM_ENABLED) return new Date();

  const row = await getRow();
  if (row.clockMode === "SIMULATED" && row.simulatedNow) {
    return new Date(row.simulatedNow);
  }
  return new Date();
}

/** true bila clock sedang berjalan dalam mode SIMULATED yang aktif. */
async function isSimulated() {
  if (!SIM_ENABLED) return false;
  const row = await getRow();
  return row.clockMode === "SIMULATED" && Boolean(row.simulatedNow);
}

/** Set clock. mode: 'REAL' | 'SIMULATED'. simulatedNow required saat SIMULATED. */
async function setClock({ mode, simulatedNow, updatedBy }) {
  if (mode !== "REAL" && mode !== "SIMULATED") {
    const err = new Error("mode harus REAL atau SIMULATED");
    err.status = 400;
    throw err;
  }

  let parsed = null;
  if (mode === "SIMULATED") {
    parsed = new Date(simulatedNow);
    if (!simulatedNow || Number.isNaN(parsed.getTime())) {
      const err = new Error(
        "simulated_now wajib berisi datetime valid saat SIMULATED",
      );
      err.status = 400;
      throw err;
    }
  }

  const row = await getRow();
  await row.update({
    clockMode: mode,
    simulatedNow: parsed ?? row.simulatedNow,
    updatedBy: updatedBy || null,
  });
  invalidate();
  return row;
}

async function getState() {
  const row = await getRow();
  const effective = await current();
  return {
    sim_enabled: SIM_ENABLED,
    mode: SIM_ENABLED ? row.clockMode : "REAL",
    simulated_now: row.simulatedNow,
    business_timezone: row.businessTimezone,
    effective_now: effective,
    real_now: new Date(),
    updated_by: row.updatedBy,
    updated_at: row.updatedAt,
  };
}

module.exports = { current, isSimulated, setClock, getState, SIM_ENABLED };
