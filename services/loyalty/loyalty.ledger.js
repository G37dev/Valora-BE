/*
 * Reward ledger (brief 10): grant = entitlement; jurnal = append-only.
 * Balance SELALU proyeksi dari jurnal (SUM delta per bucket), bukan kolom
 * balance yang di-update langsung. Semua fungsi WAJIB dalam transaction.
 */

const { Op, fn, col } = require("sequelize");
const {
  sequelize,
  User,
  LoyaltyCustomer,
  LoyaltyRewardGrant,
  LoyaltyVpJournal,
  LoyaltyReferralIdrJournal,
  LoyaltyBudgetLedger,
} = require("../../models");
const {
  VP_STATE,
  IDR_STATE,
  BUCKET,
  ACQUISITION_CATEGORIES,
} = require("./loyalty.constants");
const { LoyaltyError, big } = require("./loyalty.errors");

// ---------------------------------------------------------------------------
// Customer enrollment
// ---------------------------------------------------------------------------

async function ensureCustomer(coreId, { now = new Date(), transaction, lock = false } = {}) {
  let row = await LoyaltyCustomer.findByPk(coreId, {
    transaction,
    lock: lock && transaction ? transaction.LOCK.UPDATE : undefined,
  });
  if (row) return row;
  const user = await User.findByPk(coreId, { transaction });
  const accountCreatedAt = user?.createdAt ? new Date(user.createdAt) : now;
  try {
    row = await LoyaltyCustomer.create(
      { coreId, enrolledAt: now, accountCreatedAt, historyStartAt: null },
      { transaction },
    );
  } catch (error) {
    // race: sudah dibuat request lain
    row = await LoyaltyCustomer.findByPk(coreId, {
      transaction,
      lock: lock && transaction ? transaction.LOCK.UPDATE : undefined,
    });
    if (!row) throw error;
  }
  return row;
}

// ---------------------------------------------------------------------------
// Journal helpers
// ---------------------------------------------------------------------------

async function postVp({ coreId, grantId, redemptionId, bucket, deltaVp, reasonCode, idempotencyKey, metadata }, transaction) {
  const [row] = await LoyaltyVpJournal.findOrCreate({
    where: { idempotencyKey },
    defaults: {
      coreId,
      grantId: grantId || null,
      redemptionId: redemptionId || null,
      bucket,
      deltaVp: deltaVp.toString(),
      reasonCode,
      idempotencyKey,
      metadata: metadata || null,
    },
    transaction,
  });
  return row;
}

async function postIdr({ coreId, grantId, linkId, claimId, sourcePositionRef, bucket, deltaIdr, reasonCode, idempotencyKey, metadata }, transaction) {
  const [row] = await LoyaltyReferralIdrJournal.findOrCreate({
    where: { idempotencyKey },
    defaults: {
      coreId,
      grantId: grantId || null,
      linkId: linkId || null,
      claimId: claimId || null,
      sourcePositionRef: sourcePositionRef || null,
      bucket,
      deltaIdr: deltaIdr.toString(),
      reasonCode,
      idempotencyKey,
      metadata: metadata || null,
    },
    transaction,
  });
  return row;
}

async function sumBuckets(Model, coreId, deltaCol, transaction) {
  const rows = await Model.findAll({
    attributes: ["bucket", [fn("COALESCE", fn("SUM", col(deltaCol)), 0), "total"]],
    where: { coreId },
    group: ["bucket"],
    raw: true,
    transaction,
  });
  const out = {};
  for (const r of rows) out[r.bucket] = big(r.total);
  return out;
}

/** Proyeksi saldo VP dari jurnal. */
async function vpBalances(coreId, { transaction } = {}) {
  const s = await sumBuckets(LoyaltyVpJournal, coreId, "delta_vp", transaction);
  return {
    pending: s[BUCKET.PENDING] || 0n,
    available: s[BUCKET.AVAILABLE] || 0n,
    reserved: s[BUCKET.RESERVED] || 0n,
    redeemed: s[BUCKET.REDEEMED] || 0n,
  };
}

/** Proyeksi referral IDR dari jurnal. */
async function idrBalances(coreId, { transaction } = {}) {
  const s = await sumBuckets(LoyaltyReferralIdrJournal, coreId, "delta_idr", transaction);
  return {
    pending: s[BUCKET.PENDING] || 0n,
    claimable: s[BUCKET.CLAIMABLE] || 0n,
    claimed: s[BUCKET.CLAIMED] || 0n,
  };
}

// ---------------------------------------------------------------------------
// Budget ledger (brief 10.3 / 11.3) — pelaporan, bukan pemotong reward
// ---------------------------------------------------------------------------

