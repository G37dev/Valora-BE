/*
 * Gold Installment - canonical rules (Developer Brief v1.2).
 *
 * Semua rate disimpan dalam BPS (1% = 100 bps).
 * Semua IDR final adalah integer (BigInt / BIGINT).
 */

const RULES_VERSION = "GI-1.2";

const PLAN_TYPE = Object.freeze({
  STANDARD: "STANDARD",
  FLEXIBLE: "FLEXIBLE",
});

const ASSET = Object.freeze({
  GOLD: "GOLD", // VVLR Gold
  XAUT: "XAUT",
});

const ASSET_ALIASES = Object.freeze({
  GOLD: ASSET.GOLD,
  VVLR_GOLD: ASSET.GOLD,
  VVLRGOLD: ASSET.GOLD,
  XAUT: ASSET.XAUT,
});

const INSTALLMENT_GAP = Object.freeze({
  WEEKLY: "WEEKLY",
  MONTHLY: "MONTHLY",
});

const TENOR_MONTHS = Object.freeze([3, 6, 12]);

const STATUS = Object.freeze({
  REQUEST_CREATED: "REQUEST_CREATED",
  REQUEST_EXPIRED: "REQUEST_EXPIRED",
  ACTIVE: "ACTIVE",
  CANCELLATION_CLOSED: "CANCELLATION_CLOSED",
  PAST_DUE: "PAST_DUE",
  RESTRUCTURED: "RESTRUCTURED",
  COMPLETE_PENDING_CLAIM: "COMPLETE_PENDING_CLAIM",
  CLAIMABLE: "CLAIMABLE",
  AUTO_LIQUIDATED: "AUTO_LIQUIDATED",
  CANCELLED: "CANCELLED",
  CLOSED: "CLOSED",
});

const RUNNING_STATUSES = Object.freeze([
  STATUS.ACTIVE,
  STATUS.CANCELLATION_CLOSED,
  STATUS.RESTRUCTURED,
]);

const TERMINAL_STATUSES = Object.freeze([
  STATUS.REQUEST_EXPIRED,
  STATUS.AUTO_LIQUIDATED,
  STATUS.CANCELLED,
  STATUS.CLOSED,
]);

const PAYMENT_KIND = Object.freeze({
  INITIAL: "INITIAL",
  PAYMENT: "PAYMENT",
  SETTLEMENT: "SETTLEMENT",
});

const PROTOCOL_FEE_STATUS = Object.freeze({
  NOT_CHARGED: "NOT_CHARGED",
  PENDING: "PENDING",
  CHARGED: "CHARGED",
  REVERSED: "REVERSED",
});

// 5.3 Standard markup matrix (bps) per asset / tenor
const STANDARD_MARKUP_BPS = Object.freeze({
  GOLD: Object.freeze({ 3: 250, 6: 500, 12: 950 }),
  XAUT: Object.freeze({ 3: 300, 6: 550, 12: 1000 }),
});

// 6.2 Flexible price-lock margin (bps) per max tenor
const PRICE_LOCK_MARGIN_BPS = Object.freeze({ 3: 150, 6: 300, 12: 500 });

// 10.1 Restructure extension (calendar months) per original max tenor
const RESTRUCTURE_EXTENSION_MONTHS = Object.freeze({ 3: 1, 6: 2, 12: 3 });

const RULES = Object.freeze({
  REQUEST_WINDOW_HOURS: 4,
  MIN_INSTALLMENT_IDR: 100000n,
  MIN_PAYMENT_IDR: 100000n,
  DP_MIN_BPS: 3000,
  DP_MAX_BPS: 5000,
  CARRYING_BPS: 100,
  LATE_PENALTY_DAILY_BPS: 5,
  LATE_PENALTY_CAP_BPS: 200,
  PAST_DUE_PENALTY_BPS: 250,
  CURE_DAYS: 7,
  RESTRUCTURE_FEE_BPS: 100,
  RESTRUCTURE_MIN_PC_BPS: 8000, // strictly greater than
  CANCEL_MAX_PC_BPS: 5000, // inclusive
  CANCEL_FLOOR_BPS: 300,
  CANCEL_CAP_BPS: 600,
  CANCEL_CURVE_START_PC_BPS: 3000,
  CANCEL_CURVE_END_PC_BPS: 8000,
  ALC_START_PC_BPS: 3000,
  ALC_END_PC_BPS: 8000,
  ALC_START_RATE_BPS: 5000,
  ALC_END_RATE_BPS: 1000,
  ALC_FLOOR_LPV_BPS: 800,
  PROTOCOL_FEE_BPS: 25,
  CLAIM_DELAY_DAYS: 30,
  H3_REMINDER_DAYS: 3,
});

const EVENT = Object.freeze({
  REQUEST_CREATED: "installment.request_created",
  REQUEST_EXPIRED: "installment.request_expired",
  ACTIVATED: "installment.activated",
  PAYMENT_APPLIED: "installment.payment_applied",
  CARRYING_ACCRUED: "installment.carrying_accrued",
  LATE_PENALTY_ACCRUED: "installment.late_penalty_accrued",
  CANCELLATION_CLOSED: "installment.cancellation_closed",
  CANCELLED: "installment.cancelled",
  PAST_DUE: "installment.past_due",
  RESTRUCTURE_ACTIVATED: "installment.restructure_activated",
  RESTRUCTURE_H3_NOTICE: "installment.restructure_h3_notice",
  AUTO_LIQUIDATED: "installment.auto_liquidated",
  FULLY_SETTLED: "installment.fully_settled",
  CLAIMABLE: "installment.claimable",
  CLAIM_FEE_QUOTED: "installment.claim_fee_quoted",
  ASSET_RELEASED: "installment.asset_released",
  PROTOCOL_FEE_CHARGED: "installment.protocol_fee_charged",
  CLAIM_NETWORK_FEE_RECORDED: "installment.claim_network_fee_recorded",
  REVENUE: "installment.revenue",
});

const REV_ID = Object.freeze({
  STD_MARKUP: "REV-GI-STD-MARKUP",
  STD_LATE: "REV-GI-STD-LATE",
  STD_CANCEL: "REV-GI-STD-CANCEL",
  FLEX_LOCK: "REV-GI-FLEX-LOCK",
  FLEX_CARRY: "REV-GI-FLEX-CARRY",
  FLEX_CANCEL: "REV-GI-FLEX-CANCEL",
  FLEX_PASTDUE: "REV-GI-FLEX-PASTDUE",
  FLEX_RESTRUCT: "REV-GI-FLEX-RESTRUCT",
  FLEX_ALC: "REV-GI-FLEX-ALC",
  PROTOCOL_FEE: "REV-GI-PROTOCOL-FEE",
});

module.exports = {
  RULES_VERSION,
  PLAN_TYPE,
  ASSET,
  ASSET_ALIASES,
  INSTALLMENT_GAP,
  TENOR_MONTHS,
  STATUS,
  RUNNING_STATUSES,
  TERMINAL_STATUSES,
  PAYMENT_KIND,
  PROTOCOL_FEE_STATUS,
  STANDARD_MARKUP_BPS,
  PRICE_LOCK_MARGIN_BPS,
  RESTRUCTURE_EXTENSION_MONTHS,
  RULES,
  EVENT,
  REV_ID,
};
