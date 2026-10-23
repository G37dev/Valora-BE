/*
 * Membership Engine — Rolling 30-Day TWAB (brief 03).
 *
 * QualifiedBalance(t) = MAX(0, EligibleUserAssetsIDR(t) - RelatedLoanLiabilitiesIDR(t))
 * TWAB30(t)           = SUM_i(QB_i x Duration_i) / (30 x 24 x 3600)
 * CurrentTier(t)      = HighestTierWhere(TWAB30 >= Threshold)
 * IF EligibleHistory < 30 hari penuh -> Cadet
 *
 * Eligible assets (no double counting):
 *   - IDR internal wallet (termasuk referral IDR yang SUDAH di-claim)
 *   - crypto wallet on-chain (USDT/USDC/XAUT/GOLD) x validated price
 *   - Earn principal ACTIVE/CLAIMING (bukan yield)
 *   - Loan collateral locked x price  - (principal outstanding + unpaid interest)
 *   - Gold Installment: principal yang benar-benar dibayar (eligible paid)
 * Tidak termasuk: VP, referral IDR belum claim, deposit pending.
 *
 * Time series = loyalty_twab_events (step function). Snapshot dicatat saat
 * saldo berubah atau minimal tiap snapshot_min_interval_ms sebagai anchor.
 */

const Decimal = require("decimal.js");
const { Op } = require("sequelize");
const { createThirdwebClient, getContract } = require("thirdweb");
const { getBalance: getErc20Balance } = require("thirdweb/extensions/erc20");
const { sepolia } = require("../../utils/chain");
const {
  sequelize,
  Wallet,
  InternalWallet,
  EarnPosition,
  LoanPosition,
  InstallmentPlan,
  LoyaltyCustomer,
  LoyaltyTwabEvent,
  LoyaltyTierHistory,
} = require("../../models");
const configSvc = require("./loyalty.config");
const pricing = require("./loyalty.pricing");
const ledger = require("./loyalty.ledger");
const { big, max0 } = require("./loyalty.errors");
const { TIER } = require("./loyalty.constants");

const client = createThirdwebClient({ secretKey: process.env.THIRDWEB_SECRET_KEY || "" });
const TOKEN_CONTRACTS = {
  USDT: process.env.USDT_DUMMY_CONTRACT_ADDRESS,
  USDC: process.env.USDC_DUMMY_CONTRACT_ADDRESS,
  XAUT: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
  GOLD: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
};
const EARN_TOKEN_DECIMALS = Number(process.env.LOYALTY_EARN_TOKEN_DECIMALS || 6);
const ONCHAIN_ENABLED = String(process.env.LOYALTY_ONCHAIN_BALANCE || "1") !== "0";

const LOAN_OPEN = ["ACTIVE", "MARGIN_CALL", "LIQUIDATION_OBSERVATION", "RECOVERING", "PAST_DUE", "EMERGENCY", "LIQUIDATION_PENDING"];
const INST_OPEN = ["ACTIVE", "PAST_DUE", "RESTRUCTURED", "COMPLETE_PENDING_CLAIM", "CLAIMABLE", "CLAIMING"];

async function onchainBalances(address) {
  const out = {};
  if (!ONCHAIN_ENABLED || !address) return out;
  await Promise.all(
    Object.entries(TOKEN_CONTRACTS).map(async ([asset, contractAddress]) => {
      if (!contractAddress) return;
      try {
        const r = await getErc20Balance({
          contract: getContract({ client, chain: sepolia, address: contractAddress }),
          address,
        });
        out[asset] = r.displayValue || "0";
      } catch (error) {
        out[asset] = null; // RPC gagal -> DEFERRED
      }
    }),
  );
  return out;
}

/**
 * Hitung Qualified Balance saat ini. Return
 * { assets, liabilities, qualified, breakdown, priceStatus }.
 * priceStatus DEFERRED bila ada komponen crypto yang tidak bisa dinilai
 * (harga stale/missing atau RPC gagal) — caller tidak boleh menyimpan
 * nilai baru sebagai snapshot valid.
 */
