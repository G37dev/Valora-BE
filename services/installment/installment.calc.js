/*
 * Pure calculation engine untuk Gold Installment.
 *
 * - IDR final selalu BigInt (integer rupiah).
 * - Rate selalu BPS integer.
 * - Decimal hanya untuk gram x harga (NUMERIC(38,18)).
 * - Tidak ada FLOAT/DOUBLE sebagai canonical value.
 * - Semua fungsi deterministic & tanpa side effect.
 */

const Decimal = require("decimal.js");
const {
  PLAN_TYPE,
  INSTALLMENT_GAP,
  STANDARD_MARKUP_BPS,
  PRICE_LOCK_MARGIN_BPS,
  RESTRUCTURE_EXTENSION_MONTHS,
  RULES,
} = require("./installment.constants");
const { addMonths, fullDaysBetween } = require("./installment.calendar");

Decimal.set({ precision: 60, rounding: Decimal.ROUND_HALF_UP });

const BPS_DENOMINATOR = 10000n;

// ============================================================
// Primitives
// ============================================================

/** Normalisasi nilai apa pun (string BIGINT dari pg, number, bigint) ke BigInt. */
function big(value) {
  if (typeof value === "bigint") return value;
  if (value === null || value === undefined || value === "") return 0n;
  const str = String(value).trim();
  if (/^-?\d+$/.test(str)) return BigInt(str);
  return roundIdr(new Decimal(str));
}

/** Satu-satunya rounding boundary IDR: half-up ke integer. */
function roundIdr(decimalValue) {
  return BigInt(new Decimal(decimalValue).toFixed(0, Decimal.ROUND_HALF_UP));
}

/** amount x bps / 10000, half-up. */
function bpsOf(amount, bps) {
  const a = big(amount);
  const b = BigInt(bps);
  const numerator = a * b;
  const half = BPS_DENOMINATOR / 2n;
  return numerator >= 0n
    ? (numerator + half) / BPS_DENOMINATOR
    : -((-numerator + half) / BPS_DENOMINATOR);
}

/** part / whole dalam bps, floor. 0 jika whole <= 0. */
function ratioBps(part, whole) {
  const w = big(whole);
  if (w <= 0n) return 0;
  return Number((big(part) * BPS_DENOMINATOR) / w);
}

function maxBig(a, b) {
  return a > b ? a : b;
}

function minBig(a, b) {
  return a < b ? a : b;
}

function clampNonNegative(value) {
  return value < 0n ? 0n : value;
}

// ============================================================
// Rate lookups
// ============================================================

function standardMarkupBps(asset, tenorMonths) {
  const bps = STANDARD_MARKUP_BPS[asset]?.[tenorMonths];
  if (bps === undefined) {
    throw new Error(`Markup Standard tidak tersedia untuk ${asset}/${tenorMonths}M`);
  }
  return bps;
}

function priceLockMarginBps(tenorMonths) {
  const bps = PRICE_LOCK_MARGIN_BPS[tenorMonths];
  if (bps === undefined) {
    throw new Error(`Price-Lock Margin tidak tersedia untuk ${tenorMonths}M`);
  }
  return bps;
}

function restructureExtensionMonths(tenorMonths) {
  const months = RESTRUCTURE_EXTENSION_MONTHS[tenorMonths];
  if (months === undefined) {
    throw new Error(`Restructure extension tidak tersedia untuk ${tenorMonths}M`);
  }
  return months;
}

// ============================================================
// Asset value
// ============================================================

/** Asset Value = Gold Amount (gram) x Locked Price (IDR/gram), dibulatkan ke IDR. */
function computeAssetValue(goldAmount, lockedPriceIdr) {
  return roundIdr(new Decimal(String(goldAmount)).mul(String(lockedPriceIdr)));
}

// ============================================================
// Standard
// ============================================================

/**
 * Jumlah installment. Dikunci saat request dibuat (dihitung dari requestAt)
 * agar quote == kontrak. Installment pertama dibayar saat activation.
 */
function standardScheduleCount(gap, tenorMonths, requestAt) {
  if (gap === INSTALLMENT_GAP.MONTHLY) return Number(tenorMonths);
  const maturity = addMonths(requestAt, tenorMonths);
  return Math.max(1, Math.floor(fullDaysBetween(requestAt, maturity) / 7));
}

