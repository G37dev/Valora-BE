/*
 * Price Sources & Oracle Adapter (brief 10).
 *
 * - XAUT: tabel prices (Indodax XAUT/IDR per GRAM -> dikonversi per token
 *   = per troy ounce, sama konvensi swap/installment). Freshness ketat.
 * - VVLR Gold: ShariaCoin per gram = per token. Update ~harian, Minggu
 *   tidak ada update -> SCHEDULED_NO_UPDATE (bukan API down).
 *
 * Status:
 *   VALID                -> boleh untuk risk & borrowing/release
 *   SCHEDULED_NO_UPDATE  -> boleh untuk risk (last verified), BLOK borrowing/release
 *   STALE / UNAVAILABLE  -> blok risk-increasing ops, jangan nilai HF aman
 *
 * Borrowing Eligible Price = MIN(spot, 15-minute TWAP) — anti flash bull.
 * Liquidation monitoring pakai Current Validated Price (bukan TWAP).
 *
 * QA: setTestPrice() (gated clock key) menulis override tick dengan
 * observed_at = business now, sehingga simulasi crash/bull deterministik
 * walau clock sedang time-travel.
 */

const { Op } = require("sequelize");
const Decimal = require("decimal.js");
const { Price, LoanPriceTick } = require("../../models");
const { ASSET, PRICE_STATUS, RULES } = require("./loan.constants");
const { riskParams, dec } = require("./loan.calc");
const cal = require("./loan.calendar");
const { LoanError } = require("./loan.errors");
const businessClock = require("../businessClock");

const OZ_TO_GRAMS = new Decimal("31.1035");

/** Harga per TOKEN dari row tabel prices (per gram). */
function perTokenFromRow(asset, row) {
  const perGram = dec(row.priceIdr);
  return asset === ASSET.XAUT ? perGram.mul(OZ_TO_GRAMS) : perGram;
}

function perGramFromToken(asset, perToken) {
  return asset === ASSET.XAUT ? dec(perToken).div(OZ_TO_GRAMS) : dec(perToken);
}

/** Rekam tick dari tabel prices bila ada update baru (dipanggil scheduler). */
async function recordTickFromPriceTable(asset, { transaction } = {}) {
  const row = await Price.findOne({ where: { asset }, transaction });
  if (!row) return null;
  // Model Price memakai timestamps dengan nama kolom custom (updated_at),
  // jadi atribut instance-nya adalah `updated_at`, bukan `updatedAt`.
  const observedAt = new Date(row.updated_at ?? row.updatedAt);
  const last = await LoanPriceTick.findOne({
    where: { asset, isOverride: false },
    order: [["observed_at", "DESC"]],
    transaction,
  });
  if (last && new Date(last.observedAt).getTime() >= observedAt.getTime()) {
    return last;
  }
  return LoanPriceTick.create(
    {
      asset,
      priceIdr: perTokenFromRow(asset, row).toFixed(18),
      source: row.source || "UNKNOWN",
      observedAt,
      fetchedAt: new Date(),
      isOverride: false,
    },
    { transaction },
  );
}

async function latestTick(asset, now, { transaction, simulated } = {}) {
  // Simulasi: override terakhir yang di-set QA menang (apa pun arah time-travel).
  if (simulated) {
    const override = await LoanPriceTick.findOne({
      where: { asset, isOverride: true },
      order: [["fetched_at", "DESC"]],
      transaction,
    });
    if (override) return override;
  }
  // Real: tick dengan observed_at <= now.
  let tick = await LoanPriceTick.findOne({
    where: { asset, observedAt: { [Op.lte]: now } },
    order: [["observed_at", "DESC"]],
    transaction,
  });
  if (!tick) tick = await recordTickFromPriceTable(asset, { transaction });
  return tick;
}

