/*
 * Loan V1 — canonical rules (VIVALORA Loan Developer Brief V1.0 FINAL).
 *
 * - Rate disimpan dalam BPS (1% = 100 bps).
 * - IDR canonical = Decimal fixed-point (18 dp internal); pembulatan ke
 *   integer rupiah HANYA pada posting final / mutasi kas.
 * - Token = unit desimal (NUMERIC 38,18) + raw uint sesuai decimals.
 * - Modul ini BERDIRI SENDIRI dari Gold Installment & Earn (brief D.4).
 *
 * Nilai di sini adalah DEFAULT policy; nilai efektif dibaca dari
 * loan_risk_policy_versions (CONFIGURABLE, versioned, effective_at).
 */

const RULES_VERSION = "LOAN-1.0";

const ASSET = Object.freeze({
  XAUT: "XAUT",
  GOLD: "GOLD", // VVLR Gold (1 token = 1 gram)
});

const ASSET_ALIASES = Object.freeze({
  XAUT: ASSET.XAUT,
  GOLD: ASSET.GOLD,
  VVLR: ASSET.GOLD,
  VVLR_GOLD: ASSET.GOLD,
  VVLRGOLD: ASSET.GOLD,
});

const TENOR_DAYS = Object.freeze([90, 180, 360]);

// 03 APR & Tenor Matrix — APPROVED (bps)
const APR_BPS = Object.freeze({
  [ASSET.XAUT]: Object.freeze({ 90: 1200, 180: 1300, 360: 1400 }),
  [ASSET.GOLD]: Object.freeze({ 90: 1300, 180: 1400, 360: 1500 }),
});

// 03 Risk Parameters (bps)
const RISK = Object.freeze({
  [ASSET.XAUT]: Object.freeze({
    initialLtvBps: 6500,
    marginCallBps: 7200,
    liquidationBps: 7500,
    emergencyBps: 7800, // once-per-position 4h observation; emergency cut
    postReleaseMaxBps: 6000,
    observationWindowHours: 4,
    haircutBps: 500, // 5% pilot / configurable
    priceSource: "INDODAX",
    maxPriceAgeMs: 10 * 60 * 1000,
  }),
  [ASSET.GOLD]: Object.freeze({
    initialLtvBps: 6000,
    marginCallBps: 6900,
    liquidationBps: 7200,
    emergencyBps: null, // tidak ada emergency / observation untuk VVLR
    postReleaseMaxBps: 5500,
    observationWindowHours: 0,
    haircutBps: 500, // CONTROL GATE: confirm executable valuation
    priceSource: "SHARIACOIN",
    // Partner update ~1x/hari, Minggu tidak update -> toleransi 2 hari.
    maxPriceAgeMs: 48 * 60 * 60 * 1000,
  }),
});

// 03 Economics and Limits
const RULES = Object.freeze({
  MIN_INITIAL_GROSS_IDR: "500000",
  MIN_ADDITIONAL_GROSS_IDR: "250000",
  PROTOCOL_FEE_BPS: 50, // 0.5% setiap gross disbursement
  MAX_ACTIVE_POSITIONS: 2,
  BORROWER_CAP_BPS: 500, // 5% x eligible lending capital snapshot
  MAX_POOL_UTILIZATION_BPS: 8500, // 85% x eligible lending capital
  PDP_DAILY_BPS: 5, // 0.05% / hari
  PDP_CAP_BPS: 15, // 0.15% x PO saat maturity
  PDP_MAX_DAYS: 3,
  CURE_DAYS: 3,
  LIQUIDATION_COMPENSATION_BPS: 100, // 1% total locked qty, residual-capped
  LOAN_FUNDING_COVERAGE_BPS: 12000, // 120%
  TWAP_WINDOW_MINUTES: 15,
  QUOTE_TTL_SECONDS: 120,
  TOKEN_DECIMALS: 6,
});

// 18 Position Status (Loan) — borrower state machine
const STATUS = Object.freeze({
  PENDING_COLLATERAL: "PENDING_COLLATERAL",
  PENDING_DISBURSEMENT: "PENDING_DISBURSEMENT",
  ACTIVE: "ACTIVE",
  MARGIN_CALL: "MARGIN_CALL",
  LIQUIDATION_OBSERVATION: "LIQUIDATION_OBSERVATION",
  RECOVERING: "RECOVERING",
  PAST_DUE: "PAST_DUE", // maturity passed; conditional 3-day cure (CURE_ELIGIBLE)
  EMERGENCY: "EMERGENCY",
  LIQUIDATION_PENDING: "LIQUIDATION_PENDING",
  AUTO_LIQUIDATED: "AUTO_LIQUIDATED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED", // PG gagal sebelum aktif / collateral dikembalikan
});

// Posisi yang masih punya kewajiban (ikut cap/utilisasi/risk engine)
const OPEN_STATUSES = Object.freeze([
  STATUS.ACTIVE,
  STATUS.MARGIN_CALL,
  STATUS.LIQUIDATION_OBSERVATION,
  STATUS.RECOVERING,
  STATUS.PAST_DUE,
  STATUS.EMERGENCY,
  STATUS.LIQUIDATION_PENDING,
]);