/** Base = floor(total / n); final menyerap sisa pembulatan (5.3 / 15.1). */
function buildStandardInstallments(totalPayment, count) {
  const total = big(totalPayment);
  const n = BigInt(count);
  const base = total / n;
  const installments = Array.from({ length: count }, () => base);
  installments[count - 1] = total - base * (n - 1n);
  return installments;
}

/** Minimum Gold Amount (5.4) sebagai Decimal string, ceil 6 desimal. */
function minimumGoldAmount({ markupBps, scheduleCount, lockedPriceIdr }) {
  const minTotal = new Decimal(RULES.MIN_INSTALLMENT_IDR.toString()).mul(
    scheduleCount,
  );
  const minAssetValue = minTotal.div(
    new Decimal(1).plus(new Decimal(markupBps).div(10000)),
  );
  return minAssetValue
    .div(String(lockedPriceIdr))
    .toDecimalPlaces(6, Decimal.ROUND_UP)
    .toFixed(6);
}

function standardQuote({
  asset,
  tenorMonths,
  installmentGap,
  goldAmount,
  lockedPriceIdr,
  requestAt,
}) {
  const markupBps = standardMarkupBps(asset, tenorMonths);
  const assetValue = computeAssetValue(goldAmount, lockedPriceIdr);
  const markupAmount = bpsOf(assetValue, markupBps);
  const totalPayment = assetValue + markupAmount;
  const scheduleCount = standardScheduleCount(installmentGap, tenorMonths, requestAt);
  const installments = buildStandardInstallments(totalPayment, scheduleCount);
  const minGoldAmount = minimumGoldAmount({ markupBps, scheduleCount, lockedPriceIdr });
  const meetsMinimum = installments.every((x) => x >= RULES.MIN_INSTALLMENT_IDR);

  return {
    planType: PLAN_TYPE.STANDARD,
    asset,
    tenorMonths,
    installmentGap,
    goldAmount: String(goldAmount),
    lockedPriceIdr: String(lockedPriceIdr),
    assetValue,
    markupBps,
    markupAmount,
    totalPayment,
    scheduleCount,
    installments,
    initialPayment: installments[0],
    minInstallmentIdr: RULES.MIN_INSTALLMENT_IDR,
    minGoldAmount,
    meetsMinimum,
  };
}

// ============================================================
// Flexible
// ============================================================

function flexibleQuote({ asset, tenorMonths, goldAmount, lockedPriceIdr, dpBps }) {
  const dp = Number(dpBps);
  if (!Number.isInteger(dp) || dp < RULES.DP_MIN_BPS || dp > RULES.DP_MAX_BPS) {
    throw new Error(
      `Down Payment harus antara ${RULES.DP_MIN_BPS / 100}% dan ${RULES.DP_MAX_BPS / 100}%`,
    );
  }

  const plmBps = priceLockMarginBps(tenorMonths);
  const assetValue = computeAssetValue(goldAmount, lockedPriceIdr);
  const plmAmount = bpsOf(assetValue, plmBps);
  const lockedPlanValue = assetValue + plmAmount;
  const dpAmount = bpsOf(lockedPlanValue, dp);

  return {
    planType: PLAN_TYPE.FLEXIBLE,
    asset,
    tenorMonths,
    goldAmount: String(goldAmount),
    lockedPriceIdr: String(lockedPriceIdr),
    assetValue,
    priceLockMarginBps: plmBps,
    priceLockMarginAmount: plmAmount,
    lockedPlanValue,
    dpBps: dp,
    dpAmount,
    initialPayment: dpAmount,
    principalOutstandingAfterDp: lockedPlanValue - dpAmount,
    paymentCompletionBpsAfterDp: ratioBps(dpAmount, lockedPlanValue),
    minPaymentIdr: RULES.MIN_PAYMENT_IDR,
  };
}

// ============================================================
// Shared curves
// ============================================================

/** Payment Completion bps = floor(eligiblePaid / base x 10000). */
function paymentCompletionBps(eligiblePaid, base) {
  return ratioBps(eligiblePaid, base);
}

