/*
 * Facade API user-facing (brief 12.4 / 15.2): summary, history, rules,
 * reward detail. Canonical customer dari session (coreId JWT) — tidak pernah
 * percaya amount dari client.
 */

const { Op } = require("sequelize");
const {
  LoyaltyRewardGrant,
  LoyaltyRewardRedemption,
  LoyaltyMonthlyProgress,
  LoyaltyVpJournal,
} = require("../../models");
const configSvc = require("./loyalty.config");
const ledger = require("./loyalty.ledger");
const membership = require("./loyalty.membership");
const engine = require("./loyalty.engine");
const { toJsonSafe, LoyaltyError } = require("./loyalty.errors");
const { CATEGORY, FEATURE, TIER, RULES_VERSION } = require("./loyalty.constants");

const CATEGORY_LABEL = {
  FIRST_DEPOSIT: "First Deposit Bonus",
  FQT: "First Qualified Transaction Bonus",
  REGULAR: "Fee-Back Reward",
  MONTHLY: "Monthly Value Milestone",
  MONTHLY_BOOSTER: "Junior+ Monthly Booster",
  REFERRAL_DEPOSIT: "Referral Deposit Cashback",
  REFERRAL_ACTIVATION: "Referral Activation Bonus",
};

function pendingReason(g) {
  if (g.state !== "PENDING") return null;
  if (g.availabilityTrigger === "HOLD_EXPIRY") return `Masa tunggu validasi sampai ${new Date(g.availableAt).toISOString()}`;
  const map = {
    EARN: "Available setelah Earn matang dan berhasil di-claim",
    LOAN: "Available setelah Loan lunas (healthy Full Settlement)",
    INSTALLMENT: "Available setelah cicilan selesai dan emas berhasil di-claim",
  };
  return map[g.feature] || "Menunggu penyelesaian produk";
}

function serializeGrant(g) {
  return toJsonSafe({
    reward_id: g.id,
    category: g.category,
    label: CATEGORY_LABEL[g.category] || g.category,
    unit: g.unit,
    state: g.state,
    vp_amount: g.vpAmount,
    idr_amount: g.idrAmount,
    feature: g.feature,
    position_ref: g.positionRef,
    source_transaction_id: g.sourceTransactionId,
    occurred_at: g.occurredAt,
    available_at: g.availableAt,
    availability_trigger: g.availabilityTrigger,
    vested_at: g.vestedAt,
    voided_at: g.voidedAt,
    void_reason: g.voidReason,
    pending_reason: pendingReason(g),
    calculation: {
      tier_snapshot: g.tierSnapshot,
      multiplier_bps: g.multiplierBps,
      rate_bps: g.rateBps,
      cap_applied: g.capApplied,
      basis_idr: g.basisIdr,
      fee_gross_idr: g.feeGrossIdr,
      fee_discount_idr: g.feeDiscountIdr,
      fee_cost_idr: g.feeCostIdr,
      fee_net_idr: g.feeNetIdr,
      config_version: g.configVersion,
    },
  });
}

