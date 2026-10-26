/*
 * Admin / Treasury (brief 16, 19): positions table, risk events, reserve,
 * treasury lots (uPNL, BEP, recovery gap), policy administration, dan
 * kontrol QA (harga uji, paksa likuidasi).
 */

const { Op } = require("sequelize");
const {
  sequelize,
  LoanPosition,
  LoanTreasuryLot,
  LoanLiquidation,
  LoanEvent,
  LoanRiskSnapshot,
} = require("../../models");
const calc = require("./loan.calc");
const engine = require("./loan.engine");
const pool = require("./loan.pool");
const pricing = require("./loan.pricing");
const ledger = require("./loan.ledger");
const liquidation = require("./loan.liquidation");
const service = require("./loan.service");
const { getActivePolicy } = require("./loan.policy");
const { LoanError, toJsonSafe } = require("./loan.errors");
const {
  ASSET,
  STATUS,
  OPEN_STATUSES,
  EVENT,
  REV_ID,
  LIQUIDATION_TRIGGER,
} = require("./loan.constants");

const { dec, ZERO, clamp0, minDec } = calc;

// ============================================================
// Positions & risk events
// ============================================================

async function positions({ status, asset, coreId, limit = 100, now }) {
  const where = {};
  if (status) where.status = String(status).toUpperCase();
  else where.status = { [Op.in]: OPEN_STATUSES };
  if (asset) where.collateralAsset = asset;
  if (coreId) where.coreId = coreId;
  const rows = await LoanPosition.findAll({
    where,
    order: [["created_at", "DESC"]],
    limit: Number(limit),
  });
  const policy = await getActivePolicy(now);
  const priceCache = {};
  const out = [];
  for (const p of rows) {
    if (!priceCache[p.collateralAsset]) {
      priceCache[p.collateralAsset] = await pricing.getValidatedPrice(
        p.collateralAsset,
        now,
        { policy },
      );
    }
    const ser = await service.serializePosition(p, {
      now,
      policy,
      price: priceCache[p.collateralAsset],
    });
    out.push({
      ...ser,
      core_id: p.coreId,
      next_event_at: p.nextEventAt,
      borrower_cycle_id: p.borrowerCycleId,
    });
  }
  return toJsonSafe({ count: out.length, prices: priceCache, positions: out });
}

async function riskEvents({ positionId, limit = 200 }) {
  const where = {
    eventType: {
      [Op.in]: [
        EVENT.MARGIN_CALL,
        EVENT.OBSERVATION_STARTED,
        EVENT.RECOVERED,
        EVENT.EMERGENCY,
        EVENT.MATURED,
        EVENT.CURE_STARTED,
        EVENT.CURE_TERMINATED,
        EVENT.LIQUIDATION_AUTHORIZED,
        EVENT.AUTO_LIQUIDATED,
        EVENT.PRICE_STALE,
        EVENT.RELEASE_PENDING_RETRY,
      ],
    },
  };
  if (positionId) where.positionId = positionId;
  const events = await LoanEvent.findAll({
    where,
    order: [["effective_at", "DESC"]],
    limit: Number(limit),
  });
  const snapshots = positionId
    ? await LoanRiskSnapshot.findAll({
        where: { positionId },
        order: [["as_of", "DESC"]],
        limit: 100,
      })
    : [];
  return toJsonSafe({ events, snapshots });
}

// ============================================================
// Pool / reserve
// ============================================================

async function poolDashboard(now) {
  const policy = await getActivePolicy(now);
  const row = await pool.getPool();
  const m = pool.metrics(row, policy);
  const pendingLiq = await LoanLiquidation.count({
    where: { state: { [Op.in]: ["AUTHORIZED", "SUBMITTED", "FAILED_RETRY"] } },
  });
  const failedFinalLiq = await LoanLiquidation.count({
    where: { state: "FAILED_FINAL" },
  });
  return toJsonSafe({
    ...m,
    pending_liquidations: pendingLiq,
    failed_final_liquidations: failedFinalLiq,
    policy_version: policy.version,
    updated_at: row.updated_at ?? row.updatedAt,
    updated_by: row.updatedBy,
  });
}