async function computeQualifiedBalance(coreId, { now, config } = {}) {
  now = now || new Date();
  config = config || (await configSvc.resolve(now)).config;
  const breakdown = { wallet_idr: "0", crypto: {}, earn: {}, loan: {}, installment: "0" };
  let assets = 0n;
  let liabilities = 0n;
  let deferred = [];

  const val = async (asset, amount) => {
    const v = await pricing.valueIdr(asset, amount, { now, config });
    if (v.status !== "VALID") deferred.push(`${asset}:${v.status}`);
    return v;
  };

  // 1. IDR wallet
  const iw = await InternalWallet.findOne({ where: { coreId } });
  const walletIdr = big(iw?.balanceIdr || 0);
  assets += walletIdr;
  breakdown.wallet_idr = walletIdr.toString();

  // 2. Crypto on-chain
  const wallet = await Wallet.findOne({ where: { core_id: coreId } });
  const balances = await onchainBalances(wallet?.address);
  for (const [asset, bal] of Object.entries(balances)) {
    if (bal === null) {
      deferred.push(`${asset}:RPC`);
      continue;
    }
    if (new Decimal(bal).lte(0)) continue;
    const v = await val(asset, bal);
    assets += v.idr;
    breakdown.crypto[asset] = { amount: bal, idr: v.idr.toString(), price_idr: v.price_idr };
  }

  // 3. Earn principal (locked, bukan yield) — token sudah keluar dari wallet
  const earns = await EarnPosition.findAll({
    where: { coreId, status: { [Op.in]: ["ACTIVE", "CLAIMING"] } },
  });
  for (const e of earns) {
    const amount = pricing.fromRaw(e.principal, EARN_TOKEN_DECIMALS);
    const v = await val(e.asset, amount);
    assets += v.idr;
    breakdown.earn[e.id] = { asset: e.asset, amount, idr: v.idr.toString() };
  }

  // 4. Loan collateral (locked) minus related liabilities
  const loans = await LoanPosition.findAll({
    where: { coreId, status: { [Op.in]: LOAN_OPEN } },
  });
  for (const p of loans) {
    const v = await val(p.collateralAsset, new Decimal(p.lockedQty || 0).toFixed());
    const debt = big(new Decimal(p.principalOutstandingIdr || 0).plus(p.unpaidInterestIdr || 0).floor());
    assets += v.idr;
    liabilities += debt;
    breakdown.loan[p.id] = {
      asset: p.collateralAsset,
      locked_qty: new Decimal(p.lockedQty || 0).toFixed(),
      collateral_idr: v.idr.toString(),
      debt_idr: debt.toString(),
    };
  }

  // 5. Gold Installment — principal yang benar-benar dibayar
  const plans = await InstallmentPlan.findAll({
    where: { coreId, status: { [Op.in]: INST_OPEN } },
  });
  let instPaid = 0n;
  for (const pl of plans) {
    const paid = big(
      new Decimal(pl.standardEligiblePaidIdr ?? pl.grossCashPaidIdr ?? 0).floor(),
    );
    instPaid += paid;
  }
  assets += instPaid;
  breakdown.installment = instPaid.toString();

  return {
    assets,
    liabilities,
    qualified: max0(assets - liabilities),
    breakdown,
    priceStatus: deferred.length ? "DEFERRED" : "VALID",
    deferred,
  };
}

/**
 * Catat snapshot balance sebagai TWAB event bila berubah / anchor interval.
 * sourceEventId unik -> replay aman.
 */
