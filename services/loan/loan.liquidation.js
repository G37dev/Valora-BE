/*
 * Auto Liquidation Waterfall & Final User Refund (brief 14, 16, D.3).
 *
 * Settlement sequencing Hybrid V1:
 *  1 risk engine authorize (status LIQUIDATION_PENDING) -- di engine
 *  2 verify funding/reserve; generate signed instruction (nonce)   -- authorize()
 *  3 contract ATOMIC split: refund -> user, debt+comp -> treasury  -- execute()
 *  4 confirm on-chain; reconcile raw token
 *  5 borrower position closed (AUTO_LIQUIDATED)
 *  6 company IDR advance replenish pool (reserve menutup deficit)
 *  7 treasury lot HELD; uPNL & recovery gap live sampai dijual
 *
 * Tidak ada state "sukses" tanpa konfirmasi chain; kegagalan -> retry
 * dengan nonce yang sama (tidak ada double execution).
 */

const {
  sequelize,
  LoanPosition,
  LoanLiquidation,
  LoanTreasuryLot,
  LoanCollateralRelease,
} = require("../../models");
const calc = require("./loan.calc");
const engine = require("./loan.engine");
const ledger = require("./loan.ledger");
const pool = require("./loan.pool");
const bc = require("./loan.blockchain.service");
const pricing = require("./loan.pricing");
const { getActivePolicy } = require("./loan.policy");
const pushService = require("../pushService");
const {
  STATUS,
  SETTLEMENT_STATUS,
  EVENT,
  REV_ID,
  RELEASE_STATUS,
} = require("./loan.constants");

const { dec } = calc;

/**
 * Buat record liquidation AUTHORIZED + instruksi bertanda tangan untuk
 * posisi LIQUIDATION_PENDING. Idempotent: 1 liquidation aktif / posisi.
 */
async function authorize(positionId, now) {
  const policy = await getActivePolicy(now);
  let out = null;
  await sequelize.transaction(async (t) => {
    const p = await LoanPosition.findByPk(positionId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!p || p.status !== STATUS.LIQUIDATION_PENDING) return;
    const existing = await LoanLiquidation.findOne({
      where: { positionId: p.id, state: ["AUTHORIZED", "SUBMITTED", "FAILED_RETRY"] },
      transaction: t,
    });
    if (existing) {
      out = existing;
      return;
    }
    const s = engine.loadState(p);
    // Post prorata sampai saat ini agar TDD final (tidak ada akrual setelah lock)
    await engine.postPendingProrata(p, s, now, t);
    const d = engine.dues(s);
    const price = await pricing.getValidatedPrice(p.collateralAsset, now, { policy, transaction: t });
    if (!price.priceIdr) throw new Error("Price unavailable for liquidation");
    const risk = calc.riskParams(p.collateralAsset, policy);
    const split = calc.liquidationSplit({
      qLocked: s.lockedQty,
      totalDebtDue: d.tdd,
      referencePrice: price.priceIdr,
      haircutBps: risk.haircutBps,
      compensationBps: policy.rules.LIQUIDATION_COMPENSATION_BPS,
      decimals: p.tokenDecimals,
    });
    const nonce = Number(p.settlementNonce || 0) + 1;
    const userRecipient = p.ownerAddress || (await bc.getBeneficiaryAddress(p.coreId)) || "0x0000000000000000000000000000000000000000";
    const liq = await LoanLiquidation.create(
      {
        positionId: p.id,
        coreId: p.coreId,
        triggerType: p.liquidationTrigger || "ADMIN",
        observationStartedAt: p.observationStartedAt,
        authorizedAt: now,
        referencePriceIdr: price.priceIdr.toFixed(18),
        priceSource: price.source,
        priceObservedAt: price.observedAt,
        haircutBps: risk.haircutBps,
        conservativePriceIdr: split.conservativePrice.toFixed(18),
        principalIdr: d.principal.toFixed(18),
        interestIdr: d.interestDue.toFixed(18),
        pdpIdr: d.pdpDue.toFixed(18),
        totalDebtDueIdr: d.tdd.toFixed(18),
        lockedQty: s.lockedQty.toFixed(18),
        debtAllocQty: split.qDebtAlloc.toFixed(18),
        compensationQty: split.qComp.toFixed(18),
        refundQty: split.qRefund.toFixed(18),
        treasuryQty: split.qTreasury.toFixed(18),
        deficitIdr: split.deficitIdr.toFixed(18),
        advanceIdr: d.tdd.toFixed(18),
        userRecipient,
        treasuryRecipient: bc.TREASURY_WALLET,
        nonce,
        state: "AUTHORIZED",
        configVersion: policy.version,
      },
      { transaction: t },
    );
    const instruction = bc.buildSettlementInstruction(p, liq, { now, policyVersion: policy.version });
    const signature = await bc.signInstruction(instruction);
    await liq.update({ instruction, signature }, { transaction: t });
    p.set({ settlementNonce: nonce, settlementStatus: SETTLEMENT_STATUS.RESERVE_ADVANCE_PENDING });
    engine.flushState(p, s);
    await p.save({ transaction: t });
    out = liq;
  });
  return out;
}