async function updatePool(body, actor) {
  const allowed = {
    eligible_lending_capital_idr: "eligibleLendingCapitalIdr",
    protected_reserve_idr: "protectedReserveIdr",
    protected_reserve_target_idr: "protectedReserveTargetIdr",
    confirmed_cash_idr: "confirmedCashIdr",
    lending_paused: "lendingPaused",
    pause_reason: "pauseReason",
  };
  const patch = { updatedBy: actor || null };
  for (const [k, field] of Object.entries(allowed)) {
    if (body[k] === undefined) continue;
    patch[field] =
      field === "lendingPaused"
        ? Boolean(body[k])
        : field === "pauseReason"
          ? String(body[k])
          : dec(body[k]).toFixed(18);
  }
  return sequelize.transaction(async (t) => {
    const row = await pool.getPool({ transaction: t, lock: true });
    await row.update(patch, { transaction: t });
    await pool.snapshot(row, "ADMIN_UPDATE", {
      now: new Date(),
      transaction: t,
    });
    return row;
  });
}

async function injectReserve(body, actor, now) {
  const amount = dec(body.amount_idr);
  if (!amount.gt(0))
    throw new LoanError("amount_idr must be > 0", { code: "INVALID_AMOUNT" });
  return sequelize.transaction(async (t) => {
    const row = await pool.getPool({ transaction: t, lock: true });
    await pool.injectReserve(row, amount, { transaction: t });
    await row.update({ updatedBy: actor || null }, { transaction: t });
    await pool.snapshot(row, "RESERVE_INJECTION", { now, transaction: t });
    await ledger.recordRevenue(
      null,
      {
        revId: REV_ID.RISK_RESERVE,
        amountIdr: amount,
        sourceTxId: `inject:${now.toISOString()}`,
        effectiveAt: now,
        metadata: { actor, kind: "reserve_injection" },
      },
      t,
    );
    return row;
  });
}

// ============================================================
// Treasury: lots, uPNL, BEP, recovery gap
// ============================================================

async function treasuryDashboard(now) {
  const policy = await getActivePolicy(now);
  const lots = await LoanTreasuryLot.findAll({
    where: { status: { [Op.ne]: "SOLD" } },
    order: [["received_at", "ASC"]],
  });
  const perAsset = {};
  const detail = [];
  for (const asset of Object.values(ASSET)) {
    const price = await pricing.getValidatedPrice(asset, now, { policy });
    const mark = price.priceIdr || ZERO;
    const group = lots.filter((l) => l.asset === asset);
    let qty = ZERO,
      qtyDebt = ZERO,
      entryValue = ZERO,
      advance = ZERO,
      markValue = ZERO;
    for (const l of group) {
      const q = dec(l.qtyRemaining);
      qty = qty.plus(q);
      entryValue = entryValue.plus(q.mul(dec(l.entryPriceIdr)));
      markValue = markValue.plus(q.mul(mark));
      if (l.lotType === "DEBT_RECOVERY") {
        qtyDebt = qtyDebt.plus(q);
        advance = advance.plus(dec(l.advanceRemainingIdr));
      }
      const uPnl = q.mul(mark).minus(q.mul(dec(l.entryPriceIdr)));
      detail.push({
        lot_id: l.id,
        asset,
        lot_type: l.lotType,
        source_position_id: l.sourcePositionId,
        liquidation_id: l.liquidationId,
        qty_original: l.qtyOriginal,
        qty_remaining: q,
        entry_price_idr: l.entryPriceIdr,
        advance_remaining_idr: l.advanceRemainingIdr,
        mark_price_idr: mark,
        mark_value_idr: q.mul(mark),
        upnl_idr: uPnl,
        bep_price_idr:
          l.lotType === "DEBT_RECOVERY" && q.gt(0)
            ? dec(l.advanceRemainingIdr).div(q)
            : null,
        holding_age_days: Math.floor(
          calc
            .dec((now.getTime() - new Date(l.receivedAt).getTime()) / 86400000)
            .toNumber(),
        ),
        status: l.status,
        realized_pnl_idr: l.realizedPnlIdr,
      });
    }
    const exchangeFeeBps = Number(process.env.LOAN_EXCHANGE_FEE_BPS || 0);
    const fixedSellCost = dec(process.env.LOAN_FIXED_SELL_COST_IDR || 0);
    const netSaleable = qtyDebt.mul(dec(1).minus(calc.bpsFrac(exchangeFeeBps)));
    perAsset[asset] = {
      price_mark_idr: mark,
      price_status: price.status,
      price_observed_at: price.observedAt,
      lots: group.length,
      qty_total: qty,
      qty_debt_recovery: qtyDebt,
      weighted_entry_price_idr: qty.gt(0) ? entryValue.div(qty) : null,
      inventory_mark_value_idr: markValue,
      upnl_idr: markValue.minus(entryValue),
      outstanding_advance_idr: advance,
      estimated_net_sell_value_idr: netSaleable.mul(mark).minus(fixedSellCost),
      recovery_gap_idr: netSaleable
        .mul(mark)
        .minus(fixedSellCost)
        .minus(advance),
      portfolio_recovery_bep_idr: netSaleable.gt(0)
        ? advance.plus(fixedSellCost).div(netSaleable)
        : null,
      exchange_fee_bps: exchangeFeeBps,
      fixed_sell_cost_idr: fixedSellCost,
    };
  }
  const poolRow = await pool.getPool();
  const realized = await LoanTreasuryLot.sum("realizedPnlIdr");
  return toJsonSafe({
    per_asset: perAsset,
    lots: detail,
    realized_pnl_total_idr: realized || 0,
    pool: pool.metrics(poolRow, policy),
  });
}

