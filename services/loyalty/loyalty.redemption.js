/*
 * VP Redemption (brief 09): fee discount (1 VP = Rp1, cap 40% eligible
 * platform fee, semua tier) + Reward Catalog (SKU, harga VP dikonfigurasi).
 *
 * Alur: quote -> reserve (AVAILABLE -> RESERVED) -> commit (RESERVED ->
 * REDEEMED) | release (RESERVED -> AVAILABLE). Reservasi kadaluarsa
 * dilepas scheduler. Semua langkah idempotent by idempotency_key.
 */

const crypto = require("crypto");
const { Op } = require("sequelize");
const {
  sequelize,
  LoyaltyRewardRedemption,
  LoyaltyCatalogItem,
} = require("../../models");
const configSvc = require("./loyalty.config");
const ledger = require("./loyalty.ledger");
const { LoyaltyError, big, min, applyBps, toJsonSafe } = require("./loyalty.errors");
const { BUCKET } = require("./loyalty.constants");

function assertRedemptionEnabled(config) {
  if (config.redemption?.enabled === false || config.budgets?.pause_redemption) {
    throw new LoyaltyError("Redemption sedang dijeda", { status: 423, code: "REDEMPTION_PAUSED" });
  }
}

/**
 * Preview diskon fee. gross_fee_idr = eligible platform fee (dari produk).
 * MaxVPFeeDiscountIDR = FLOOR(fee x 40%); RedeemedVP = MIN(available, max, requested)
 */
async function feeQuote({ coreId, feeCode, grossFeeIdr, requestedVp, now = new Date() }) {
  const { config, version } = await configSvc.resolve(now);
  const red = config.redemption;
  if (!(red.eligible_fee_codes || []).includes(feeCode)) {
    throw new LoyaltyError(`Fee ${feeCode} tidak eligible untuk diskon VP`, { code: "FEE_NOT_ELIGIBLE" });
  }
  const gross = big(grossFeeIdr);
  if (gross <= 0n) throw new LoyaltyError("gross_fee_idr harus > 0", { code: "INVALID_AMOUNT" });
  const balances = await ledger.vpBalances(coreId);
  const maxDiscount = applyBps(gross, red.global_fee_discount_cap_bps);
  const requested = requestedVp === undefined || requestedVp === null ? maxDiscount : big(requestedVp);
  const redeem = min(min(balances.available, maxDiscount), requested);
  const quote = {
    quote_id: crypto.randomUUID(),
    fee_code: feeCode,
    gross_fee_idr: gross,
    cap_bps: red.global_fee_discount_cap_bps,
    max_discount_idr: maxDiscount,
    vp_available: balances.available,
    requested_vp: requested,
    redeem_vp: redeem,
    discount_idr: redeem * BigInt(red.vp_idr_value || 1),
    fee_payable_idr: gross - redeem * BigInt(red.vp_idr_value || 1),
    external_costs_note: "Network/relayer/gateway costs dibayar terpisah, tidak didiskon VP",
    expires_at: new Date(now.getTime() + Number(red.quote_ttl_seconds || 120) * 1000),
    config_version: version,
  };
  return toJsonSafe(quote);
}

/** Reserve VP (AVAILABLE -> RESERVED). Idempotent. */
async function reserve({ coreId, amountVp, targetType, targetId, feeCode, quoteSnapshot, idempotencyKey, now = new Date() }) {
  if (!idempotencyKey || String(idempotencyKey).length < 8) {
    throw new LoyaltyError("idempotency_key wajib (min 8 karakter)", { code: "IDEMPOTENCY_KEY_REQUIRED" });
  }
  const key = `${coreId}:${idempotencyKey}`;
  const { config } = await configSvc.resolve(now);
  assertRedemptionEnabled(config);
  const amount = big(amountVp);
  if (amount <= 0n) throw new LoyaltyError("amount_vp harus > 0", { code: "INVALID_AMOUNT" });

  return sequelize.transaction(async (t) => {
    const prior = await LoyaltyRewardRedemption.findOne({ where: { idempotencyKey: key }, transaction: t });
    if (prior) return { redemption: prior, replay: true };
    await ledger.ensureCustomer(coreId, { now, transaction: t, lock: true });
    const balances = await ledger.vpBalances(coreId, { transaction: t });
    if (balances.available < amount) {
      throw new LoyaltyError("VP available tidak mencukupi", {
        status: 402,
        code: "INSUFFICIENT_VP",
        details: { available: balances.available, requested: amount },
      });
    }
    if (targetType === "FEE_DISCOUNT") {
      const gross = big(quoteSnapshot?.gross_fee_idr || 0);
      const maxDiscount = applyBps(gross, config.redemption.global_fee_discount_cap_bps);
      if (gross <= 0n || amount > maxDiscount) {
        throw new LoyaltyError("Melebihi batas diskon 40% eligible platform fee", {
          code: "DISCOUNT_CAP_EXCEEDED",
          details: { max_discount_idr: maxDiscount, requested_vp: amount },
        });
      }
    }
    const redemption = await LoyaltyRewardRedemption.create(
      {
        coreId,
        amountVp: amount.toString(),
        targetType,
        targetId: targetId || null,
        feeCode: feeCode || null,
        quoteSnapshot: toJsonSafe(quoteSnapshot || null),
        state: "RESERVED",
        idempotencyKey: key,
        expiresAt: new Date(now.getTime() + Number(config.redemption.reservation_ttl_seconds || 900) * 1000),
      },
      { transaction: t },
    );
    await ledger.postVp(
      { coreId, redemptionId: redemption.id, bucket: BUCKET.AVAILABLE, deltaVp: -amount, reasonCode: "REDEMPTION_RESERVE", idempotencyKey: `redemption:${redemption.id}:reserve:available` },
      t,
    );
    await ledger.postVp(
      { coreId, redemptionId: redemption.id, bucket: BUCKET.RESERVED, deltaVp: amount, reasonCode: "REDEMPTION_RESERVE", idempotencyKey: `redemption:${redemption.id}:reserve:reserved` },
      t,
    );
    return { redemption, replay: false };
  });
}

