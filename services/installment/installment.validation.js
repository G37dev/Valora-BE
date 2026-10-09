const Decimal = require("decimal.js");
const {
  PLAN_TYPE,
  ASSET_ALIASES,
  INSTALLMENT_GAP,
  TENOR_MONTHS,
  RULES,
} = require("./installment.constants");
const { InstallmentError } = require("./installment.errors");

function normalizeAsset(asset) {
  const key = String(asset || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  const normalized = ASSET_ALIASES[key];
  if (!normalized) {
    throw new InstallmentError(`Unsupported asset: ${asset}`, {
      code: "ASSET_NOT_SUPPORTED",
    });
  }
  return normalized;
}

function parsePlanType(planType) {
  const value = String(planType || "")
    .trim()
    .toUpperCase();
  if (!PLAN_TYPE[value]) {
    throw new InstallmentError("plan_type must be STANDARD or FLEXIBLE", {
      code: "INVALID_PLAN_TYPE",
    });
  }
  return value;
}

function parseTenor(tenor) {
  const value = Number(tenor);
  if (!TENOR_MONTHS.includes(value)) {
    throw new InstallmentError(
      `tenor_months must be one of ${TENOR_MONTHS.join("/")}`,
      { code: "INVALID_TENOR" },
    );
  }
  return value;
}

function parseGap(gap) {
  const value = String(gap || "")
    .trim()
    .toUpperCase();
  if (!INSTALLMENT_GAP[value]) {
    throw new InstallmentError("installment_gap must be WEEKLY or MONTHLY", {
      code: "INVALID_GAP",
    });
  }
  return value;
}

/** Asset/token quantity; positive decimal string, max 18 decimal places. */
function parseGoldAmount(amount) {
  let value;
  try {
    value = new Decimal(String(amount ?? "").trim());
  } catch {
    value = null;
  }
  if (!value || !value.isFinite() || value.lte(0)) {
    throw new InstallmentError("gold_amount must be a positive number", {
      code: "INVALID_GOLD_AMOUNT",
    });
  }
  if (value.decimalPlaces() > 18) {
    throw new InstallmentError("gold_amount max 18 decimal places", {
      code: "INVALID_GOLD_AMOUNT",
    });
  }
  return value.toFixed();
}

/**
 * Terima dp_bps (3000..5000) atau dp_percent (30..50).
 */
function parseDpBps({ dp_bps, dp_percent }) {
  let bps;
  if (dp_bps !== undefined && dp_bps !== null && dp_bps !== "") {
    bps = Number(dp_bps);
  } else if (
    dp_percent !== undefined &&
    dp_percent !== null &&
    dp_percent !== ""
  ) {
    bps = Math.round(Number(dp_percent) * 100);
  }
  if (
    !Number.isInteger(bps) ||
    bps < RULES.DP_MIN_BPS ||
    bps > RULES.DP_MAX_BPS
  ) {
    throw new InstallmentError(
      `Down Payment must be between ${RULES.DP_MIN_BPS / 100}% and ${RULES.DP_MAX_BPS / 100}%`,
      { code: "INVALID_DP" },
    );
  }
  return bps;
}

/** Nominal IDR integer positif (string/number). */
function parseIdrAmount(amount, field = "amount_idr") {
  const str = String(amount ?? "").trim();
  if (!/^\d+$/.test(str) || BigInt(str) <= 0n) {
    throw new InstallmentError(`${field} must be a positive IDR integer`, {
      code: "INVALID_AMOUNT",
    });
  }
  return BigInt(str);
}

function requireIdempotencyKey(key) {
  const value = String(key || "").trim();
  if (!value || value.length > 128) {
    throw new InstallmentError(
      "idempotency_key wajib diisi (maks 128 karakter)",
      {
        code: "INVALID_IDEMPOTENCY_KEY",
      },
    );
  }
  return value;
}

module.exports = {
  normalizeAsset,
  parsePlanType,
  parseTenor,
  parseGap,
  parseGoldAmount,
  parseDpBps,
  parseIdrAmount,
  requireIdempotencyKey,
};
