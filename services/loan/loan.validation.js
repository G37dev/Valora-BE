const Decimal = require("decimal.js");
const { ASSET_ALIASES, TENOR_DAYS } = require("./loan.constants");
const { LoanError } = require("./loan.errors");

function normalizeAsset(asset) {
  const key = String(asset || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  const normalized = ASSET_ALIASES[key];
  if (!normalized) {
    throw new LoanError(`Unsupported collateral asset: ${asset}`, {
      code: "ASSET_NOT_SUPPORTED",
    });
  }
  return normalized;
}

function parseTenor(tenor) {
  const value = Number(tenor);
  if (!TENOR_DAYS.includes(value)) {
    throw new LoanError(`tenor_days must be one of ${TENOR_DAYS.join("/")}`, {
      code: "INVALID_TENOR",
    });
  }
  return value;
}

/** Token quantity: positive decimal, max 18 dp. */
function parseQty(amount, field = "collateral_qty") {
  let value;
  try {
    value = new Decimal(String(amount ?? "").trim());
  } catch {
    value = null;
  }
  if (!value || !value.isFinite() || value.lte(0)) {
    throw new LoanError(`${field} must be a positive number`, {
      code: "INVALID_QTY",
    });
  }
  if (value.decimalPlaces() > 18) {
    throw new LoanError(`${field} max 18 decimal places`, {
      code: "INVALID_QTY",
    });
  }
  return value;
}

/** Nominal IDR integer positif. */
function parseIdr(amount, field = "amount_idr") {
  const str = String(amount ?? "").trim();
  if (!/^\d+$/.test(str) || BigInt(str) <= 0n) {
    throw new LoanError(`${field} must be a positive IDR integer`, {
      code: "INVALID_AMOUNT",
    });
  }
  return new Decimal(str);
}

function requireIdempotencyKey(key) {
  const value = String(key || "").trim();
  if (!value || value.length > 128) {
    throw new LoanError("idempotency_key is required (max 128 chars)", {
      code: "INVALID_IDEMPOTENCY_KEY",
    });
  }
  return value;
}

function parseBool(v) {
  return v === true || v === "true" || v === "1" || v === 1;
}

module.exports = {
  normalizeAsset,
  parseTenor,
  parseQty,
  parseIdr,
  requireIdempotencyKey,
  parseBool,
};