/**
 * Catat penjualan aktual lot (confirmed filled qty, net proceeds, biaya).
 * Proceeds menutup advance; TIDAK menambah eligible lending capital.
 */
async function recordTreasurySale(body, actor, now) {
  const qty = dec(body.qty);
  const netProceeds = dec(body.net_proceeds_idr);
  const cost = dec(body.cost_idr || 0);
  if (!qty.gt(0) || !netProceeds.gte(0))
    throw new LoanError("qty and net_proceeds_idr required", {
      code: "INVALID_SALE",
    });
  return sequelize.transaction(async (t) => {
    const lot = await LoanTreasuryLot.findByPk(body.lot_id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!lot)
      throw new LoanError("Lot not found", {
        status: 404,
        code: "LOT_NOT_FOUND",
      });
    const remaining = dec(lot.qtyRemaining);
    if (qty.gt(remaining))
      throw new LoanError("qty exceeds lot remaining", {
        code: "INVALID_SALE",
        details: { remaining: remaining.toFixed(6) },
      });
    const share = qty.div(remaining);
    const advanceShare = dec(lot.advanceRemainingIdr).mul(share);
    const costBasis = qty.mul(dec(lot.entryPriceIdr));
    const pnl = netProceeds.minus(costBasis);
    const newRemaining = remaining.minus(qty);
    await lot.update(
      {
        qtyRemaining: newRemaining.toFixed(18),
        advanceRemainingIdr: clamp0(
          dec(lot.advanceRemainingIdr).minus(advanceShare),
        ).toFixed(18),
        realizedProceedsIdr: dec(lot.realizedProceedsIdr)
          .plus(netProceeds)
          .toFixed(18),
        realizedCostIdr: dec(lot.realizedCostIdr).plus(cost).toFixed(18),
        realizedPnlIdr: dec(lot.realizedPnlIdr).plus(pnl).toFixed(18),
        status: newRemaining.lte(0) ? "SOLD" : "PARTIALLY_SOLD",
        sales: [
          ...(lot.sales || []),
          {
            at: now,
            qty: qty.toFixed(6),
            net_proceeds_idr: netProceeds.toFixed(0),
            cost_idr: cost.toFixed(0),
            actor,
            reference: body.reference || null,
          },
        ],
      },
      { transaction: t },
    );
    const poolRow = await pool.getPool({ transaction: t, lock: true });
    const applied =
      lot.lotType === "DEBT_RECOVERY"
        ? await pool.applyTreasuryProceeds(poolRow, netProceeds, {
            transaction: t,
          })
        : ZERO;
    await pool.snapshot(poolRow, "TREASURY_SALE", { now, transaction: t });
    const p = await LoanPosition.findByPk(lot.sourcePositionId, {
      transaction: t,
    });
    if (cost.gt(0)) {
      await ledger.recordRevenue(
        p,
        {
          revId: REV_ID.COST_REALIZATION,
          amountIdr: cost.neg(),
          sourceTxId: `${lot.id}:${now.toISOString()}`,
          effectiveAt: now,
          metadata: { lot_id: lot.id },
        },
        t,
      );
    }
    await ledger.recordEvent(
      p,
      {
        eventType: EVENT.TREASURY_RECONCILED,
        effectiveAt: now,
        amountIdr: netProceeds,
        amountQty: qty,
        metadata: {
          lot_id: lot.id,
          pnl_idr: pnl,
          advance_applied_idr: applied,
        },
      },
      t,
    );
    if (p && lot.lotType === "DEBT_RECOVERY" && newRemaining.lte(0)) {
      await p.update(
        { settlementStatus: "TREASURY_RECONCILED" },
        { transaction: t },
      );
    }
    return { lot, pnl_idr: pnl, advance_applied_idr: applied };
  });
}

