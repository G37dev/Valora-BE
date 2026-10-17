/*
 * Pure calculation engine Loan V1 (brief 05-14, Appendix A).
 *
 * - Semua nilai uang/token = Decimal (precision 60), TIDAK ADA float.
 * - IDR canonical fixed-point; pembulatan integer rupiah hanya di boundary
 *   kas (roundIdr) — brief: "Pembulatan rupiah hanya pada posting final".
 * - Token: release dibulatkan KE BAWAH ke presisi token (A.3 "max release
 *   down"); alokasi debt liquidation half-up (sesuai tabel haircut 0/3/5/7%).
 * - Deterministic, tanpa side effect.
 */

const Decimal = require("decimal.js");
const { RULES, RISK, APR_BPS } = require("./loan.constants");

Decimal.set({ precision: 60, rounding: Decimal.ROUND_HALF_UP });

const BPS = new Decimal(10000);
const ZERO = new Decimal(0);

// ============================================================
// Primitives
// ============================================================

function dec(v) {
  if (v instanceof Decimal) return v;
  if (v === null || v === undefined || v === "") return ZERO;
  return new Decimal(typeof v === "bigint" ? v.toString() : String(v));
}

const bpsFrac = (bps) => dec(bps).div(BPS);
const bpsOf = (amount, bps) => dec(amount).mul(bpsFrac(bps));

/** Satu-satunya rounding boundary kas IDR: half-up ke integer rupiah. */
const roundIdr = (v) => BigInt(dec(v).toFixed(0, Decimal.ROUND_HALF_UP));
/** Rupiah 2dp untuk display/ledger presisi (bukan posting kas). */
const idr2 = (v) => dec(v).toFixed(2, Decimal.ROUND_HALF_UP);

const maxDec = (a, b) => (dec(a).gte(b) ? dec(a) : dec(b));
const minDec = (...xs) =>
  xs.map(dec).reduce((m, x) => (x.lt(m) ? x : m), dec(xs[0]));
const clamp0 = (v) => (dec(v).lt(0) ? ZERO : dec(v));

/** part / whole dalam bps (number, 2dp). 0 jika whole <= 0. */
function ratioBps(part, whole) {
  const w = dec(whole);
  if (w.lte(0)) return 0;
  return Number(dec(part).div(w).mul(BPS).toFixed(2));
}

const tokenDown = (q, decimals = RULES.TOKEN_DECIMALS) =>
  dec(q).toDecimalPlaces(decimals, Decimal.ROUND_DOWN);
const tokenHalfUp = (q, decimals = RULES.TOKEN_DECIMALS) =>
  dec(q).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);
const tokenRaw = (q, decimals = RULES.TOKEN_DECIMALS) =>
  BigInt(dec(q).mul(new Decimal(10).pow(decimals)).toFixed(0, Decimal.ROUND_DOWN));

// ============================================================
// Policy lookups
// ============================================================

function aprBps(asset, tenorDays, policy) {
  const table = policy?.aprBps?.[asset] ?? APR_BPS[asset];
  const v = table?.[tenorDays];
  if (v === undefined) throw new Error(`APR undefined ${asset}/${tenorDays}`);
  return Number(v);
}

function riskParams(asset, policy) {
  return { ...RISK[asset], ...(policy?.risk?.[asset] ?? {}) };
}

// ============================================================
// 05 Protocol fee & disbursement
// ============================================================

/** Fee 0.5% x gross, dibulatkan ke rupiah (Rp5m -> 25.000; Rp250k -> 1.250). */
function protocolFee(grossIdr, feeBps = RULES.PROTOCOL_FEE_BPS) {
  return dec(roundIdr(bpsOf(grossIdr, feeBps)));
}

function disbursement(grossIdr, feeBps = RULES.PROTOCOL_FEE_BPS) {
  const gross = dec(grossIdr);
  const fee = protocolFee(gross, feeBps);
  return { gross, fee, net: gross.minus(fee), principal: gross };
}

// ============================================================
// 06 Normal Interest — Monthly Anniversary
// ============================================================

/** First Anniversary: PO snapshot x APR/12 (sekali). */
const firstAnniversaryInterest = (po, apr) =>
  dec(po).mul(bpsFrac(apr)).div(12);

/**
 * Segment prorata cycle >= 2:
 * principal_during_segment x (APR/12) x elapsed_seconds / cycle_seconds
 */