async function recordBalanceEvent(coreId, { now, config, reason = "TICK", sourceEventId, force = false } = {}) {
  now = now || new Date();
  const resolved = await configSvc.resolve(now);
  config = config || resolved.config;
  const qb = await computeQualifiedBalance(coreId, { now, config });
  const last = await LoyaltyTwabEvent.findOne({
    where: { coreId },
    order: [["event_at", "DESC"]],
  });
  if (qb.priceStatus === "DEFERRED" && last && !force) {
    // Jangan minting value dari harga tidak valid — pertahankan level terakhir.
    return { recorded: false, reason: "PRICE_DEFERRED", deferred: qb.deferred, last };
  }
  const minInterval = Number(config.membership?.snapshot_min_interval_ms || 6 * 3600 * 1000);
  const changed = !last || big(last.qualifiedBalanceIdr) !== qb.qualified;
  const stale = !last || now.getTime() - new Date(last.eventAt).getTime() >= minInterval;
  if (!changed && !stale && !force) return { recorded: false, reason: "UNCHANGED", last };

  const [row, created] = await LoyaltyTwabEvent.findOrCreate({
    where: { sourceEventId: sourceEventId || `${coreId}:${reason}:${now.toISOString()}` },
    defaults: {
      coreId,
      eventAt: now,
      eligibleAssetsIdr: qb.assets.toString(),
      liabilitiesIdr: qb.liabilities.toString(),
      qualifiedBalanceIdr: qb.qualified.toString(),
      priceStatus: qb.priceStatus,
      breakdown: { ...qb.breakdown, reason, deferred: qb.deferred },
    },
  });
  const cust = await ledger.ensureCustomer(coreId, { now });
  if (!cust.historyStartAt) await cust.update({ historyStartAt: now });
  return { recorded: created, row, qb };
}

/**
 * TWAB30 dari step function. Return { twab, fullHistory, windowStart, samples }.
 * fullHistory = ada level yang berlaku di/sebelum windowStart (histori 30 hari penuh).
 */
async function computeTwab30(coreId, { now, config } = {}) {
  now = now || new Date();
  config = config || (await configSvc.resolve(now)).config;
  const windowMs = Number(config.membership?.twab_window_hours || 720) * 3600 * 1000;
  const windowStart = new Date(now.getTime() - windowMs);

  const before = await LoyaltyTwabEvent.findOne({
    where: { coreId, eventAt: { [Op.lte]: windowStart } },
    order: [["event_at", "DESC"]],
  });
  const inside = await LoyaltyTwabEvent.findAll({
    where: { coreId, eventAt: { [Op.gt]: windowStart, [Op.lte]: now } },
    order: [["event_at", "ASC"]],
  });

  const cust = await LoyaltyCustomer.findByPk(coreId);
  const historyStart = cust?.historyStartAt ? new Date(cust.historyStartAt) : null;
  const fullHistory = Boolean(before) || (historyStart && historyStart.getTime() <= windowStart.getTime());

  // Integrasi: level sebelum window dianggap berlaku dari windowStart.
  let weighted = new Decimal(0); // IDR x ms
  let cursor = windowStart.getTime();
  let level = before ? new Decimal(before.qualifiedBalanceIdr) : new Decimal(0);
  for (const ev of inside) {
    const t = new Date(ev.eventAt).getTime();
    weighted = weighted.plus(level.mul(t - cursor));
    cursor = t;
    level = new Decimal(ev.qualifiedBalanceIdr);
  }
  weighted = weighted.plus(level.mul(now.getTime() - cursor));
  const twab = big(weighted.div(windowMs).floor());
  return { twab, fullHistory, windowStart, samples: inside.length + (before ? 1 : 0) };
}

function resolveTier(config, twab, fullHistory) {
  const tiers = configSvc.tierTable(config);
  if (config.membership?.full_initial_history !== false && !fullHistory) {
    return { tier: tiers[0]?.code || TIER.CADET, reason: "HISTORY_INCOMPLETE" };
  }
  let tier = tiers[0]?.code || TIER.CADET;
  for (const t of tiers) if (twab >= BigInt(t.threshold_idr)) tier = t.code;
  return { tier, reason: "TWAB_THRESHOLD" };
}

