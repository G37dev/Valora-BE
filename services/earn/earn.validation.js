const normalizeAsset = (asset) => {
  if (asset === undefined || asset === null) {
    throw new Error("asset wajib diisi.");
  }

  if (typeof asset !== "string") {
    throw new Error("asset harus berupa string.");
  }

  const normalized = asset.trim().toUpperCase();

  if (!normalized) {
    throw new Error("asset wajib diisi.");
  }

  const allowedAssets = ["USDT", "USDC", "GOLD", "XAUT"];

  if (!allowedAssets.includes(normalized)) {
    throw new Error(`Asset tidak valid. Gunakan: ${allowedAssets.join(", ")}.`);
  }

  return normalized;
};

const isValidAddress = (address) => {
  return typeof address === "string" && /^0x[a-fA-F0-9]{40}$/.test(address);
};

const parseTokenAmount = (value, decimals) => {
  const input = String(value).trim();

  if (!/^\d+(\.\d+)?$/.test(input)) {
    throw new Error("amount tidak valid.");
  }

  const [whole, fraction = ""] = input.split(".");

  if (fraction.length > decimals) {
    throw new Error(`amount maksimal memiliki ${decimals} angka desimal.`);
  }

  const paddedFraction = fraction.padEnd(decimals, "0");

  return (
    BigInt(whole) * 10n ** BigInt(decimals) + BigInt(paddedFraction || "0")
  );
};

// Term yang valid sesuai brief: 90D/180D/360D.
// Term 1D (test) tetap diizinkan selama pool punya APR-nya.
const ALLOWED_TERMS = [1, 90, 180, 360];

const parseTermCode = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error("term_code wajib diisi.");
  }

  const result = Number(value);

  if (!Number.isInteger(result)) {
    throw new Error("term_code harus berupa integer.");
  }

  if (!ALLOWED_TERMS.includes(result)) {
    throw new Error(
      `term_code ${result} tidak didukung. Pilihan: ${ALLOWED_TERMS.join("/")}.`,
    );
  }

  return result;
};

module.exports = {
  normalizeAsset,
  isValidAddress,
  parseTokenAmount,
  parseTermCode,
};
