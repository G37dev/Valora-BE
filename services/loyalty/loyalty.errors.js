const Decimal = require("decimal.js");

class LoyaltyError extends Error {
  constructor(message, { status = 400, code = "LOYALTY_ERROR", details } = {}) {
    super(message);
    this.name = "LoyaltyError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function toJsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Decimal) return value.toFixed();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]),
    );
  }
  return value;
}

/** Parse ke BigInt integer non-negatif (IDR / VP). Decimal -> floor. */
function big(value, label = "amount") {
  if (value === null || value === undefined || value === "") return 0n;
  if (typeof value === "bigint") return value;
  const d = new Decimal(String(value));
  if (d.isNaN()) throw new LoyaltyError(`${label} invalid`, { code: "INVALID_AMOUNT" });
  return BigInt(d.floor().toFixed(0));
}

const max0 = (v) => (v < 0n ? 0n : v);
const min = (a, b) => (a < b ? a : b);

/** FLOOR(amount x bps / 10000) dalam BigInt. */
const applyBps = (amount, bps) => (big(amount) * BigInt(bps)) / 10000n;

module.exports = { LoyaltyError, toJsonSafe, big, max0, min, applyBps };