async function summary(coreId, { now = new Date() } = {}) {
  const resolved = await configSvc.resolve(now);
  const config = resolved.config;
  const cust = await ledger.ensureCustomer(coreId, { now });
  const vp = await ledger.vpBalances(coreId);
  const idr = await ledger.idrBalances(coreId);
  const { twab, fullHistory } = await membership.computeTwab30(coreId, { now, config });
  const { tier } = membership.resolveTier(config, twab, fullHistory);
  const monthKey = engine.monthKey(now, config.monthly.period_timezone);
  const monthly = await LoyaltyMonthlyProgress.findOne({ where: { coreId, monthKey } });
  const pendingGrants = await LoyaltyRewardGrant.findAll({
    where: { coreId, unit: "VP", state: "PENDING" },
    order: [["occurred_at", "DESC"]],
    limit: 10,
  });
  const tiers = configSvc.tierTable(config);
  const idx = tiers.findIndex((t) => t.code === tier);
  const next = tiers[idx + 1] || null;

  return toJsonSafe({
    as_of: now,
    rules_version: RULES_VERSION,
    config_version: resolved.version,
    vp: { available: vp.available, pending: vp.pending, reserved: vp.reserved, redeemed: vp.redeemed, face_value_idr_per_vp: config.redemption.vp_idr_value },
    referral_idr: { claimable: idr.claimable, pending: idr.pending, claimed: idr.claimed },
    membership: {
      tier,
      multiplier_bps: configSvc.tierMultiplierBps(config, tier),
      twab30_idr: twab,
      full_history: fullHistory,
      next_tier: next ? { code: next.code, threshold_idr: next.threshold_idr, progress_bps: Number((twab * 10000n) / BigInt(next.threshold_idr || 1)) } : null,
    },
    first_deposit: {
      consumed: Boolean(cust.firstDepositConsumedAt),
      qualified: cust.firstDepositQualified,
      window_ends_at: new Date(new Date(cust.accountCreatedAt || cust.enrolledAt).getTime() + Number(config.referral.first_deposit_window_hours) * 3600000),
    },
    first_qualified_transaction: { slot_state: cust.fqtSlotState, feature: cust.fqtFeature, position_ref: cust.fqtPositionRef },
    monthly_milestone: {
      month: monthKey,
      tx_count: monthly?.txCount || 0,
      tx_required: config.monthly.min_tx_count,
      net_fee_idr: monthly?.netFeeIdr || 0,
      net_fee_required_idr: config.monthly.min_net_fee_idr,
      state: monthly?.milestoneState || "IN_PROGRESS",
      bonus_vp: config.monthly.base_bonus_vp,
      booster_vp: config.monthly.junior_plus_booster_vp,
      booster_eligible: configSvc.tierRank(config, tier) >= configSvc.tierRank(config, TIER.JUNIOR),
    },
    pending_rewards: pendingGrants.map(serializeGrant),
    fee_discount: { cap_bps: config.redemption.global_fee_discount_cap_bps, eligible_fee_codes: config.redemption.eligible_fee_codes },
  });
}

async function history(coreId, { limit = 50, offset = 0, category, state } = {}) {
  const where = { coreId };
  if (category) where.category = category;
  if (state) where.state = state;
  const rows = await LoyaltyRewardGrant.findAndCountAll({
    where,
    order: [["occurred_at", "DESC"]],
    limit: Math.min(Number(limit) || 50, 200),
    offset: Number(offset) || 0,
  });
  const redemptions = await LoyaltyRewardRedemption.findAll({
    where: { coreId },
    order: [["created_at", "DESC"]],
    limit: 50,
  });
  return {
    total: rows.count,
    rewards: rows.rows.map(serializeGrant),
    redemptions: redemptions.map((r) =>
      toJsonSafe({
        redemption_id: r.id,
        amount_vp: r.amountVp,
        target_type: r.targetType,
        target_id: r.targetId,
        fee_code: r.feeCode,
        state: r.state,
        fulfillment_state: r.fulfillmentState,
        created_at: r.createdAt,
        committed_at: r.committedAt,
      }),
    ),
  };
}

async function rewardDetail(coreId, rewardId) {
  const g = await LoyaltyRewardGrant.findOne({ where: { id: rewardId, coreId } });
  if (!g) throw new LoyaltyError("Reward tidak ditemukan", { status: 404, code: "REWARD_NOT_FOUND" });
  const journal = await LoyaltyVpJournal.findAll({ where: { grantId: g.id }, order: [["created_at", "ASC"]] });
  return {
    ...serializeGrant(g),
    valuation_snapshot: g.valuationSnapshot,
    journal: journal.map((j) => toJsonSafe({ at: j.createdAt, bucket: j.bucket, delta_vp: j.deltaVp, reason: j.reasonCode })),
  };
}

