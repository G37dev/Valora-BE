/*
 * Valuation IDR equivalent (brief 2.3 / 5.2 / 3.2).
 *
 * Sumber harga = tabel prices (authoritative price service produk; sama
 * dengan yang dipakai Swap). XAUT disimpan per gram -> x 31.1035 per token.
 * Harga stale (lebih tua dari price_max_age_ms) -> status STALE dan TIDAK
 * dipakai untuk minting value baru; caller memutuskan defer/skip.
 */

const Decimal = require("decimal.js");
const { Price } = require("../../models");
const { big } = require("./loyalty.errors");

const PRICE_UNIT_GRAMS = { XAUT: "31.1035" };
const normalizeAsset = (a) => {
  const s = String(a || "").toUpperCase();
  if (["VVLR", "VVLR_GOLD", "VVLRGOLD"].includes(s)) return "GOLD";
  return s;
};

/**
 * Konversi amount (display units: "100.5" USDT) ke IDR integer.
 * Return { idr: bigint, status, price_idr, price_at, source, asset }.
 */
async function valueIdr(
  asset,
  amount,
  { now = new Date(), config, transaction } = {},
) {
  const a = normalizeAsset(asset);
  const amt = new Decimal(String(amount || 0));
  if (a === "IDR") {
    return {
      asset: a,
      idr: big(amt),
      status: "VALID",
      price_idr: "1",
      price_at: now,
      source: "IDR",
    };
  }
  const price = await Price.findOne({ where: { asset: a }, transaction });
  if (!price || new Decimal(price.priceIdr || 0).lte(0)) {
    return {
      asset: a,
      idr: 0n,
      status: "MISSING",
      price_idr: null,
      price_at: null,
      source: null,
    };
  }
  const maxAge = Number(
    config?.membership?.price_max_age_ms || 24 * 60 * 60 * 1000,
  );
  const rawAt =
    price.get?.("updated_at") ||
    price.updatedAt ||
    price.get?.("created_at") ||
    price.createdAt;
  const at =
    rawAt && !Number.isNaN(new Date(rawAt).getTime()) ? new Date(rawAt) : now;
  const stale = Math.abs(now.getTime() - at.getTime()) > maxAge;
  const grams = config?.membership?.xaut_grams_per_token || PRICE_UNIT_GRAMS[a];
  const unitPrice =
    a === "XAUT"
      ? new Decimal(price.priceIdr).mul(grams)
      : new Decimal(price.priceIdr);
  return {
    asset: a,
    idr: big(amt.mul(unitPrice)),
    status: stale ? "STALE" : "VALID",
    price_idr: unitPrice.toFixed(2),
    price_at: at,
    source: price.source || "prices",
  };
}

/** Smallest units (raw uint) -> display units string. */
function fromRaw(raw, decimals) {
  return new Decimal(String(raw || 0))
    .div(new Decimal(10).pow(decimals))
    .toFixed();
}

module.exports = { valueIdr, fromRaw, normalizeAsset };