// Dihitung sebagai "active position" untuk limit 2 / customer
const COUNTED_STATUSES = Object.freeze([
  STATUS.PENDING_COLLATERAL,
  STATUS.PENDING_DISBURSEMENT,
  ...OPEN_STATUSES,
]);

const TERMINAL_STATUSES = Object.freeze([
  STATUS.AUTO_LIQUIDATED,
  STATUS.COMPLETED,
  STATUS.CANCELLED,
]);

// Status di mana additional debt & collateral release DIBLOKIR
const RISK_LOCKED_STATUSES = Object.freeze([
  STATUS.LIQUIDATION_OBSERVATION,
  STATUS.RECOVERING,
  STATUS.EMERGENCY,
  STATUS.LIQUIDATION_PENDING,
]);

// 18 Treasury settlement substatus (terpisah dari borrower state)
const SETTLEMENT_STATUS = Object.freeze({
  NONE: "NONE",
  TREASURY_PENDING: "TREASURY_PENDING",
  RESERVE_ADVANCE_PENDING: "RESERVE_ADVANCE_PENDING",
  RECONCILING: "RECONCILING",
  TREASURY_RECONCILED: "TREASURY_RECONCILED",
});

const RELEASE_STATUS = Object.freeze({
  QUOTED: "QUOTED",
  DEFERRED: "DEFERRED", // user tidak setuju gas / tidak eligible -> opsional
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  FAILED: "FAILED", // tx reverted -> RELEASE_PENDING retry, tanpa double gas
});

const LIQUIDATION_TRIGGER = Object.freeze({
  EMERGENCY: "EMERGENCY",
  OBSERVATION_EXPIRED: "OBSERVATION_EXPIRED",
  REPEAT_HIT: "REPEAT_HIT",
  VVLR_THRESHOLD: "VVLR_THRESHOLD",
  MATURITY_NO_CURE: "MATURITY_NO_CURE",
  CURE_TERMINATED: "CURE_TERMINATED",
  CURE_EXPIRED: "CURE_EXPIRED",
  ADMIN: "ADMIN",
});

const PRICE_STATUS = Object.freeze({
  VALID: "VALID",
  STALE: "STALE",
  SCHEDULED_NO_UPDATE: "SCHEDULED_NO_UPDATE", // VVLR Minggu
  UNAVAILABLE: "UNAVAILABLE",
});

// 18 Canonical Events
const EVENT = Object.freeze({
  POSITION_CREATED: "loan.position_created",
  COLLATERAL_LOCKED: "loan.collateral_locked",
  DISBURSEMENT_CONFIRMED: "loan.disbursement_confirmed",
  DISBURSEMENT_FAILED: "loan.disbursement_failed",
  ADDITIONAL_DRAWDOWN: "loan.additional_drawdown",
  COLLATERAL_TOPUP: "loan.collateral_topup",
  INTEREST_POSTED: "loan.interest_posted",
  PDP_ACCRUED: "loan.pdp_accrued",
  REPAYMENT_CONFIRMED: "loan.repayment_confirmed",
  RELEASE_REQUESTED: "loan.collateral_release_requested",
  RELEASE_CONFIRMED: "loan.collateral_released",
  RELEASE_PENDING_RETRY: "loan.release_pending_retry",
  MARGIN_CALL: "loan.margin_call",
  OBSERVATION_STARTED: "loan.observation_started",
  RECOVERED: "loan.recovered",
  EMERGENCY: "loan.emergency",
  MATURED: "loan.matured",
  CURE_STARTED: "loan.cure_started",
  CURE_TERMINATED: "loan.cure_terminated",
  LIQUIDATION_AUTHORIZED: "loan.liquidation_authorized",
  AUTO_LIQUIDATED: "loan.auto_liquidated",
  FINAL_USER_REFUNDED: "loan.final_user_refunded",
  TREASURY_INVENTORY_RECEIVED: "loan.treasury_inventory_received",
  IDR_POOL_REPLENISHED: "loan.idr_pool_replenished",
  TREASURY_RECONCILED: "loan.treasury_reconciled",
  COMPLETED: "loan.completed",
  PRICE_STALE: "loan.price_stale",
  POLICY_CHANGED: "loan.policy_changed",
  REVENUE: "loan.revenue",
});

// 18 Revenue Registry
const REV_ID = Object.freeze({
  PROTOCOL: "REV-LOAN-PROTOCOL",
  INTEREST: "REV-LOAN-INTEREST",
  PASTDUE: "REV-LOAN-PASTDUE",
  LIQ_COMP: "REV-LOAN-LIQ-COMP",
  COST_GAS: "COST-LOAN-GAS",
  COST_REALIZATION: "COST-LOAN-REALIZATION",
  RISK_RESERVE: "RISK-LOAN-RESERVE",
});

module.exports = {
  RULES_VERSION,
  ASSET,
  ASSET_ALIASES,
  TENOR_DAYS,
  APR_BPS,
  RISK,
  RULES,
  STATUS,
  OPEN_STATUSES,
  COUNTED_STATUSES,
  TERMINAL_STATUSES,
  RISK_LOCKED_STATUSES,
  SETTLEMENT_STATUS,
  RELEASE_STATUS,
  LIQUIDATION_TRIGGER,
  PRICE_STATUS,
  EVENT,
  REV_ID,
};
