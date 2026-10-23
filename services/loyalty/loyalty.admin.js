/*
 * Admin / Finance (brief 10.3, 11): liabilities dashboard, budget ledger,
 * reversal queue (auditable), catalog CRUD, emergency pause via config.
 */

const { Op, fn, col } = require("sequelize");
const {
  sequelize,
  LoyaltyRewardGrant,
  LoyaltyVpJournal,
  LoyaltyReferralIdrJournal,
  LoyaltyBudgetLedger,
  LoyaltyProcessedEvent,
  LoyaltyCatalogItem,
  LoyaltyCustomer,
  LoyaltyRewardClaim,
} = require("../../models");
const configSvc = require("./loyalty.config");
const ledger = require("./loyalty.ledger");
const engine = require("./loyalty.engine");
const { LoyaltyError, big, toJsonSafe } = require("./loyalty.errors");
const { ACQUISITION_CATEGORIES } = require("./loyalty.constants");

async function sumBy(Model, deltaCol, groupCol) {
  const rows = await Model.findAll({
    attributes: [groupCol, [fn("COALESCE", fn("SUM", col(deltaCol)), 0), "total"]],
    group: [groupCol],
    raw: true,
  });
  return Object.fromEntries(rows.map((r) => [r[groupCol], big(r.total)]));
}

async function dashboard({ now = new Date() } = {}) {
  const resolved = await configSvc.resolve(now);
  const vp = await sumBy(LoyaltyVpJournal, "delta_vp", "bucket");
  const idr = await sumBy(LoyaltyReferralIdrJournal, "delta_idr", "bucket");
  const grantsByCat = await LoyaltyRewardGrant.findAll({
    attributes: ["category", "state", [fn("COUNT", col("id")), "n"], [fn("COALESCE", fn("SUM", col("vp_amount")), 0), "vp"], [fn("COALESCE", fn("SUM", col("idr_amount")), 0), "idr"]],
    group: ["category", "state"],
    raw: true,
  });
  const budgets = await LoyaltyBudgetLedger.findAll({ order: [["campaign_id", "DESC"]], limit: 24 });
  const failed = await LoyaltyProcessedEvent.count({ where: { processingStatus: "FAILED" } });
  const customers = await LoyaltyCustomer.count();
  const tiers = await LoyaltyCustomer.findAll({ attributes: ["currentTier", [fn("COUNT", col("core_id")), "n"]], group: ["currentTier"], raw: true });

  // Guardrail proxy: transaction rewards bulan ini vs net fee eligible (brief 11.3)
  const monthKey = engine.monthKey(now, resolved.config.monthly.period_timezone);
  const tx = budgets.find((b) => b.campaignId === `TRANSACTION:${monthKey}`);
  const netFeeMonth = await LoyaltyRewardGrant.sum("feeNetIdr", {
    where: { category: "REGULAR", occurredAt: { [Op.gte]: new Date(`${monthKey}-01T00:00:00Z`) } },
  });
  const rewardMonth = tx ? big(tx.committedIdrEq) : 0n;
  const netFee = big(netFeeMonth || 0);

  return toJsonSafe({
    as_of: now,
    config_version: resolved.version,
    paused: { issuance: Boolean(resolved.config.budgets.pause_issuance), redemption: Boolean(resolved.config.budgets.pause_redemption) },
    customers,
    tiers: Object.fromEntries(tiers.map((t) => [t.currentTier, Number(t.n)])),
    liabilities: {
      vp_pending: vp.PENDING || 0n,
      vp_available: vp.AVAILABLE || 0n,
      vp_reserved: vp.RESERVED || 0n,
      vp_redeemed_to_date: vp.REDEEMED || 0n,
      estimated_redemption_cost_idr: ((vp.AVAILABLE || 0n) + (vp.RESERVED || 0n) + (vp.PENDING || 0n)) * BigInt(resolved.config.redemption.vp_idr_value || 1),
      referral_idr_pending: idr.PENDING || 0n,
      referral_idr_claimable: idr.CLAIMABLE || 0n,
      referral_idr_claimed_to_date: idr.CLAIMED || 0n,
    },
    grants: grantsByCat.map((g) => ({ category: g.category, pool: ACQUISITION_CATEGORIES.includes(g.category) ? "ACQUISITION" : "TRANSACTION", state: g.state, count: Number(g.n), vp: big(g.vp), idr: big(g.idr) })),
    budgets: budgets.map((b) => ({ campaign_id: b.campaignId, ceiling_idr: b.budgetCeilingIdr, committed_idr_eq: b.committedIdrEq, consumed_idr_eq: b.consumedIdrEq, status: b.status })),
    guardrail: {
      month: monthKey,
      transaction_rewards_idr_eq: rewardMonth,
      eligible_net_fee_idr: netFee,
      ratio_bps: netFee > 0n ? Number((rewardMonth * 10000n) / netFee) : null,
      guardrail_bps: resolved.config.budgets.transaction_reward_guardrail_bps,
      note: "Rasio terhadap net fee adalah proxy; guardrail resmi diuji terhadap eligible contribution (Finance).",
    },
    failed_events: failed,
  });
}