/** 8.2 shared cancellation curve: 3% floor, +0.06pp per 1pp dari 30%, cap 6%. */
function cancellationRateBps(pcBps) {
  const pc = Number(pcBps);
  if (pc <= RULES.CANCEL_CURVE_START_PC_BPS) return RULES.CANCEL_FLOOR_BPS;
  if (pc >= RULES.CANCEL_CURVE_END_PC_BPS) return RULES.CANCEL_CAP_BPS;
  return (
    RULES.CANCEL_FLOOR_BPS +
    Math.floor(((pc - RULES.CANCEL_CURVE_START_PC_BPS) * 6) / 100)
  );
}

/**
 * 11.3 ALC rate 30%-80%: 50% - (PC - 30%) x 0.8.
 * PC < 30% (hanya mungkin di Standard) di-clamp ke 50%.
 * PC >= 80% -> null (Model B: 8% x LPV).
 */
function alcRateBps(pcBps) {
  const pc = Number(pcBps);
  if (pc >= RULES.ALC_END_PC_BPS) return null;
  if (pc <= RULES.ALC_START_PC_BPS) return RULES.ALC_START_RATE_BPS;
  return (
    RULES.ALC_START_RATE_BPS -
    Math.floor(((pc - RULES.ALC_START_PC_BPS) * 8) / 10)
  );
}

function autoLiquidCompensation({ pcBps, eligiblePaid, planValue }) {
  const rateBps = alcRateBps(pcBps);
  if (rateBps === null) {
    return { rateBps: null, base: "PLAN_VALUE", amount: bpsOf(planValue, RULES.ALC_FLOOR_LPV_BPS) };
  }
  return { rateBps, base: "ELIGIBLE_PAID", amount: bpsOf(eligiblePaid, rateBps) };
}

function carryingAccrual(principalOutstanding) {
  return bpsOf(principalOutstanding, RULES.CARRYING_BPS);
}

function pastDuePenalty(principalOutstanding) {
  return bpsOf(principalOutstanding, RULES.PAST_DUE_PENALTY_BPS);
}

function restructureFee(principalOutstanding) {
  return bpsOf(principalOutstanding, RULES.RESTRUCTURE_FEE_BPS);
}

function protocolFee(assetValue) {
  return bpsOf(assetValue, RULES.PROTOCOL_FEE_BPS);
}

/**
 * 5.6 Late penalty = overdue x 0.05% x days, cap 2% x installment amount.
 * Mengembalikan tambahan penalty yang boleh di-charge sekarang.
 */
function latePenaltyAccrual({ overdueRemaining, days, alreadyCharged, installmentAmount }) {
  if (days <= 0 || big(overdueRemaining) <= 0n) return 0n;
  const cap = bpsOf(installmentAmount, RULES.LATE_PENALTY_CAP_BPS);
  const room = clampNonNegative(cap - big(alreadyCharged));
  const raw = bpsOf(overdueRemaining, RULES.LATE_PENALTY_DAILY_BPS * days);
  return minBig(raw, room);
}

// ============================================================
// Waterfall (pure)
// ============================================================

/**
 * Alokasikan `amount` ke bucket berurutan.
 * buckets: [{ key, due: bigint }]
 * return { allocations: { [key]: bigint }, remainder: bigint }
 */
function allocateWaterfall(amount, buckets) {
  let remaining = big(amount);
  const allocations = {};
  for (const { key, due } of buckets) {
    const d = clampNonNegative(big(due));
    const take = minBig(remaining, d);
    allocations[key] = take;
    remaining -= take;
    if (remaining === 0n) {
      for (const rest of buckets) if (!(rest.key in allocations)) allocations[rest.key] = 0n;
      break;
    }
  }
  return { allocations, remainder: remaining };
}

module.exports = {
  big,
  roundIdr,
  bpsOf,
  ratioBps,
  maxBig,
  minBig,
  clampNonNegative,
  standardMarkupBps,
  priceLockMarginBps,
  restructureExtensionMonths,
  computeAssetValue,
  standardScheduleCount,
  buildStandardInstallments,
  minimumGoldAmount,
  standardQuote,
  flexibleQuote,
  paymentCompletionBps,
  cancellationRateBps,
  alcRateBps,
  autoLiquidCompensation,
  carryingAccrual,
  pastDuePenalty,
  restructureFee,
  protocolFee,
  latePenaltyAccrual,
  allocateWaterfall,
};
