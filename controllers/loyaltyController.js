const service = require("../services/loyalty/loyalty.service");
const referral = require("../services/loyalty/loyalty.referral");
const membership = require("../services/loyalty/loyalty.membership");
const redemption = require("../services/loyalty/loyalty.redemption");
const configSvc = require("../services/loyalty/loyalty.config");
const admin = require("../services/loyalty/loyalty.admin");
const engine = require("../services/loyalty/loyalty.engine");
const scheduler = require("../services/loyalty/loyalty.scheduler");
const businessClock = require("../services/businessClock");
const { LoyaltyError, toJsonSafe } = require("../services/loyalty/loyalty.errors");

function handleError(res, error, context) {
  if (error instanceof LoyaltyError) {
    return res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
      details: toJsonSafe(error.details),
    });
  }
  console.error(`[Loyalty] ${context} error:`, error);
  return res.status(500).json({ success: false, message: `Failed while ${context}`, error: error.message });
}

const wrap = (context, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (error) {
    handleError(res, error, context);
  }
};

function requireCoreId(req) {
  const coreId = req.user?.coreId;
  if (!coreId) throw new LoyaltyError("coreId not found in token", { status: 401, code: "UNAUTHORIZED" });
  return coreId;
}

// ---------------- Rewards ----------------

/** @route GET /api/rewards/summary */
const summary = wrap("loading rewards summary", async (req, res) => {
  const coreId = requireCoreId(req);
  res.json({ success: true, data: await service.summary(coreId, { now: await businessClock.current() }) });
});

/** @route GET /api/rewards/history?limit=&offset=&category=&state= */
const history = wrap("loading rewards history", async (req, res) => {
  const coreId = requireCoreId(req);
  res.json({ success: true, data: await service.history(coreId, req.query) });
});

/** @route GET /api/rewards/rules */
const rules = wrap("loading rewards rules", async (req, res) => {
  res.json({ success: true, data: await service.rules({ now: await businessClock.current() }) });
});

/** @route GET /api/rewards/:reward_id */
const rewardDetail = wrap("loading reward detail", async (req, res) => {
  const coreId = requireCoreId(req);
  res.json({ success: true, data: await service.rewardDetail(coreId, req.params.reward_id) });
});

/** @route POST /api/rewards/fee-quote  body: fee_code, gross_fee_idr, requested_vp? */
const feeQuote = wrap("quoting fee discount", async (req, res) => {
  const coreId = requireCoreId(req);
  const b = req.body || {};
  res.json({
    success: true,
    data: await redemption.feeQuote({ coreId, feeCode: b.fee_code, grossFeeIdr: b.gross_fee_idr, requestedVp: b.requested_vp, now: await businessClock.current() }),
  });
});

/**
 * @route POST /api/rewards/redeem
 * body: { target_type: "FEE_DISCOUNT"|"CATALOG", amount_vp?, fee_code?, gross_fee_idr?, sku?, target_id?, idempotency_key }
 * FEE_DISCOUNT -> RESERVED (produk/klien memanggil /commit atau /release)
 * CATALOG      -> COMMITTED (fulfillment oleh ops)
 */
const redeem = wrap("redeeming VP", async (req, res) => {
  const coreId = requireCoreId(req);
  const b = req.body || {};
  const now = await businessClock.current();
  let out;
  if (b.target_type === "CATALOG") {
    out = await redemption.redeemCatalog({ coreId, sku: String(b.sku || b.target_id || "").toUpperCase(), idempotencyKey: b.idempotency_key, now });
  } else {
    out = await redemption.reserve({
      coreId,
      amountVp: b.amount_vp,
      targetType: "FEE_DISCOUNT",
      targetId: b.target_id || null,
      feeCode: b.fee_code,
      quoteSnapshot: { gross_fee_idr: b.gross_fee_idr, fee_code: b.fee_code, quote_id: b.quote_id || null },
      idempotencyKey: b.idempotency_key,
      now,
    });
  }
  res.status(out.replay ? 200 : 201).json({ success: true, replay: out.replay, data: toJsonSafe(out.redemption) });
});

/** @route POST /api/rewards/redeem/:redemption_id/commit */
const commitRedemption = wrap("committing redemption", async (req, res) => {
  const coreId = requireCoreId(req);
  const out = await redemption.commit({ redemptionId: req.params.redemption_id, coreId, fulfillmentId: req.body?.fulfillment_id, now: await businessClock.current() });
  res.json({ success: true, replay: out.replay, data: toJsonSafe(out.redemption) });
});

/** @route POST /api/rewards/redeem/:redemption_id/release */
const releaseRedemption = wrap("releasing redemption", async (req, res) => {
  const coreId = requireCoreId(req);
  const out = await redemption.release({ redemptionId: req.params.redemption_id, coreId, reason: req.body?.reason, now: await businessClock.current() });
  res.json({ success: true, replay: out.replay, data: toJsonSafe(out.redemption) });
});

/** @route GET /api/rewards/catalog */
const catalog = wrap("loading catalog", async (req, res) => {
  res.json({ success: true, data: await redemption.catalog({ now: await businessClock.current() }) });
});

// ---------------- Referrals ----------------

/** @route GET /api/referrals/summary */
const referralSummary = wrap("loading referral summary", async (req, res) => {
  const coreId = requireCoreId(req);
  res.json({ success: true, data: await referral.summary(coreId, { now: await businessClock.current() }) });
});

/** @route POST /api/referrals/bind  body: code */
const bindReferral = wrap("binding referral code", async (req, res) => {
  const coreId = requireCoreId(req);
  const { link, created } = await referral.bind({ refereeCoreId: coreId, code: req.body?.code, now: await businessClock.current(), source: "POST_SIGNUP" });
  res.status(created ? 201 : 200).json({ success: true, data: toJsonSafe({ referrer_code: link.code, linked_at: link.linkedAt, created }) });
});