// ============================================================
// Policy impact simulation
// ============================================================

async function simulatePolicyImpact(body, now) {
  const policy = await getActivePolicy(now);
  const draft = { ...policy, risk: { ...policy.risk } };
  for (const [asset, r] of Object.entries(body.risk || {}))
    draft.risk[asset] = { ...policy.risk[asset], ...r };
  const rows = await LoanPosition.findAll({
    where: { status: { [Op.in]: OPEN_STATUSES } },
  });
  const out = [];
  const prices = {};
  for (const p of rows) {
    prices[p.collateralAsset] ||= await pricing.getValidatedPrice(
      p.collateralAsset,
      now,
      { policy },
    );
    const price = prices[p.collateralAsset];
    if (!price.priceIdr) continue;
    const s = engine.loadState(p);
    const d = engine.dues(s);
    const coll = calc.collateralValue(s.lockedQty, price.priceIdr);
    const ltv = calc.ltvBps(d.tdd, coll);
    const zone = (risk) =>
      risk.emergencyBps && ltv >= risk.emergencyBps
        ? "EMERGENCY"
        : ltv >= risk.liquidationBps
          ? "LIQUIDATION"
          : ltv >= risk.marginCallBps
            ? "MARGIN_CALL"
            : "HEALTHY";
    const before = zone(calc.riskParams(p.collateralAsset, policy));
    const after = zone(draft.risk[p.collateralAsset]);
    if (before !== after)
      out.push({
        position_id: p.id,
        core_id: p.coreId,
        asset: p.collateralAsset,
        ltv_bps: ltv,
        zone_before: before,
        zone_after: after,
      });
  }
  return toJsonSafe({
    open_positions: rows.length,
    impacted: out.length,
    changes: out,
    warning: out.some(
      (c) => c.zone_after === "LIQUIDATION" || c.zone_after === "EMERGENCY",
    )
      ? "Policy would force liquidation on existing positions — grandfather or stage effective_at"
      : null,
  });
}

// ============================================================
// QA controls
// ============================================================

async function setTestPrice({ asset, price_idr }, now) {
  const a = require("./loan.validation").normalizeAsset(asset);
  const tick = await pricing.setTestPrice(a, price_idr, now);
  return toJsonSafe({
    asset: a,
    price_idr_per_token: tick.priceIdr,
    observed_at: tick.observedAt,
  });
}

async function forceLiquidate(positionId, now, actor) {
  await sequelize.transaction(async (t) => {
    const p = await service.lockPosition(positionId, null, t);
    if (!engine.isOpen(p))
      throw new LoanError(`Position is ${p.status}`, {
        status: 409,
        code: "POSITION_NOT_OPEN",
      });
    p.set({
      status: STATUS.LIQUIDATION_PENDING,
      liquidationTrigger: LIQUIDATION_TRIGGER.ADMIN,
      riskState: LIQUIDATION_TRIGGER.ADMIN,
    });
    await p.save({ transaction: t });
    await ledger.recordEvent(
      p,
      {
        eventType: EVENT.LIQUIDATION_AUTHORIZED,
        effectiveAt: now,
        metadata: { trigger: "ADMIN", actor },
      },
      t,
    );
  });
  return liquidation.processPending(positionId, now);
}

module.exports = {
  positions,
  riskEvents,
  poolDashboard,
  updatePool,
  injectReserve,
  treasuryDashboard,
  recordTreasurySale,
  simulatePolicyImpact,
  setTestPrice,
  forceLiquidate,
};