/** Recompute tier + simpan history saat berubah. */
async function refreshTier(coreId, { now, config } = {}) {
  now = now || new Date();
  const resolved = await configSvc.resolve(now);
  config = config || resolved.config;
  const cust = await ledger.ensureCustomer(coreId, { now });
  const { twab, fullHistory } = await computeTwab30(coreId, { now, config });
  const { tier, reason } = resolveTier(config, twab, fullHistory);
  const previous = cust.currentTier;
  await cust.update({
    currentTier: tier,
    currentTwab30Idr: twab.toString(),
    fullHistory,
    tierComputedAt: now,
  });
  if (previous !== tier) {
    await LoyaltyTierHistory.create({
      coreId,
      effectiveAt: now,
      tier,
      previousTier: previous,
      twab30Idr: twab.toString(),
      fullHistory,
      configVersionId: resolved.versionId,
      decisionReason: `${reason}${twab >= big(cust.currentTwab30Idr) ? ":UP" : ":DOWN"}`,
    });
  }
  return { tier, previous, twab, fullHistory };
}

/** Snapshot tier untuk reward (tanpa recompute berat). */
async function tierSnapshot(coreId, { transaction } = {}) {
  const cust = await LoyaltyCustomer.findByPk(coreId, { transaction });
  return cust?.currentTier || TIER.CADET;
}

/** API: status membership. */
async function status(coreId, { now } = {}) {
  now = now || new Date();
  const resolved = await configSvc.resolve(now);
  const config = resolved.config;
  const cust = await ledger.ensureCustomer(coreId, { now });
  const { twab, fullHistory, windowStart, samples } = await computeTwab30(coreId, { now, config });
  const { tier } = resolveTier(config, twab, fullHistory);
  const tiers = configSvc.tierTable(config);
  const idx = tiers.findIndex((t) => t.code === tier);
  const next = tiers[idx + 1] || null;
  const history = await LoyaltyTierHistory.findAll({
    where: { coreId },
    order: [["effective_at", "DESC"]],
    limit: 12,
  });
  const lastEvent = await LoyaltyTwabEvent.findOne({ where: { coreId }, order: [["event_at", "DESC"]] });
  const historyStart = cust.historyStartAt ? new Date(cust.historyStartAt) : null;
  const daysOfHistory = historyStart ? Math.floor((now - historyStart) / 86400000) : 0;
  return {
    as_of: now,
    tier,
    multiplier_bps: configSvc.tierMultiplierBps(config, tier),
    twab30_idr: twab.toString(),
    full_history: fullHistory,
    history_days: Math.min(30, daysOfHistory),
    history_days_required: 30,
    window_start: windowStart,
    samples,
    next_tier: next
      ? { code: next.code, threshold_idr: next.threshold_idr, gap_idr: max0(BigInt(next.threshold_idr) - twab).toString() }
      : null,
    tiers: tiers.map((t) => ({ code: t.code, threshold_idr: t.threshold_idr, multiplier_bps: t.multiplier_bps, benefits: t.benefits || [] })),
    current_qualified_balance: lastEvent
      ? { idr: lastEvent.qualifiedBalanceIdr, at: lastEvent.eventAt, price_status: lastEvent.priceStatus, breakdown: lastEvent.breakdown }
      : null,
    fee_discount_cap_bps: config.redemption?.global_fee_discount_cap_bps ?? 4000,
    history: history.map((h) => ({ at: h.effectiveAt, tier: h.tier, previous: h.previousTier, twab30_idr: h.twab30Idr, reason: h.decisionReason })),
    config_version: resolved.version,
  };
}

module.exports = {
  computeQualifiedBalance,
  recordBalanceEvent,
  computeTwab30,
  resolveTier,
  refreshTier,
  tierSnapshot,
  status,
  sequelize,
};