/** @route GET /api/referrals/validate?code= — preflight registrasi (public) */
const validateCode = wrap("validating referral code", async (req, res) => {
  const row = await referral.resolveCode(req.query.code);
  res.json({ success: true, data: { valid: Boolean(row), code: row?.code || null } });
});

/** @route POST /api/referrals/claims  body: idempotency_key  (Claim All) */
const claimAll = wrap("claiming referral cashback", async (req, res) => {
  const coreId = requireCoreId(req);
  const out = await referral.claimAll({ coreId, idempotencyKey: req.body?.idempotency_key, now: await businessClock.current() });
  res.status(out.replay ? 200 : 201).json({
    success: true,
    replay: out.replay,
    message: out.replay ? "Claim already processed (idempotent)." : "Referral cashback credited to your IDR wallet.",
    data: toJsonSafe({
      claim_id: out.claim.id,
      amount_idr: out.claim.amountIdr,
      state: out.claim.state,
      wallet_posting_id: out.claim.walletPostingId,
      claimed_at: out.claim.claimedAt,
    }),
  });
});

/** @route GET /api/referrals/claims */
const claimHistory = wrap("loading claim history", async (req, res) => {
  const coreId = requireCoreId(req);
  res.json({ success: true, data: await referral.claimHistory(coreId, { limit: Number(req.query.limit) || 50 }) });
});

// ---------------- Membership ----------------

/** @route GET /api/membership/status */
const membershipStatus = wrap("loading membership status", async (req, res) => {
  const coreId = requireCoreId(req);
  res.json({ success: true, data: toJsonSafe(await membership.status(coreId, { now: await businessClock.current() })) });
});

/** @route POST /api/membership/refresh — snapshot saldo + recompute tier (rate-limited di route) */
const membershipRefresh = wrap("refreshing membership", async (req, res) => {
  const coreId = requireCoreId(req);
  const now = await businessClock.current();
  const rec = await membership.recordBalanceEvent(coreId, { now, reason: "USER_REFRESH" });
  const tier = await membership.refreshTier(coreId, { now });
  res.json({ success: true, data: toJsonSafe({ recorded: rec.recorded, reason: rec.reason || null, ...tier }) });
});

// ---------------- Admin ----------------

const adminDashboard = wrap("loading admin dashboard", async (req, res) => {
  res.json({ success: true, data: await admin.dashboard({ now: await businessClock.current() }) });
});
const adminConfigList = wrap("listing config versions", async (req, res) => {
  res.json({ success: true, data: toJsonSafe(await configSvc.listVersions()) });
});
const adminConfigActive = wrap("loading active config", async (req, res) => {
  const r = await configSvc.resolve(await businessClock.current());
  res.json({ success: true, data: { version: r.version, effective_at: r.row?.effectiveAt, status: r.row?.status, config: r.config } });
});
/** body: { patch, note, ticket_ref, actor, base_version? } */
const adminConfigDraft = wrap("creating config draft", async (req, res) => {
  const b = req.body || {};
  const row = await configSvc.createDraft({ patch: b.patch, note: b.note, createdBy: b.actor, ticketRef: b.ticket_ref, baseVersion: b.base_version });
  res.status(201).json({ success: true, data: toJsonSafe(row) });
});
/** body: { action: submit|approve|schedule|reject|rollback, actor, effective_at? } */
const adminConfigTransition = wrap("transitioning config", async (req, res) => {
  const b = req.body || {};
  const row = await configSvc.transition({ version: Number(req.params.version), action: b.action, actor: b.actor, effectiveAt: b.effective_at });
  res.json({ success: true, data: toJsonSafe(row) });
});
const adminReverse = wrap("reversing grant", async (req, res) => {
  const b = req.body || {};
  const g = await admin.reverseGrant({ grantId: req.params.grant_id, reason: b.reason, evidence: b.evidence, actor: b.actor, now: await businessClock.current() });
  res.json({ success: true, data: toJsonSafe(g) });
});
const adminFailedEvents = wrap("listing failed events", async (req, res) => {
  res.json({ success: true, data: toJsonSafe(await admin.failedEvents({ limit: Number(req.query.limit) || 100 })) });
});
const adminCatalogUpsert = wrap("upserting catalog item", async (req, res) => {
  res.json({ success: true, data: toJsonSafe(await admin.upsertCatalogItem(req.body || {})) });
});
const adminCustomer = wrap("loading customer", async (req, res) => {
  res.json({ success: true, data: await admin.customerView(req.params.core_id) });
});
/** Ingest event manual (QA / replay dari product service). body = envelope */
const adminIngest = wrap("ingesting event", async (req, res) => {
  const out = await engine.ingest(req.body || {});
  res.status(out.status === "FAILED" ? 422 : 200).json({ success: out.status !== "FAILED", data: toJsonSafe(out) });
});
const adminTick = wrap("running loyalty tick", async (req, res) => {
  res.json({ success: true, data: toJsonSafe(await scheduler.tick(await businessClock.current())) });
});

module.exports = {
  summary,
  history,
  rules,
  rewardDetail,
  feeQuote,
  redeem,
  commitRedemption,
  releaseRedemption,
  catalog,
  referralSummary,
  bindReferral,
  validateCode,
  claimAll,
  claimHistory,
  membershipStatus,
  membershipRefresh,
  adminDashboard,
  adminConfigList,
  adminConfigActive,
  adminConfigDraft,
  adminConfigTransition,
  adminReverse,
  adminFailedEvents,
  adminCatalogUpsert,
  adminCustomer,
  adminIngest,
  adminTick,
};