/** Reversal/void manual dengan reason code + evidence (fraud/remediasi). */
async function reverseGrant({ grantId, reason, evidence, actor, now = new Date() }) {
  if (!reason) throw new LoyaltyError("reason wajib", { code: "REASON_REQUIRED" });
  const { config } = await configSvc.resolve(now);
  return sequelize.transaction(async (t) => {
    const g = await LoyaltyRewardGrant.findByPk(grantId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!g) throw new LoyaltyError("Grant tidak ditemukan", { status: 404, code: "GRANT_NOT_FOUND" });
    const audit = { ...(g.metadata || {}), admin_reversal: { reason, evidence: evidence || null, actor: actor || null, at: now, previous_state: g.state } };
    if (g.unit === "VP") {
      if (g.state === "PENDING") await ledger.voidGrant(g, { now, reason: `ADMIN:${reason}`, config }, t);
      else if (g.state === "AVAILABLE") await ledger.reverseGrant(g, { now, reason: `ADMIN:${reason}`, config }, t);
      else throw new LoyaltyError(`Grant VP state ${g.state} tidak bisa di-reverse`, { status: 409, code: "GRANT_STATE" });
    } else if (g.state === "PENDING") {
      await ledger.voidIdrGrant(g, { now, reason: `ADMIN:${reason}`, config }, t);
    } else if (g.state === "CLAIMABLE") {
      const amt = big(g.idrAmount);
      await ledger.postIdr({ coreId: g.coreId, grantId: g.id, linkId: g.metadata?.link_id || null, bucket: "CLAIMABLE", deltaIdr: -amt, reasonCode: "REFERRAL_ADMIN_VOID", idempotencyKey: `grant:${g.id}:admin-void`, metadata: { reason } }, t);
      await g.update({ state: "VOID", voidedAt: now, voidReason: `ADMIN:${reason}` }, { transaction: t });
      await ledger.budgetApply(g, { committedDelta: -amt, consumedDelta: -amt, config, configVersion: g.configVersion }, t);
    } else {
      throw new LoyaltyError("IDR yang sudah CLAIMED butuh finance adjustment terpisah (tidak auto-debit wallet)", { status: 409, code: "CLAIMED_NEEDS_FINANCE" });
    }
    await g.update({ metadata: audit }, { transaction: t });
    return g;
  });
}

async function failedEvents({ limit = 100 } = {}) {
  return LoyaltyProcessedEvent.findAll({ where: { processingStatus: "FAILED" }, order: [["updated_at", "DESC"]], limit });
}

async function upsertCatalogItem(input) {
  const required = ["sku", "title", "vp_price"];
  for (const f of required) if (input[f] === undefined) throw new LoyaltyError(`${f} wajib`, { code: "CATALOG_INVALID" });
  const [item] = await LoyaltyCatalogItem.upsert({
    sku: String(input.sku).toUpperCase(),
    title: input.title,
    description: input.description || null,
    vpPrice: big(input.vp_price).toString(),
    rewardType: input.reward_type || "ASSET",
    rewardAsset: input.reward_asset || null,
    rewardAmount: input.reward_amount ?? null,
    stock: input.stock ?? null,
    perUserLimit: input.per_user_limit ?? null,
    active: input.active !== false,
    startsAt: input.starts_at || null,
    endsAt: input.ends_at || null,
    metadata: input.metadata || null,
  });
  return item;
}

async function customerView(coreId) {
  const cust = await LoyaltyCustomer.findByPk(coreId);
  if (!cust) throw new LoyaltyError("Customer belum enrolled", { status: 404, code: "NOT_ENROLLED" });
  const grants = await LoyaltyRewardGrant.findAll({ where: { coreId }, order: [["occurred_at", "DESC"]] });
  const claims = await LoyaltyRewardClaim.findAll({ where: { coreId }, order: [["created_at", "DESC"]] });
  return toJsonSafe({ customer: cust, vp: await ledger.vpBalances(coreId), referral_idr: await ledger.idrBalances(coreId), grants, claims });
}

module.exports = { dashboard, reverseGrant, failedEvents, upsertCatalogItem, customerView };