/** Eksekusi on-chain + close-out. Dipanggil SETELAH authorize (di luar tx). */
async function execute(liquidationId, now) {
  const liq = await LoanLiquidation.findByPk(liquidationId);
  if (!liq || !["AUTHORIZED", "FAILED_RETRY"].includes(liq.state)) return liq;
  const p0 = await LoanPosition.findByPk(liq.positionId);
  if (!p0) return liq;

  const expired = new Date(liq.instruction?.expires_at || 0).getTime() < Date.now();
  let instruction = liq.instruction;
  let signature = liq.signature;
  if (expired) {
    const policy = await getActivePolicy(now);
    instruction = bc.buildSettlementInstruction(p0, liq, { now, policyVersion: policy.version });
    signature = await bc.signInstruction(instruction);
    await liq.update({ instruction, signature });
  }

  let txHash;
  try {
    await liq.update({ state: "SUBMITTED" });
    txHash = await bc.settleLiquidation(p0, liq, instruction, signature);
  } catch (error) {
    await liq.update({ state: "FAILED_RETRY", metadata: { ...(liq.metadata || {}), last_error: error.message, failed_at: now } });
    console.error(`[Loan Liquidation] settle ${liq.id} gagal:`, error.message);
    return liq;
  }

  const pushes = [];
  await sequelize.transaction(async (t) => {
    const p = await LoanPosition.findByPk(liq.positionId, { transaction: t, lock: t.LOCK.UPDATE });
    const l = await LoanLiquidation.findByPk(liq.id, { transaction: t, lock: t.LOCK.UPDATE });
    if (l.state === "EXECUTED") return;
    const s = engine.loadState(p);
    const policy = await getActivePolicy(now, { transaction: t });
    const poolRow = await pool.getPool({ transaction: t, lock: true });

    const tdd = dec(l.totalDebtDueIdr);
    const principal = dec(l.principalIdr);
    const interest = dec(l.interestIdr);
    const pdp = dec(l.pdpIdr);
    const refPrice = dec(l.referencePriceIdr);

    // 6 Company IDR advance -> pool; reserve menutup deficit
    const adv = await pool.applyLiquidationAdvance(
      poolRow,
      { principalIdr: principal, totalDebtDueIdr: tdd, deficitIdr: l.deficitIdr },
      { transaction: t },
    );
    await pool.snapshot(poolRow, "LIQUIDATION_ADVANCE", { positionId: p.id, now, transaction: t });

    // 7 Treasury lots (debt recovery terpisah dari compensation)
    if (dec(l.debtAllocQty).gt(0)) {
      await LoanTreasuryLot.create(
        {
          liquidationId: l.id,
          sourcePositionId: p.id,
          asset: p.collateralAsset,
          lotType: "DEBT_RECOVERY",
          qtyOriginal: l.debtAllocQty,
          qtyRemaining: l.debtAllocQty,
          entryPriceIdr: refPrice.toFixed(18),
          advanceIdr: tdd.toFixed(18),
          advanceRemainingIdr: tdd.toFixed(18),
          receivedAt: now,
          txHash,
        },
        { transaction: t },
      );
    }
    if (dec(l.compensationQty).gt(0)) {
      await LoanTreasuryLot.create(
        {
          liquidationId: l.id,
          sourcePositionId: p.id,
          asset: p.collateralAsset,
          lotType: "COMPENSATION",
          qtyOriginal: l.compensationQty,
          qtyRemaining: l.compensationQty,
          entryPriceIdr: refPrice.toFixed(18),
          receivedAt: now,
          txHash,
        },
        { transaction: t },
      );
      await ledger.recordRevenue(
        p,
        {
          revId: REV_ID.LIQ_COMP,
          amountQty: l.compensationQty,
          amountIdr: dec(l.compensationQty).mul(refPrice),
          rateBps: policy.rules.LIQUIDATION_COMPENSATION_BPS,
          sourceTxId: l.id,
          effectiveAt: now,
          metadata: { tx_hash: txHash, reference_price_idr: refPrice },
        },
        t,
      );
    }
    if (dec(l.deficitIdr).gt(0)) {
      await ledger.recordRevenue(
        p,
        {
          revId: REV_ID.RISK_RESERVE,
          amountIdr: dec(l.deficitIdr).neg(),
          sourceTxId: `${l.id}:deficit`,
          effectiveAt: now,
          metadata: { reserve_used_idr: adv.reserveUsed, uncovered_idr: adv.uncovered },
        },
        t,
      );
    }

    // Final User Refund record (token kembali ke user via split atomic)
    await LoanCollateralRelease.create(
      {
        positionId: p.id,
        coreId: p.coreId,
        kind: "LIQUIDATION_REFUND",
        tokenQty: l.refundQty,
        tokenQtyRaw: calc.tokenRaw(l.refundQty, p.tokenDecimals).toString(),
        valueIdr: dec(l.refundQty).mul(refPrice).toFixed(18),
        priceIdr: refPrice.toFixed(18),
        recipient: l.userRecipient,
        nonce: l.nonce,
        txHash,
        state: RELEASE_STATUS.CONFIRMED,
        userApproved: true,
        effectiveAt: now,
        confirmedAt: now,
      },
      { transaction: t },
    );

    // 5 Borrower close-out: semua kewajiban dianggap settled oleh advance
    s.interestPaid = s.interestPaid.plus(interest);
    s.unpaidInterest = dec(0);
    s.unpostedInterest = dec(0);
    s.pdpPaid = s.pdpPaid.plus(pdp);
    s.principalRepaid = s.principalRepaid.plus(principal);
    s.po = dec(0);
    s.settledQty = s.settledQty.plus(s.lockedQty);
    s.lockedQty = dec(0);
    engine.flushState(p, s);
    p.set({
      status: STATUS.AUTO_LIQUIDATED,
      settlementStatus: SETTLEMENT_STATUS.TREASURY_PENDING,
      closedAt: now,
      nextEventAt: null,
      observationEndsAt: null,
      cureEndsAt: null,
    });
    await p.save({ transaction: t });
    await l.update({ state: "EXECUTED", executedAt: now, txHash, metadata: { ...(l.metadata || {}), reserve_used_idr: adv.reserveUsed.toFixed(2), uncovered_idr: adv.uncovered.toFixed(2) } }, { transaction: t });

    for (const [eventType, extra] of [
      [EVENT.AUTO_LIQUIDATED, { tx_hash: txHash, trigger: l.triggerType, haircut_bps: l.haircutBps }],
      [EVENT.FINAL_USER_REFUNDED, { refund_qty: l.refundQty, refund_idr_spot: dec(l.refundQty).mul(refPrice) }],
      [EVENT.TREASURY_INVENTORY_RECEIVED, { debt_alloc_qty: l.debtAllocQty, compensation_qty: l.compensationQty }],
      [EVENT.IDR_POOL_REPLENISHED, { advance_idr: tdd, deficit_idr: l.deficitIdr, reserve_used_idr: adv.reserveUsed }],
    ]) {
      await ledger.recordEvent(p, { eventType, effectiveAt: now, metadata: extra }, t);
    }
    await pool.closeCycleIfIdle(p.coreId, { now, transaction: t });

    pushes.push({
      title: "Loan Liquidated",
      body: `Your loan was settled from collateral. Debt ${engine.fmtIdr(tdd)} covered by ${engine.fmtQty(l.debtAllocQty, p.collateralAsset)}; ${engine.fmtQty(l.refundQty, p.collateralAsset)} refunded to your wallet.`,
      data: { type: "loan", event: "auto_liquidated", position_id: String(p.id) },
    });
  });

  for (const push of pushes) {
    try {
      await pushService.sendPushToUser(liq.coreId, push);
    } catch (error) {
      console.log(`[Loan] push gagal ${liq.coreId}:`, error.message);
    }
  }
  return LoanLiquidation.findByPk(liq.id);
}

/** Pipeline lengkap untuk posisi LIQUIDATION_PENDING. */
async function processPending(positionId, now) {
  const liq = await authorize(positionId, now);
  if (!liq) return null;
  return execute(liq.id, now);
}

module.exports = { authorize, execute, processPending };
