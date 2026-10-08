class InstallmentError extends Error {
  constructor(message, { status = 400, code = "INSTALLMENT_ERROR", details } = {}) {
    super(message);
    this.name = "InstallmentError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function toJsonSafe(value) {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]),
    );
  }
  return value;
}

module.exports = { InstallmentError, toJsonSafe };
