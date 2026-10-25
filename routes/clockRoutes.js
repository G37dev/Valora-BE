/*
 * Internal test controls — Business Clock (Guide v1.0 Step 5).
 *
 *   GET  /api/admin/clock           -> state clock (mode, simulated_now, effective_now)
 *   POST /api/admin/clock           -> set mode/time { mode, simulated_now }
 *   POST /api/admin/clock/run-checker -> jalankan installment due checker sekarang
 *
 * Auth: header x-clock-key harus cocok dengan env BUSINESS_CLOCK_KEY,
 * atau — bila env itu tidak diset — dengan sha256(JWT_SECRET)[0:24].
 * JWT_SECRET sudah selalu ada, jadi tidak perlu env tambahan.
 * Production: set BUSINESS_CLOCK_DISABLED=1 -> semua endpoint 403.
 */

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const businessClock = require("../services/businessClock");
const clock = require("../services/installment/installment.clock");
const { tick } = require("../services/installment/installment.scheduler");

function expectedKey() {
  if (process.env.BUSINESS_CLOCK_KEY) return process.env.BUSINESS_CLOCK_KEY;
  const secret = process.env.JWT_SECRET || "Valoracore77!";
  return crypto.createHash("sha256").update(secret).digest("hex").slice(0, 24);
}

function clockAuth(req, res, next) {
  if (!clock.ENABLED) {
    return res.status(403).json({
      success: false,
      message: "Simulasi clock dinonaktifkan di environment ini",
    });
  }

  if (req.headers["x-clock-key"] !== expectedKey()) {
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
    return res.status(500).json({ success: false, message: error.message });
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
    return res.status(500).json({ success: false, message: error.message });
  }
});

// Vercel Cron endpoints — serverless tidak bisa menjalankan worker.js,
// jadi semua scheduler/poller dipicu lewat HTTP GET terjadwal. Vercel
// mengirim `Authorization: Bearer <CRON_SECRET>`; diverifikasi
// timing-safe. Di luar /clock/* supaya tidak kena clockAuth.
function cronAuth(req, res, next) {
  const secret = process.env.CRON_SECRET;
  const bearer = String(req.headers.authorization || "");
  const expected = `Bearer ${secret}`;
  const ok =
    secret &&
    bearer.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(bearer), Buffer.from(expected));
  if (!ok) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }
  next();
}

const runCron = (label, fn) => async (req, res) => {
  try {
    const data = await fn();
    return res.status(200).json({ success: true, label, data });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, label, message: error.message });
  }
};

const cronTicks = require("../services/cronTicks");

router.get(
  "/cron/installment-tick",
  cronAuth,
  runCron("installment-tick", async () => {
    const now = await businessClock.current();
    return { effective_at: now, ...(await tick(now)) };
  }),
);

router.get(
  "/cron/loan-tick",
  cronAuth,
  runCron("loan-tick", cronTicks.tickLoan),
);

router.get(
  "/cron/price-tick",
  cronAuth,
  runCron("price-tick", cronTicks.tickPrice),
);

router.get(
  "/cron/queue-drain",
  cronAuth,
  runCron("queue-drain", cronTicks.drainAllQueues),
);

router.get(
  "/cron/chain-events-tick",
  cronAuth,
  runCron("chain-events-tick", cronTicks.tickChainEvents),
);

router.get(
  "/cron/earn-treasury-tick",
  cronAuth,
  runCron("earn-treasury-tick", cronTicks.tickEarnTreasury),
);

/*
 * Konsolidasi semua tick dalam satu endpoint — untuk scheduler
 * eksternal (cron-job.org/GitHub Actions) karena Vercel Hobby
 * hanya mengizinkan 2 cron @ max 1x/hari.
 *
 * Producer tick jalan paralel, loyalty terakhir supaya ingest-nya
 * melihat event segar dari tick lain. Per-tick error tidak fatal —
 * dikumpulkan di report. Semua tick idempotent (cursor/dedup),
 * aman dipanggil ulang kapan pun.
 */
router.get(
  "/cron/all-tick",
  cronAuth,
  async (req, res) => {
    const report = {};
    const producers = {
      "price-tick": cronTicks.tickPrice,
      "loan-tick": cronTicks.tickLoan,
      "installment-tick": async () => {
        const now = await businessClock.current();
        const { tick } = require("../services/installment/installment.scheduler");
        return { effective_at: now, ...(await tick(now)) };
      },
      "queue-drain": cronTicks.drainAllQueues,
      "chain-events-tick": cronTicks.tickChainEvents,
      "earn-treasury-tick": cronTicks.tickEarnTreasury,
    };

    await Promise.all(
      Object.entries(producers).map(async ([label, fn]) => {
        try {
          report[label] = { success: true, data: await fn() };
        } catch (error) {
          report[label] = { success: false, message: error.message };
        }
      }),
    );

    try {
      const loyaltyScheduler = require("../services/loyalty/loyalty.scheduler");
      const now = await businessClock.current();
      report["loyalty-tick"] = {
        success: true,
        data: await loyaltyScheduler.tick(now),
      };
    } catch (error) {
      report["loyalty-tick"] = { success: false, message: error.message };
    }

    const failed = Object.entries(report)
      .filter(([, r]) => !r.success)
      .map(([label]) => label);
    return res.status(failed.length === Object.keys(report).length ? 500 : 200).json({
      success: failed.length === 0,
      failed,
      report,
    });
  },
);

module.exports = router;