/** Rules page — ringkas, plain language, dari config aktif. */
async function rules({ now = new Date() } = {}) {
  const { config, version } = await configSvc.resolve(now);
  const pct = (bps) => `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
  const idr = (n) => `Rp${Number(n).toLocaleString("id-ID")}`;
  return {
    config_version: version,
    rules_version: RULES_VERSION,
    vp_face_value: `1 VP = ${idr(config.redemption.vp_idr_value)} untuk diskon eligible platform fee (bukan saldo IDR, tidak bisa ditarik)`,
    no_mlm: "Referral hanya satu tingkat (A → B). Tidak ada komisi dari undangan B.",
    categories: [
      { code: "REFERRAL_DEPOSIT", who: "Pengundang (A)", rule: `${pct(config.referral.deposit_rate_bps)} dari deposit pertama B (min ${idr(config.first_deposit.min_deposit_idr)}, dalam ${config.referral.first_deposit_window_hours / 24} hari sejak daftar), maks ${idr(config.referral.deposit_cap_idr)}. Cashback IDR, klaim manual, tanpa kedaluwarsa.` },
      { code: "REFERRAL_ACTIVATION", who: "Pengundang (A)", rule: `${pct(config.referral.activation_rate_bps)} dari transaksi pertama B (Earn/Loan/Cicilan Emas) yang selesai sehat, maks ${idr(config.referral.activation_cap_idr)}. Satu kali per B.` },
      { code: "FIRST_DEPOSIT", who: "Kamu (B)", rule: `${pct(config.first_deposit.rate_bps)} dari deposit pertama (min ${idr(config.first_deposit.min_deposit_idr)}, dalam ${config.referral.first_deposit_window_hours / 24} hari), maks ${config.first_deposit.cap_vp.toLocaleString("id-ID")} VP. Pending ${config.first_deposit.pending_hold_hours / 24} hari.` },
      { code: "FQT", who: "Kamu (B)", rule: `${pct(config.first_qualified.rate_bps)} × nilai transaksi pertama Earn/Loan/Cicilan Emas (min ${idr(config.first_qualified.min_qualified_amount_idr)}) × multiplier tier, maks ${config.first_qualified.cap_vp.toLocaleString("id-ID")} VP. Available setelah produk selesai. Loan: LTV awal min ${pct(config.first_qualified.loan_xaut_min_ltv_bps)} (XAUT) / ${pct(config.first_qualified.loan_vvlr_min_ltv_bps)} (VVLR) — syarat reward saja, bukan syarat pinjaman.` },
      { code: "REGULAR", who: "Kamu", rule: `${pct(config.regular.base_rate_bps)} × platform fee bersih yang kamu bayar × multiplier tier. Deposit & withdraw tidak dapat VP. Bunga, PDP, denda, principal, collateral, biaya network bukan basis VP.` },
      { code: "MONTHLY", who: "Kamu", rule: `${config.monthly.min_tx_count} transaksi selesai + fee bersih ${idr(config.monthly.min_net_fee_idr)} dalam sebulan → ${config.monthly.base_bonus_vp.toLocaleString("id-ID")} VP (sekali/bulan). Junior+ bonus +${config.monthly.junior_plus_booster_vp} VP.` },
    ],
    tiers: configSvc.tierTable(config).map((t) => ({ code: t.code, threshold_idr: t.threshold_idr, multiplier: `${(t.multiplier_bps / 10000).toFixed(2)}×`, benefits: t.benefits || [] })),
    membership_rule: `Tier dari rata-rata saldo tertimbang waktu 30 hari (TWAB). Butuh ${config.membership.twab_window_hours / 24} hari histori penuh sebelum naik tier. Tidak ada XP/volume. Tidak ada penalti withdraw — hanya TWAB yang menentukan.`,
    redemption_rule: `Diskon VP maks ${pct(config.redemption.global_fee_discount_cap_bps)} dari eligible platform fee per transaksi, semua tier. Biaya network/relayer, bunga, denda tidak bisa didiskon.`,
    exclusions: [
      "Deposit berikutnya dan withdraw tidak menghasilkan VP",
      "Swap tidak eligible FQT/Referral Activation (eligible Fee-Back & Monthly)",
      "Self-referral, akun ganda, referral melingkar dilarang",
      "Reward pending dibatalkan jika posisi gagal selesai (liquidated/cancelled)",
    ],
  };
}

module.exports = { summary, history, rewardDetail, rules, serializeGrant, CATEGORY, FEATURE };
