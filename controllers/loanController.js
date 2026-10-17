const service = require("../services/loan/loan.service");
const admin = require("../services/loan/loan.admin");
const policy = require("../services/loan/loan.policy");
const clock = require("../services/loan/loan.clock");
const { tick } = require("../services/loan/loan.scheduler");
const { LoanError, toJsonSafe } = require("../services/loan/loan.errors");

function handleError(res, error, context) {
  if (error instanceof LoanError) {
    return res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
      details: toJsonSafe(error.details),
    });
  }
  console.error(`[Loan] ${context} error:`, error);
  return res.status(500).json({
    success: false,
    message: `Failed while ${context}`,
    error: error.message,
  });
}

function requireCoreId(req, res) {
  const coreId = req.user?.coreId;
  if (!coreId) {
    res
      .status(401)
      .json({ success: false, message: "coreId not found in token" });
    return null;
  }
  return coreId;
}

const wrap = (context, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    handleError(res, error, context);
  }
};

// ---------------- Public / user ----------------

/** @route GET /api/loans/config */
const getConfig = wrap("loading config", async (req, res) => {
  res.json({ success: true, data: await service.config(await clock.now(req)) });
});

/** @route POST /api/loans/quote  body: collateral_asset, collateral_qty, tenor_days, gross_loan_idr? */
const quoteOpen = wrap("calculating quote", async (req, res) => {
  const data = await service.quoteOpen({
    coreId: req.user?.coreId || null,
    body: req.body || {},
    now: await clock.now(req),
  });
  res.json({ success: true, data });
});

/** @route POST /api/loans  body: quote fields + gross_loan_idr + idempotency_key */
const openPosition = wrap("opening loan", async (req, res) => {
  const coreId = requireCoreId(req, res);
  if (!coreId) return;
  const now = await clock.now(req);
  const { position, created } = await service.openPosition({
    coreId,
    body: req.body || {},
    now,
    isTest: await clock.isTest(req),
  });
  res.status(created ? 201 : 200).json({
    success: true,
    message: created
      ? "Loan active. Net disbursement credited to your IDR wallet."
      : "Loan already created (idempotent).",
    data: await service.serializePosition(position, { now }),
  });
});

/** @route GET /api/loans?status=&include_test= */
const listPositions = wrap("loading loans", async (req, res) => {
  const coreId = requireCoreId(req, res);
  if (!coreId) return;
  const data = await service.listPositions({
    coreId,
    status: req.query.status,
    includeTest:
      (await clock.isTest(req)) ||
      ["1", "true"].includes(String(req.query.include_test)),
    now: await clock.now(req),
  });
  res.json({ success: true, data });
});

/** @route GET /api/loans/:position_id */
const getPositionDetail = wrap("loading loan detail", async (req, res) => {
  const coreId = requireCoreId(req, res);
  if (!coreId) return;
  res.json({
    success: true,
    data: await service.getPositionDetail({
      coreId,
      positionId: req.params.position_id,
      now: await clock.now(req),
    }),
  });
});

/** @route POST /api/loans/:position_id/drawdown  body: gross_loan_idr, idempotency_key */
const drawdown = wrap("processing drawdown", async (req, res) => {
  const coreId = requireCoreId(req, res);
  if (!coreId) return;
  const now = await clock.now(req);
  const {
    position,
    drawdown: dd,
    duplicate,
  } = await service.drawdown({
    coreId,
    positionId: req.params.position_id,
    body: req.body || {},
    now,
  });
  res.json({
    success: true,
    message: duplicate
      ? "Drawdown already processed (idempotent)."
      : "Additional drawdown credited.",
    data: toJsonSafe({
      drawdown: dd,
      position: await service.serializePosition(position, { now }),
    }),
  });
});

/** @route POST /api/loans/:position_id/repayment/quote  body: amount_idr | full_settlement */
const quoteRepayment = wrap("quoting repayment", async (req, res) => {
  const coreId = requireCoreId(req, res);
  if (!coreId) return;
  res.json({
    success: true,
    data: await service.quoteRepayment({
      coreId,
      positionId: req.params.position_id,
      body: req.body || {},
      now: await clock.now(req),
    }),
  });
});

/** @route POST /api/loans/:position_id/repay  body: amount_idr | full_settlement, approve_release?, idempotency_key */
const repay = wrap("processing repayment", async (req, res) => {
  const coreId = requireCoreId(req, res);
  if (!coreId) return;
  const now = await clock.now(req);
  const out = await service.repay({
    coreId,
    positionId: req.params.position_id,
    body: req.body || {},
    now,
  });
  res.json({
    success: true,
    message: out.duplicate
      ? "Repayment already processed (idempotent)."
      : out.position.status === "COMPLETED"
        ? "Loan fully settled. Collateral release in progress."
        : "Repayment applied.",
    data: toJsonSafe({
      repayment: out.repayment,
      release: out.release,
      position: await service.serializePosition(out.position, { now }),
    }),
  });
});

