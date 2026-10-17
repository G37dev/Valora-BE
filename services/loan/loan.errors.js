const Decimal = require("decimal.js");

class LoanError extends Error {
  constructor(message, { status = 400, code = "LOAN_ERROR", details } = {}) {
    super(message);
    this.name = "LoanError";
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

module.exports = { LoanError, toJsonSafe };