function segmentInterest(po, apr, elapsedSeconds, cycleSeconds) {
  if (dec(cycleSeconds).lte(0) || dec(elapsedSeconds).lte(0)) return ZERO;
  return dec(po)
    .mul(bpsFrac(apr))
    .div(12)
    .mul(dec(elapsedSeconds))
    .div(dec(cycleSeconds));
}

// ============================================================
// 13 Past-Due Penalty
// ============================================================

/** PDP satu hari: 0.05% x PO pada hari itu. */
const pdpForDay = (po, dailyBps = RULES.PDP_DAILY_BPS) => bpsOf(po, dailyBps);
/** Cap kumulatif: 0.15% x PO saat maturity. */
const pdpCap = (poAtMaturity, capBps = RULES.PDP_CAP_BPS) =>
  bpsOf(poAtMaturity, capBps);
const applyPdpCap = (cumulative, cap) => minDec(cumulative, cap);

// ============================================================
// 07 Repayment waterfall
// ============================================================

/**
 * received -> PDP due -> Normal Interest due -> Principal -> excess.
 * Semua Decimal; tidak ada pembulatan di sini.
 */
function waterfall(received, { pdpDue, interestDue, principal }) {
  let left = dec(received);
  const pdp = minDec(left, clamp0(pdpDue));
  left = left.minus(pdp);
  const interest = minDec(left, clamp0(interestDue));
  left = left.minus(interest);
  const prin = minDec(left, clamp0(principal));
  left = left.minus(prin);
  return { pdp, interest, principal: prin, excess: left };
}

// ============================================================
// 11 LTV / Health Factor
// ============================================================

const collateralValue = (qty, price) => dec(qty).mul(dec(price));

/** Current LTV (bps, 2dp number). */
const ltvBps = (tdd, collValue) => ratioBps(tdd, collValue);

/** HF = collateral x liquidation_threshold / TDD (Decimal 4dp). Infinity-safe. */
function healthFactor(collValue, liquidationBps, tdd) {
  if (dec(tdd).lte(0)) return new Decimal(999);
  return dec(collValue)
    .mul(bpsFrac(liquidationBps))
    .div(dec(tdd))
    .toDecimalPlaces(4, Decimal.ROUND_DOWN);
}

/** HF boundary per zona: liq/margin, liq/emergency (ikut tabel brief 11). */
function hfBoundaries(risk) {
  const liq = dec(risk.liquidationBps);
  return {
    initial: liq.div(risk.initialLtvBps).toDecimalPlaces(4),
    marginCall: liq.div(risk.marginCallBps).toDecimalPlaces(4),
    liquidation: new Decimal(1),
    emergency: risk.emergencyBps
      ? liq.div(risk.emergencyBps).toDecimalPlaces(4)
      : null,
  };
}

// ============================================================
// 08 Double-Limit Collateral Release
// ============================================================

/**
 * Q_risk    = MAX(0, Q_locked - D_after / (P x L_release))
 * Q_payment = Principal_paid / P
 * Q_release = MAX(0, MIN(Q_risk, Q_payment, Q_locked))  (round DOWN)
 * Post_LTV  = D_after / ((Q_locked - Q_release) x P)
 * Full settlement (D_after == 0): release semua.
 */
function doubleLimitRelease({
  debtAfter,
  qLocked,
  price,
  postReleaseMaxBps,
  principalPaid,
  decimals = RULES.TOKEN_DECIMALS,
  fullSettlement = false,
}) {
  const D = dec(debtAfter);
  const Q = dec(qLocked);
  const P = dec(price);
  if (fullSettlement || D.lte(0)) {
    return {
      qRisk: Q,
      qPayment: Q,
      qRelease: Q,
      qRemaining: ZERO,
      postReleaseLtvBps: 0,
      minCollateralQty: ZERO,
    };
  }
  const minColl = D.div(P.mul(bpsFrac(postReleaseMaxBps)));
  const qRisk = clamp0(Q.minus(minColl));
  const qPayment = P.gt(0) ? dec(principalPaid).div(P) : ZERO;
  const qRelease = tokenDown(clamp0(minDec(qRisk, qPayment, Q)), decimals);
  const qRemaining = Q.minus(qRelease);
  return {
    qRisk,
    qPayment,
    qRelease,
    qRemaining,
    postReleaseLtvBps: ltvBps(D, qRemaining.mul(P)),
    minCollateralQty: minColl,
  };
}

// ============================================================
// 14 Auto Liquidation split
// ============================================================