/** 15-minute TWAP dari tick (rata-rata sederhana observasi dalam window). */
async function twap(asset, now, { transaction } = {}) {
  const from = cal.addSeconds(now, -RULES.TWAP_WINDOW_MINUTES * 60);
  const ticks = await LoanPriceTick.findAll({
    where: { asset, observedAt: { [Op.between]: [from, now] } },
    order: [["observed_at", "ASC"]],
    transaction,
  });
  if (ticks.length < 2) return null;
  const sum = ticks.reduce((s, t) => s.plus(dec(t.priceIdr)), new Decimal(0));
  return sum.div(ticks.length);
}

/**
 * Validated current price untuk aset pada waktu bisnis `now`.
 * Return { priceIdr, status, source, observedAt, ageMs, usableForRisk,
 *          usableForBorrowing, eligiblePriceIdr }.
 */
async function getValidatedPrice(asset, now, { policy, transaction } = {}) {
  const risk = riskParams(asset, policy);
  const simulated = await businessClock.isSimulated();
  const tick = await latestTick(asset, now, { transaction, simulated });
  if (!tick) {
    return {
      asset,
      priceIdr: null,
      status: PRICE_STATUS.UNAVAILABLE,
      source: null,
      observedAt: null,
      ageMs: null,
      usableForRisk: false,
      usableForBorrowing: false,
      eligiblePriceIdr: null,
    };
  }
  const observedAt = new Date(tick.observedAt);
  const ageMs = now.getTime() - observedAt.getTime();

  let status = PRICE_STATUS.VALID;
  if (tick.isOverride && simulated) {
    // QA override: harga ditetapkan eksplisit pada waktu bisnis -> VALID
    status = PRICE_STATUS.VALID;
  } else if (ageMs > risk.maxPriceAgeMs) {
    status = PRICE_STATUS.STALE;
  } else if (
    asset === ASSET.GOLD &&
    cal.isBusinessSunday(now) &&
    ageMs > 20 * 3600 * 1000
  ) {
    status = PRICE_STATUS.SCHEDULED_NO_UPDATE;
  }

  const spot = dec(tick.priceIdr);
  const avg = await twap(asset, now, { transaction });
  const eligible = avg && avg.lt(spot) ? avg : spot;

  return {
    asset,
    priceIdr: spot,
    status,
    source: tick.source,
    observedAt,
    ageMs,
    isOverride: Boolean(tick.isOverride),
    usableForRisk:
      status === PRICE_STATUS.VALID ||
      status === PRICE_STATUS.SCHEDULED_NO_UPDATE,
    usableForBorrowing: status === PRICE_STATUS.VALID,
    twapIdr: avg,
    eligiblePriceIdr: eligible,
  };
}

function requireBorrowingPrice(p) {
  if (!p.usableForBorrowing) {
    throw new LoanError(
      `Price for ${p.asset} is ${p.status}; try again later`,
      {
        status: 503,
        code: `PRICE_${p.status}`,
        details: { age_ms: p.ageMs, observed_at: p.observedAt },
      },
    );
  }
  return p;
}

/** QA/admin: set harga per TOKEN pada waktu bisnis `now`. */
async function setTestPrice(
  asset,
  priceIdrPerToken,
  now,
  { source = "TEST_OVERRIDE" } = {},
) {
  const perToken = dec(priceIdrPerToken);
  if (!perToken.gt(0)) {
    throw new LoanError("price_idr must be > 0", { code: "INVALID_PRICE" });
  }
  await Price.upsert({
    asset,
    priceIdr: perGramFromToken(asset, perToken).toFixed(2),
    source,
  });
  const tick = await LoanPriceTick.create({
    asset,
    priceIdr: perToken.toFixed(18),
    source,
    observedAt: now,
    fetchedAt: new Date(),
    isOverride: true,
  });
  return tick;
}

module.exports = {
  OZ_TO_GRAMS,
  perTokenFromRow,
  recordTickFromPriceTable,
  getValidatedPrice,
  requireBorrowingPrice,
  setTestPrice,
  twap,
};