function monthKeyUtc(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function budgetApply(grant, { committedDelta = 0n, consumedDelta = 0n, config, configVersion }, transaction) {
  const pool = ACQUISITION_CATEGORIES.includes(grant.category) ? "ACQUISITION" : "TRANSACTION";
  const campaignId = `${pool}:${monthKeyUtc(new Date(grant.occurredAt))}`;
  const ceiling =
    pool === "ACQUISITION"
      ? config?.budgets?.acquisition_budget_monthly_idr
      : config?.budgets?.campaign_ceiling_idr;
  const [row] = await LoyaltyBudgetLedger.findOrCreate({
    where: { campaignId },
    defaults: {
      campaignId,
      budgetCeilingIdr: ceiling ?? null,
      approvedConfigVersion: configVersion ?? null,
    },
    transaction,
  });
  const committed = big(row.committedIdrEq) + committedDelta;
  const consumed = big(row.consumedIdrEq) + consumedDelta;
  await row.update(
    { committedIdrEq: committed.toString(), consumedIdrEq: consumed.toString() },
    { transaction },
  );
  if (row.budgetCeilingIdr != null && committed > big(row.budgetCeilingIdr)) {
    console.warn(
      `[Loyalty] BUDGET ALERT ${campaignId}: committed ${committed} > ceiling ${row.budgetCeilingIdr}`,
    );
  }
}

// ---------------------------------------------------------------------------
// VP grants
// ---------------------------------------------------------------------------

/**
 * Buat VP grant exactly-once by businessKey.
 * immediate=true -> langsung AVAILABLE; else PENDING (+availableAt opsional).
 * Return { grant, created }.
 */
async function createVpGrant(input, transaction) {
  const {
    coreId, category, businessKey, vpAmount, immediate = false, availableAt = null,
    availabilityTrigger, now, config, configVersion, configVersionId, ...rest
  } = input;
  const vp = big(vpAmount);
  const existing = await LoyaltyRewardGrant.findOne({ where: { businessKey }, transaction });
  if (existing) return { grant: existing, created: false };

  const state = immediate ? VP_STATE.AVAILABLE : VP_STATE.PENDING;
  const grant = await LoyaltyRewardGrant.create(
    {
      coreId,
      category,
      unit: "VP",
      businessKey,
      state,
      vpAmount: vp.toString(),
      idrAmount: 0,
      availableAt,
      availabilityTrigger: availabilityTrigger || (immediate ? "IMMEDIATE" : availableAt ? "HOLD_EXPIRY" : "POSITION_SETTLED"),
      vestedAt: immediate ? now : null,
      occurredAt: now,
      configVersion: configVersion ?? null,
      configVersionId: configVersionId ?? null,
      ...rest,
    },
    { transaction },
  );
  if (vp > 0n) {
    await postVp(
      {
        coreId,
        grantId: grant.id,
        bucket: immediate ? BUCKET.AVAILABLE : BUCKET.PENDING,
        deltaVp: vp,
        reasonCode: `${category}_GRANT`,
        idempotencyKey: `grant:${grant.id}:${immediate ? "available" : "pending"}`,
      },
      transaction,
    );
  }
  await budgetApply(grant, { committedDelta: vp, consumedDelta: immediate ? vp : 0n, config, configVersion }, transaction);
  return { grant, created: true };
}

/** PENDING -> AVAILABLE (vesting). Idempotent. */
async function vestGrant(grant, { now, trigger, config }, transaction) {
  if (grant.state !== VP_STATE.PENDING) return grant;
  const vp = big(grant.vpAmount);
  await postVp(
    { coreId: grant.coreId, grantId: grant.id, bucket: BUCKET.PENDING, deltaVp: -vp, reasonCode: `${grant.category}_VEST`, idempotencyKey: `grant:${grant.id}:vest:pending` },
    transaction,
  );
  await postVp(
    { coreId: grant.coreId, grantId: grant.id, bucket: BUCKET.AVAILABLE, deltaVp: vp, reasonCode: `${grant.category}_VEST`, idempotencyKey: `grant:${grant.id}:vest:available` },
    transaction,
  );
  await grant.update(
    { state: VP_STATE.AVAILABLE, vestedAt: now, availabilityTrigger: trigger || grant.availabilityTrigger },
    { transaction },
  );
  await budgetApply(grant, { consumedDelta: vp, config, configVersion: grant.configVersion }, transaction);
  return grant;
}

/** PENDING -> VOID. Idempotent. */
async function voidGrant(grant, { now, reason, config }, transaction) {
  if (grant.state !== VP_STATE.PENDING) return grant;
  const vp = big(grant.vpAmount);
  await postVp(
    { coreId: grant.coreId, grantId: grant.id, bucket: BUCKET.PENDING, deltaVp: -vp, reasonCode: `${grant.category}_VOID`, idempotencyKey: `grant:${grant.id}:void`, metadata: { reason } },
    transaction,
  );
  await grant.update({ state: VP_STATE.VOID, voidedAt: now, voidReason: reason }, { transaction });
  await budgetApply(grant, { committedDelta: -vp, config, configVersion: grant.configVersion }, transaction);
  return grant;
}

/**
 * Reversal setelah AVAILABLE (fraud / deposit reversal yang terkonfirmasi
 * setelah vesting): adjustment negatif eksplisit, bukan hapus grant.
 */
async function reverseGrant(grant, { now, reason, config }, transaction) {
  if (grant.state !== VP_STATE.AVAILABLE) return grant;
  const vp = big(grant.vpAmount);
  await postVp(
    { coreId: grant.coreId, grantId: grant.id, bucket: BUCKET.AVAILABLE, deltaVp: -vp, reasonCode: `${grant.category}_REVERSE`, idempotencyKey: `grant:${grant.id}:reverse`, metadata: { reason } },
    transaction,
  );
  await grant.update({ state: VP_STATE.REVERSED, voidedAt: now, voidReason: reason }, { transaction });
  await budgetApply(grant, { committedDelta: -vp, consumedDelta: -vp, config, configVersion: grant.configVersion }, transaction);
  return grant;
}

// ---------------------------------------------------------------------------
// Referral IDR grants (referrer A)
// ---------------------------------------------------------------------------

async function createIdrGrant(input, transaction) {
  const {
    coreId, category, businessKey, idrAmount, claimable = false, availableAt = null,
    linkId, now, config, configVersion, configVersionId, ...rest
  } = input;
  const idr = big(idrAmount);
  const existing = await LoyaltyRewardGrant.findOne({ where: { businessKey }, transaction });
  if (existing) return { grant: existing, created: false };
  const grant = await LoyaltyRewardGrant.create(
    {
      coreId,
      category,
      unit: "IDR",
      businessKey,
      state: claimable ? IDR_STATE.CLAIMABLE : IDR_STATE.PENDING,
      vpAmount: 0,
      idrAmount: idr.toString(),
      availableAt,
      availabilityTrigger: claimable ? "IMMEDIATE" : availableAt ? "HOLD_EXPIRY" : "POSITION_SETTLED",
      vestedAt: claimable ? now : null,
      occurredAt: now,
      configVersion: configVersion ?? null,
      configVersionId: configVersionId ?? null,
      metadata: { ...(rest.metadata || {}), link_id: linkId || null },
      ...rest,
    },
    { transaction },
  );
  if (idr > 0n) {
    await postIdr(
      {
        coreId,
        grantId: grant.id,
        linkId,
        sourcePositionRef: rest.positionRef,
        bucket: claimable ? BUCKET.CLAIMABLE : BUCKET.PENDING,
        deltaIdr: idr,
        reasonCode: `${category}_GRANT`,
        idempotencyKey: `grant:${grant.id}:${claimable ? "claimable" : "pending"}`,
      },
      transaction,
    );
  }
  await budgetApply(grant, { committedDelta: idr, consumedDelta: claimable ? idr : 0n, config, configVersion }, transaction);
  return { grant, created: true };
}

async function makeClaimable(grant, { now, trigger, config }, transaction) {
  if (grant.state !== IDR_STATE.PENDING) return grant;
  const idr = big(grant.idrAmount);
  const linkId = grant.metadata?.link_id || null;
  await postIdr(
    { coreId: grant.coreId, grantId: grant.id, linkId, bucket: BUCKET.PENDING, deltaIdr: -idr, reasonCode: `${grant.category}_CLAIMABLE`, idempotencyKey: `grant:${grant.id}:claimable:pending` },
    transaction,
  );
  await postIdr(
    { coreId: grant.coreId, grantId: grant.id, linkId, bucket: BUCKET.CLAIMABLE, deltaIdr: idr, reasonCode: `${grant.category}_CLAIMABLE`, idempotencyKey: `grant:${grant.id}:claimable:claimable` },
    transaction,
  );
  await grant.update(
    { state: IDR_STATE.CLAIMABLE, vestedAt: now, availabilityTrigger: trigger || grant.availabilityTrigger },
    { transaction },
  );
  await budgetApply(grant, { consumedDelta: idr, config, configVersion: grant.configVersion }, transaction);
  return grant;
}

async function voidIdrGrant(grant, { now, reason, config }, transaction) {
  if (grant.state !== IDR_STATE.PENDING) return grant;
  const idr = big(grant.idrAmount);
  await postIdr(
    { coreId: grant.coreId, grantId: grant.id, linkId: grant.metadata?.link_id || null, bucket: BUCKET.PENDING, deltaIdr: -idr, reasonCode: `${grant.category}_VOID`, idempotencyKey: `grant:${grant.id}:void`, metadata: { reason } },
    transaction,
  );
  await grant.update({ state: IDR_STATE.VOID, voidedAt: now, voidReason: reason }, { transaction });
  await budgetApply(grant, { committedDelta: -idr, config, configVersion: grant.configVersion }, transaction);
  return grant;
}

/** Semua grant PENDING milik satu posisi (untuk vest/void saat settle/fail). */
async function pendingGrantsForPosition(positionRef, transaction) {
  return LoyaltyRewardGrant.findAll({
    where: {
      positionRef,
      state: { [Op.in]: [VP_STATE.PENDING, IDR_STATE.PENDING] },
    },
    transaction,
    lock: transaction ? transaction.LOCK.UPDATE : undefined,
  });
}

module.exports = {
  ensureCustomer,
  postVp,
  postIdr,
  vpBalances,
  idrBalances,
  createVpGrant,
  vestGrant,
  voidGrant,
  reverseGrant,
  createIdrGrant,
  makeClaimable,
  voidIdrGrant,
  pendingGrantsForPosition,
  budgetApply,
  sequelize,
  LoyaltyError,
};