/**
 * Conservative_Price = ref x (1 - haircut)
 * Q_debt_alloc = MIN(Q_locked, TDD / Conservative_Price)   (half-up)
 * Gross_Residual = MAX(0, Q_locked - Q_debt_alloc)
 * Q_comp = MIN(1% x Q_locked, Gross_Residual)
 * Refund = Gross_Residual - Q_comp ; Treasury = debt_alloc + comp
 * Invariant: refund + treasury == locked.
 */
function liquidationSplit({
  qLocked,
  totalDebtDue,
  referencePrice,
  haircutBps,
  compensationBps = RULES.LIQUIDATION_COMPENSATION_BPS,
  decimals = RULES.TOKEN_DECIMALS,
}) {
  const Q = dec(qLocked);
  const tdd = dec(totalDebtDue);
  const conservativePrice = dec(referencePrice).mul(
    new Decimal(1).minus(bpsFrac(haircutBps)),
  );
  const rawDebtQ = conservativePrice.gt(0) ? tdd.div(conservativePrice) : Q;
  const qDebtAlloc = minDec(Q, tokenHalfUp(rawDebtQ, decimals));
  const grossResidual = clamp0(Q.minus(qDebtAlloc));
  const qComp = minDec(tokenDown(bpsOf(Q, compensationBps), decimals), grossResidual);
  const qRefund = grossResidual.minus(qComp);
  const qTreasury = qDebtAlloc.plus(qComp);
  // Shortfall IDR bila collateral tidak cukup menutup TDD pada harga konservatif.
  const coveredIdr = qDebtAlloc.mul(conservativePrice);
  const deficitIdr = clamp0(tdd.minus(coveredIdr));
  return {
    conservativePrice,
    qDebtAlloc,
    grossResidual,
    qComp,
    qRefund,
    qTreasury,
    deficitIdr,
    debtAllocSpotIdr: qDebtAlloc.mul(dec(referencePrice)),
    refundSpotIdr: qRefund.mul(dec(referencePrice)),
    compSpotIdr: qComp.mul(dec(referencePrice)),
  };
}

// ============================================================
// 04 / 09 Caps & capacity
// ============================================================

const borrowerCap = (snapshotCapital, bps = RULES.BORROWER_CAP_BPS) =>
  bpsOf(snapshotCapital, bps);
const utilizationCap = (eligibleCapital, bps = RULES.MAX_POOL_UTILIZATION_BPS) =>
  bpsOf(eligibleCapital, bps);

/**
 * LTV_capacity      = MAX(0, initial_ltv x locked_qty x eligible_price - TDD)
 * Customer_capacity = MAX(0, borrower_cap - aggregate_PO)
 * Pool_capacity     = MIN(utilization_headroom, available_cash)
 * Available         = MAX(0, MIN(ltv, customer, pool)) -> floor rupiah
 */
function availableCapacity({
  initialLtvBps,
  lockedQty,
  eligiblePrice,
  tdd,
  borrowerCapIdr,
  aggregatePoIdr,
  utilizationHeadroomIdr,
  availableCashIdr,
}) {
  const ltvCap = clamp0(
    dec(lockedQty).mul(dec(eligiblePrice)).mul(bpsFrac(initialLtvBps)).minus(dec(tdd)),
  );
  const customerCap = clamp0(dec(borrowerCapIdr).minus(dec(aggregatePoIdr)));
  const poolCap = clamp0(minDec(utilizationHeadroomIdr, availableCashIdr));
  const available = clamp0(minDec(ltvCap, customerCap, poolCap)).toDecimalPlaces(
    0,
    Decimal.ROUND_DOWN,
  );
  return { ltvCap, customerCap, poolCap, available };
}

// ============================================================
// 10 Borrowing eligible price
// ============================================================

/** conservative MIN(current validated spot, 15-minute TWAP). */
function borrowingEligiblePrice(spot, twap) {
  if (twap === null || twap === undefined) return dec(spot);
  return minDec(spot, twap);
}

module.exports = {
  Decimal,
  ZERO,
  dec,
  bpsFrac,
  bpsOf,
  roundIdr,
  idr2,
  maxDec,
  minDec,
  clamp0,
  ratioBps,
  tokenDown,
  tokenHalfUp,
  tokenRaw,
  aprBps,
  riskParams,
  protocolFee,
  disbursement,
  firstAnniversaryInterest,
  segmentInterest,
  pdpForDay,
  pdpCap,
  applyPdpCap,
  waterfall,
  collateralValue,
  ltvBps,
  healthFactor,
  hfBoundaries,
  doubleLimitRelease,
  liquidationSplit,
  borrowerCap,
  utilizationCap,
  availableCapacity,
  borrowingEligiblePrice,
};