async function lockRedemption(id, coreId, t) {
  const r = await LoyaltyRewardRedemption.findOne({
    where: coreId ? { id, coreId } : { id },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!r) throw new LoyaltyError("Redemption tidak ditemukan", { status: 404, code: "REDEMPTION_NOT_FOUND" });
  return r;
}

/** RESERVED -> COMMITTED (VP REDEEMED). Idempotent. */
async function commit({ redemptionId, coreId, fulfillmentId, now = new Date() }) {
  return sequelize.transaction(async (t) => {
    const r = await lockRedemption(redemptionId, coreId, t);
    if (r.state === "COMMITTED") return { redemption: r, replay: true };
    if (r.state !== "RESERVED") {
      throw new LoyaltyError(`Redemption dalam state ${r.state}`, { status: 409, code: "REDEMPTION_STATE" });
    }
    const amount = big(r.amountVp);
    await ledger.postVp(
      { coreId: r.coreId, redemptionId: r.id, bucket: BUCKET.RESERVED, deltaVp: -amount, reasonCode: "REDEMPTION_COMMIT", idempotencyKey: `redemption:${r.id}:commit:reserved` },
      t,
    );
    await ledger.postVp(
      { coreId: r.coreId, redemptionId: r.id, bucket: BUCKET.REDEEMED, deltaVp: amount, reasonCode: "REDEMPTION_COMMIT", idempotencyKey: `redemption:${r.id}:commit:redeemed` },
      t,
    );
    await r.update(
      { state: "COMMITTED", committedAt: now, fulfillmentId: fulfillmentId || r.fulfillmentId, fulfillmentState: r.targetType === "CATALOG" ? "PENDING_FULFILLMENT" : "APPLIED" },
      { transaction: t },
    );
    return { redemption: r, replay: false };
  });
}

/** RESERVED -> RELEASED (VP kembali AVAILABLE). Idempotent. */
async function release({ redemptionId, coreId, reason, now = new Date() }) {
  return sequelize.transaction(async (t) => {
    const r = await lockRedemption(redemptionId, coreId, t);
    if (r.state === "RELEASED") return { redemption: r, replay: true };
    if (r.state !== "RESERVED") {
      throw new LoyaltyError(`Redemption dalam state ${r.state}`, { status: 409, code: "REDEMPTION_STATE" });
    }
    const amount = big(r.amountVp);
    await ledger.postVp(
      { coreId: r.coreId, redemptionId: r.id, bucket: BUCKET.RESERVED, deltaVp: -amount, reasonCode: "REDEMPTION_RELEASE", idempotencyKey: `redemption:${r.id}:release:reserved`, metadata: { reason } },
      t,
    );
    await ledger.postVp(
      { coreId: r.coreId, redemptionId: r.id, bucket: BUCKET.AVAILABLE, deltaVp: amount, reasonCode: "REDEMPTION_RELEASE", idempotencyKey: `redemption:${r.id}:release:available` },
      t,
    );
    await r.update({ state: "RELEASED", releasedAt: now, metadata: { ...(r.metadata || {}), release_reason: reason || null } }, { transaction: t });
    return { redemption: r, replay: false };
  });
}

/** Scheduler: lepas reservasi kadaluarsa. */
async function releaseExpired(now = new Date()) {
  const rows = await LoyaltyRewardRedemption.findAll({
    where: { state: "RESERVED", expiresAt: { [Op.lt]: now } },
    limit: 200,
  });
  let n = 0;
  for (const r of rows) {
    await release({ redemptionId: r.id, reason: "EXPIRED", now }).then(() => n++).catch(() => {});
  }
  return n;
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

async function catalog({ now = new Date() } = {}) {
  const { config } = await configSvc.resolve(now);
  if (config.redemption?.catalog_enabled === false) return [];
  const items = await LoyaltyCatalogItem.findAll({
    where: {
      active: true,
      [Op.and]: [
        { [Op.or]: [{ startsAt: null }, { startsAt: { [Op.lte]: now } }] },
        { [Op.or]: [{ endsAt: null }, { endsAt: { [Op.gte]: now } }] },
      ],
    },
    order: [["vp_price", "ASC"]],
  });
  return items.map((i) =>
    toJsonSafe({
      sku: i.sku,
      title: i.title,
      description: i.description,
      vp_price: i.vpPrice,
      reward_type: i.rewardType,
      reward_asset: i.rewardAsset,
      reward_amount: i.rewardAmount,
      stock: i.stock,
      per_user_limit: i.perUserLimit,
      ends_at: i.endsAt,
      note: "Harga katalog adalah penawaran terkonfigurasi, bukan kurs tetap VP→aset",
    }),
  );
}

/** Redeem item katalog: reserve + commit atomik (fulfillment oleh ops/relevant service). */
async function redeemCatalog({ coreId, sku, idempotencyKey, now = new Date() }) {
  const { config } = await configSvc.resolve(now);
  assertRedemptionEnabled(config);
  const item = await LoyaltyCatalogItem.findOne({ where: { sku, active: true } });
  if (!item) throw new LoyaltyError("Item katalog tidak ditemukan", { status: 404, code: "CATALOG_ITEM_NOT_FOUND" });
  if ((item.startsAt && now < item.startsAt) || (item.endsAt && now > item.endsAt)) {
    throw new LoyaltyError("Item katalog di luar periode campaign", { code: "CATALOG_ITEM_INACTIVE" });
  }
  return sequelize.transaction(async (t) => {
    const key = `${coreId}:${idempotencyKey}`;
    const prior = await LoyaltyRewardRedemption.findOne({ where: { idempotencyKey: key }, transaction: t });
    if (prior) return { redemption: prior, replay: true };
    const locked = await LoyaltyCatalogItem.findByPk(item.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (locked.stock !== null && locked.stock <= 0) {
      throw new LoyaltyError("Stok item habis", { status: 409, code: "CATALOG_OUT_OF_STOCK" });
    }
    if (locked.perUserLimit) {
      const used = await LoyaltyRewardRedemption.count({
        where: { coreId, targetType: "CATALOG", targetId: locked.sku, state: { [Op.in]: ["RESERVED", "COMMITTED"] } },
        transaction: t,
      });
      if (used >= locked.perUserLimit) {
        throw new LoyaltyError("Batas penukaran per user tercapai", { status: 409, code: "CATALOG_USER_LIMIT" });
      }
    }
    const amount = big(locked.vpPrice);
    await ledger.ensureCustomer(coreId, { now, transaction: t, lock: true });
    const balances = await ledger.vpBalances(coreId, { transaction: t });
    if (balances.available < amount) {
      throw new LoyaltyError("VP available tidak mencukupi", { status: 402, code: "INSUFFICIENT_VP", details: { available: balances.available, price: amount } });
    }
    const redemption = await LoyaltyRewardRedemption.create(
      {
        coreId,
        amountVp: amount.toString(),
        targetType: "CATALOG",
        targetId: locked.sku,
        quoteSnapshot: toJsonSafe({ sku: locked.sku, title: locked.title, vp_price: amount, reward_asset: locked.rewardAsset, reward_amount: locked.rewardAmount, quoted_at: now }),
        state: "COMMITTED",
        idempotencyKey: key,
        committedAt: now,
        fulfillmentState: "PENDING_FULFILLMENT",
      },
      { transaction: t },
    );
    await ledger.postVp(
      { coreId, redemptionId: redemption.id, bucket: BUCKET.AVAILABLE, deltaVp: -amount, reasonCode: "CATALOG_REDEEM", idempotencyKey: `redemption:${redemption.id}:catalog:available` },
      t,
    );
    await ledger.postVp(
      { coreId, redemptionId: redemption.id, bucket: BUCKET.REDEEMED, deltaVp: amount, reasonCode: "CATALOG_REDEEM", idempotencyKey: `redemption:${redemption.id}:catalog:redeemed` },
      t,
    );
    if (locked.stock !== null) await locked.update({ stock: locked.stock - 1 }, { transaction: t });
    return { redemption, replay: false };
  });
}

module.exports = { feeQuote, reserve, commit, release, releaseExpired, catalog, redeemCatalog };