/** @route POST /api/loans/:position_id/collateral/add  body: collateral_qty, idempotency_key */
const topUp = wrap("adding collateral", async (req, res) => {
  const coreId = requireCoreId(req, res);
  if (!coreId) return;
  const now = await clock.now(req);
  const out = await service.topUpCollateral({
    coreId,
    positionId: req.params.position_id,
    body: req.body || {},
    now,
  });
  res.json({
    success: true,
    message: out.duplicate
      ? "Already processed (idempotent)."
      : "Collateral added.",
    data: toJsonSafe({
      tx_hash: out.txHash,
      position: await service.serializePosition(out.position, { now }),
    }),
  });
});

// ---------------- Admin / treasury ----------------

const adminPositions = wrap("loading admin positions", async (req, res) => {
  res.json({
    success: true,
    data: await admin.positions({
      status: req.query.status,
      asset: req.query.asset,
      coreId: req.query.core_id,
      limit: req.query.limit,
      now: await clock.now(req),
    }),
  });
});
const adminRiskEvents = wrap("loading risk events", async (req, res) => {
  res.json({
    success: true,
    data: await admin.riskEvents({
      positionId: req.query.position_id,
      limit: req.query.limit,
    }),
  });
});
const adminPool = wrap("loading pool", async (req, res) => {
  res.json({
    success: true,
    data: await admin.poolDashboard(await clock.now(req)),
  });
});
const adminUpdatePool = wrap("updating pool", async (req, res) => {
  const row = await admin.updatePool(
    req.body || {},
    req.headers["x-admin-actor"] || "admin",
  );
  res.json({
    success: true,
    data: await admin.poolDashboard(await clock.now(req)),
    row: toJsonSafe(row.toJSON()),
  });
});
const adminInjectReserve = wrap("injecting reserve", async (req, res) => {
  await admin.injectReserve(
    req.body || {},
    req.headers["x-admin-actor"] || "admin",
    await clock.now(req),
  );
  res.json({
    success: true,
    data: await admin.poolDashboard(await clock.now(req)),
  });
});
const adminTreasury = wrap("loading treasury", async (req, res) => {
  res.json({
    success: true,
    data: await admin.treasuryDashboard(await clock.now(req)),
  });
});
const adminTreasurySale = wrap("recording treasury sale", async (req, res) => {
  res.json({
    success: true,
    data: toJsonSafe(
      await admin.recordTreasurySale(
        req.body || {},
        req.headers["x-admin-actor"] || "admin",
        await clock.now(req),
      ),
    ),
  });
});
const adminPolicies = wrap("loading policies", async (req, res) => {
  res.json({
    success: true,
    data: toJsonSafe(await policy.listPolicyVersions()),
  });
});
const adminCreatePolicy = wrap("creating policy", async (req, res) => {
  res.status(201).json({
    success: true,
    data: toJsonSafe(
      await policy.createPolicyVersion(
        req.body || {},
        req.headers["x-admin-actor"] || "admin",
      ),
    ),
  });
});
const adminSimulatePolicy = wrap("simulating policy", async (req, res) => {
  res.json({
    success: true,
    data: await admin.simulatePolicyImpact(
      req.body || {},
      await clock.now(req),
    ),
  });
});
const adminForceLiquidate = wrap("forcing liquidation", async (req, res) => {
  res.json({
    success: true,
    data: toJsonSafe(
      await admin.forceLiquidate(
        req.params.position_id,
        await clock.now(req),
        req.headers["x-admin-actor"] || "admin",
      ),
    ),
  });
});

// ---------------- QA / test controls (gated clock key) ----------------

const testSetPrice = wrap("setting test price", async (req, res) => {
  res.json({
    success: true,
    data: await admin.setTestPrice(req.body || {}, await clock.now(req)),
  });
});
const testRunTick = wrap("running loan tick", async (req, res) => {
  const now = await clock.now(req);
  res.json({
    success: true,
    data: toJsonSafe({ effective_at: now, ...(await tick(now)) }),
  });
});

// Prod scheduler trigger — dipanggil cron eksternal / Vercel Cron.
// Pakai waktu business clock asli (bukan override test).
const adminRunTick = wrap("running loan tick", async (req, res) => {
  const businessClock = require("../services/businessClock");
  const now = await businessClock.current();
  res.json({
    success: true,
    data: toJsonSafe({ effective_at: now, ...(await tick(now)) }),
  });
});

module.exports = {
  getConfig,
  quoteOpen,
  openPosition,
  listPositions,
  getPositionDetail,
  drawdown,
  quoteRepayment,
  repay,
  topUp,
  adminPositions,
  adminRiskEvents,
  adminPool,
  adminUpdatePool,
  adminInjectReserve,
  adminTreasury,
  adminTreasurySale,
  adminPolicies,
  adminCreatePolicy,
  adminSimulatePolicy,
  adminForceLiquidate,
  adminRunTick,
  testSetPrice,
  testRunTick,
};
