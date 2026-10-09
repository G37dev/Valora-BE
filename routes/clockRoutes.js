/*
 * Internal test controls — Business Clock (Guide v1.0 Step 5).
 *
 *   GET  /api/admin/clock           -> state clock (mode, simulated_now, effective_now)
 *   POST /api/admin/clock           -> set mode/time { mode, simulated_now }
 *   POST /api/admin/clock/run-checker -> jalankan installment due checker sekarang
 *
 * Auth: header x-clock-key harus cocok dengan env BUSINESS_CLOCK_KEY,
 * dan simulasi hanya aktif bila BUSINESS_CLOCK_SIM=1 (atau
 * INSTALLMENT_TEST_CLOCK=1) diset. Tanpa env tsb semua endpoint 403 —
 * production selalu REAL.
 */

const express = require("express");
const router = express.Router();
const businessClock = require("../services/businessClock");
const clock = require("../services/installment/installment.clock");
const { tick } = require("../services/installment/installment.scheduler");

function clockAuth(req, res, next) {
  if (!clock.ENABLED) {
    return res.status(403).json({
      success: false,
      message: "Simulasi clock tidak diaktifkan di environment ini",
    });
  }

  const key = process.env.BUSINESS_CLOCK_KEY;
  if (!key || req.headers["x-clock-key"] !== key) {
    return res.status(403).json({
      success: false,
      message: "x-clock-key tidak valid",
    });
  }

  next();
}

router.use("/clock", clockAuth);

router.get("/clock", async (req, res) => {
  try {
    const state = await businessClock.getState();
    return res.status(200).json({ success: true, data: state });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: error.message });
  }
});

router.post("/clock", async (req, res) => {
  try {
    const { mode, simulated_now } = req.body || {};
    const row = await businessClock.setClock({
      mode,
      simulatedNow: simulated_now,
      updatedBy: req.headers["x-clock-key"] ? "clock-key" : null,
    });
    const state = await businessClock.getState();
    return res.status(200).json({
      success: true,
      message: `Business clock -> ${row.clockMode}`,
      data: state,
    });
  } catch (error) {
    return res
      .status(error.status || 500)
      .json({ success: false, message: error.message });
  }
});

router.post("/clock/run-checker", async (req, res) => {
  try {
    const now = await businessClock.current();
    const result = await tick(now);
    return res.status(200).json({
      success: true,
      message: "Installment due checker selesai",
      data: { effective_at: now, ...result },
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: error.message });
  }
});

module.exports = router;
