/*
 * State machine + financial engine Loan V1.
 *
 * Semua fungsi menerima `position` yang SUDAH di-lock FOR UPDATE dalam
 * `t`, bekerja dengan waktu efektif (bukan waktu cron), memutasi state
 * `s` (Decimal) lalu flush ke position.
 *
 * Urutan boundary (A.1): settleToNow (interest posting, prorata, maturity,
 * PDP) -> evaluateRisk (LTV/HF, observation, cure, liquidation auth) ->
 * baru operasi user (repay/drawdown/release).
 */

const crypto = require("crypto");
const { LoanInterestEvent, LoanRiskSnapshot } = require("../../models");
const calc = require("./loan.calc");
const cal = require("./loan.calendar");
const ledger = require("./loan.ledger");
const {
  ASSET,
  STATUS,
  OPEN_STATUSES,
  RISK_LOCKED_STATUSES,
  EVENT,
  REV_ID,
  LIQUIDATION_TRIGGER,
  PRICE_STATUS,
} = require("./loan.constants");

const { dec, ZERO, clamp0, minDec } = calc;

// ============================================================
// State
// ============================================================

function loadState(p) {
  return {
    po: dec(p.principalOutstandingIdr),
    unpaidInterest: dec(p.unpaidInterestIdr),
    unpostedInterest: dec(p.unpostedInterestIdr),
    interestPosted: dec(p.interestPostedIdr),
    interestPaid: dec(p.interestPaidIdr),
    pdpAccrued: dec(p.pdpAccruedIdr),
    pdpPaid: dec(p.pdpPaidIdr),
    pdpDays: Number(p.pdpDaysCharged || 0),
    poAtMaturity: p.poAtMaturityIdr === null ? null : dec(p.poAtMaturityIdr),
    lockedQty: dec(p.lockedQty),
    releasedQty: dec(p.releasedQty),
    settledQty: dec(p.settledQty),
    principalRepaid: dec(p.principalRepaidIdr),
    lastAnniv: Number(p.lastAnniversaryIndex || 0),
    accruedThrough: p.interestAccruedThroughAt
      ? new Date(p.interestAccruedThroughAt)
      : null,
    // Awal segmen prorata yang belum di-post (informational untuk event)
    unpostedFrom: p.interestAccruedThroughAt
      ? new Date(p.interestAccruedThroughAt)
      : null,
    pushes: [],
    chainOps: [],
  };
}

function flushState(p, s) {
  p.set({
    principalOutstandingIdr: s.po.toFixed(18),
    unpaidInterestIdr: s.unpaidInterest.toFixed(18),
    unpostedInterestIdr: s.unpostedInterest.toFixed(18),
    interestPostedIdr: s.interestPosted.toFixed(18),
    interestPaidIdr: s.interestPaid.toFixed(18),
    pdpAccruedIdr: s.pdpAccrued.toFixed(18),
    pdpPaidIdr: s.pdpPaid.toFixed(18),
    pdpDaysCharged: s.pdpDays,
    poAtMaturityIdr:
      s.poAtMaturity === null ? null : s.poAtMaturity.toFixed(18),
    lockedQty: s.lockedQty.toFixed(18),
    releasedQty: s.releasedQty.toFixed(18),
    settledQty: s.settledQty.toFixed(18),
    principalRepaidIdr: s.principalRepaid.toFixed(18),
    lastAnniversaryIndex: s.lastAnniv,
    interestAccruedThroughAt: s.accruedThrough,
  });
}

const queuePush = (s, push) => s.pushes.push(push);
const queueChainOp = (s, op) => s.chainOps.push(op);

const isOpen = (p) => OPEN_STATUSES.includes(p.status);
const isRiskLocked = (p) => RISK_LOCKED_STATUSES.includes(p.status);
const isMatured = (p, now) =>
  p.maturityAt && cal.isAfterOrEqual(now, p.maturityAt);

/** Total kewajiban saat ini (PO + interest posted unpaid + prorata + PDP due). */
function dues(s) {
  const pdpDue = clamp0(s.pdpAccrued.minus(s.pdpPaid));
  const interestDue = s.unpaidInterest.plus(s.unpostedInterest);
  return {
    pdpDue,
    interestDue,
    postedInterestDue: s.unpaidInterest,
    unpostedInterest: s.unpostedInterest,
    principal: s.po,
    tdd: s.po.plus(interestDue).plus(pdpDue),
  };
}

const fmtIdr = (v) => `${Number(calc.roundIdr(v)).toLocaleString("id-ID")} IDR`;
const fmtQty = (v, asset) =>
  `${dec(v).toDecimalPlaces(6).toFixed()} ${asset === ASSET.XAUT ? "XAUT" : "VVLR"}`;

// ============================================================
// 06 Interest — anniversary posting & prorata
// ============================================================

async function postInterest(
  p,
  s,
  { kind, cycleIndex, anchorAt, periodStart, periodEnd, basis, amount, now },
  t,
) {
  if (dec(amount).lte(0)) {
    // Tetap catat segmen nol agar idempotency boundary terjaga
  }
  const key = `${p.id}:${kind}:${cycleIndex}:${new Date(periodStart).toISOString()}:${new Date(periodEnd).toISOString()}`;
  const exists = await LoanInterestEvent.findOne({
    where: { idempotencyKey: key },
    transaction: t,
  });
  if (exists) return exists;
  const ev = await LoanInterestEvent.create(
    {
      positionId: p.id,
      kind,
      cycleIndex,
      cycleAnchorAt: anchorAt,
      periodStartAt: periodStart,
      periodEndAt: periodEnd,
      principalBasisIdr: dec(basis).toFixed(18),
      aprBps: p.aprBps,
      accrualIdr: dec(amount).toFixed(18),
      idempotencyKey: key,
    },
    { transaction: t },
  );
  s.unpaidInterest = s.unpaidInterest.plus(amount);
  s.interestPosted = s.interestPosted.plus(amount);
  await ledger.recordEvent(
    p,
    {
      eventType: EVENT.INTEREST_POSTED,
      effectiveAt: periodEnd,
      amountIdr: amount,
      metadata: {
        kind,
        cycle_index: cycleIndex,
        basis_idr: basis,
        posted_at: now,
      },
    },
    t,
  );
  if (dec(amount).gt(0)) {
    await ledger.recordRevenue(
      p,
      {
        revId: REV_ID.INTEREST,
        amountIdr: amount,
        rateBps: p.aprBps,
        baseIdr: basis,
        sourceTxId: ev.id,
        effectiveAt: periodEnd,
        metadata: { kind, cycle_index: cycleIndex },
      },
      t,
    );
  }
  return ev;
}

/** Detik dalam cycle ke-k (anniversary k -> k+1). */
function cycleSeconds(p, k) {
  return cal.secondsBetween(
    cal.anniversaryAt(p.activatedAt, k),
    cal.anniversaryAt(p.activatedAt, k + 1),
  );
}

/** Akrual prorata segmen (cycle >= 2) dari accruedThrough -> until pada PO saat ini. */
function accrueUnposted(p, s, until) {
  if (s.lastAnniv < 1 || !s.accruedThrough) return ZERO;
  if (!cal.isBefore(s.accruedThrough, until)) return ZERO;
  const elapsed = cal.secondsBetween(s.accruedThrough, until);
  const amt = calc.segmentInterest(
    s.po,
    p.aprBps,
    elapsed,
    cycleSeconds(p, s.lastAnniv),
  );
  if (s.unpostedInterest.lte(0)) s.unpostedFrom = new Date(s.accruedThrough);
  s.unpostedInterest = s.unpostedInterest.plus(amt);
  s.accruedThrough = new Date(until);
  return amt;
}

/**
 * Konversi prorata belum-post menjadi posted (dipanggil saat pembayaran /
 * liquidation) — segmen yang dibayar ditandai, tidak di-charge dua kali.
 */
async function postPendingProrata(p, s, now, t) {
  if (s.unpostedInterest.lte(0)) return null;
  const amount = s.unpostedInterest;
  const start = s.unpostedFrom || cal.anniversaryAt(p.activatedAt, s.lastAnniv);
  s.unpostedInterest = ZERO;
  s.unpostedFrom = new Date(now);
  return postInterest(
    p,
    s,
    {
      kind: "PRORATA",
      cycleIndex: s.lastAnniv + 1,
      anchorAt: cal.anniversaryAt(p.activatedAt, s.lastAnniv),
      periodStart: start,
      periodEnd: now,
      basis: s.po,
      amount,
      now,
    },
    t,
  );
}

// ============================================================
// 13 PDP
// ============================================================

async function accruePdp(p, s, now, policy, t) {
  if (!isMatured(p, now) || s.poAtMaturity === null) return;
  const rules = policy.rules;
  const days = Math.min(
    cal.fullDaysBetween(p.maturityAt, now),
    rules.PDP_MAX_DAYS,
  );
  const cap = calc.pdpCap(s.poAtMaturity, rules.PDP_CAP_BPS);
  for (let d = s.pdpDays + 1; d <= days; d += 1) {
    const dayAt = cal.addDays(p.maturityAt, d);
    const raw = calc.pdpForDay(s.po, rules.PDP_DAILY_BPS);
    const room = clamp0(cap.minus(s.pdpAccrued));
    const amt = minDec(raw, room);
    s.pdpAccrued = s.pdpAccrued.plus(amt);
    s.pdpDays = d;
    await ledger.recordEvent(
      p,
      {
        eventType: EVENT.PDP_ACCRUED,
        effectiveAt: dayAt,
        amountIdr: amt,
        metadata: { day: d, basis_idr: s.po, cap_idr: cap, raw_idr: raw },
      },
      t,
    );
    if (amt.gt(0)) {
      await ledger.recordRevenue(
        p,
        {
          revId: REV_ID.PASTDUE,
          amountIdr: amt,
          rateBps: rules.PDP_DAILY_BPS,
          baseIdr: s.po,
          sourceTxId: `${p.id}:pdp:${d}`,
          effectiveAt: dayAt,
          metadata: { day: d },
        },
        t,
      );
    }
  }
}

// ============================================================
// settleToNow
// ============================================================

/**
 * Terapkan semua event terjadwal t <= now secara kronologis:
 * anniversary posting (first = snapshot PO, selanjutnya prorata),
 * akrual prorata sampai now, maturity mark, PDP harian.
 */
async function settleToNow(p, s, now, policy, t) {
  if (!isOpen(p) || !p.activatedAt) return;

  const passed = cal.anniversariesPassed(p.activatedAt, now);
  for (let k = s.lastAnniv + 1; k <= passed; k += 1) {
    const annivAt = cal.anniversaryAt(p.activatedAt, k);
    if (k === 1) {
      const amount = calc.firstAnniversaryInterest(s.po, p.aprBps);
      await postInterest(
        p,
        s,
        {
          kind: "FIRST_ANNIVERSARY",
          cycleIndex: 1,
          anchorAt: p.activatedAt,
          periodStart: p.activatedAt,
          periodEnd: annivAt,
          basis: s.po,
          amount,
          now,
        },
        t,
      );
      queuePush(s, {
        title: "Monthly Interest Posted",
        body: `Interest ${fmtIdr(amount)} has been posted on your loan. Principal stays ${fmtIdr(s.po)}.`,
        data: {
          type: "loan",
          event: "interest_posted",
          position_id: String(p.id),
        },
      });
    } else {
      accrueUnposted(p, s, annivAt);
      const amount = s.unpostedInterest;
      const start = s.unpostedFrom || cal.anniversaryAt(p.activatedAt, k - 1);
      s.unpostedInterest = ZERO;
      s.unpostedFrom = annivAt;
      await postInterest(
        p,
        s,
        {
          kind: "PRORATA",
          cycleIndex: k,
          anchorAt: cal.anniversaryAt(p.activatedAt, k - 1),
          periodStart: start,
          periodEnd: annivAt,
          basis: s.po,
          amount,
          now,
        },
        t,
      );
    }
    s.lastAnniv = k;
    s.accruedThrough = annivAt;
  }

  // Prorata cycle berjalan sampai now (hanya setelah first anniversary)
  accrueUnposted(p, s, now);

  // Maturity mark (PO snapshot untuk cap PDP)
  if (isMatured(p, now) && s.poAtMaturity === null) {
    s.poAtMaturity = s.po;
    await ledger.recordEvent(
      p,
      {
        eventType: EVENT.MATURED,
        effectiveAt: p.maturityAt,
        metadata: { po_at_maturity_idr: s.po },
      },
      t,
    );
  }

  await accruePdp(p, s, now, policy, t);
}

// ============================================================
// 11/12/13 Risk engine
// ============================================================

async function snapshotRisk(
  p,
  { now, price, tdd, collValue, ltv, hf, before, after, policy, note },
  t,
) {
  await LoanRiskSnapshot.create(
    {
      positionId: p.id,
      asOf: now,
      priceSource: price?.source || null,
      validatedPriceIdr: price?.priceIdr ? price.priceIdr.toFixed(18) : null,
      priceObservedAt: price?.observedAt || null,
      priceStatus: price?.status || PRICE_STATUS.UNAVAILABLE,
      totalDebtIdr: tdd.toFixed(18),
      collateralValueIdr: collValue ? collValue.toFixed(18) : null,
      ltvBps: ltv ?? null,
      hf: hf ? hf.toFixed(4) : null,
      statusBefore: before,
      statusAfter: after,
      configVersion: policy?.version || null,
      note: note || null,
    },
    { transaction: t },
  );
}

async function authorizeLiquidation(p, s, trigger, now, ctx, t) {
  const before = p.status;
  p.set({
    status: STATUS.LIQUIDATION_PENDING,
    liquidationTrigger: trigger,
    riskState: trigger,
  });
  await ledger.recordEvent(
    p,
    {
      eventType: EVENT.LIQUIDATION_AUTHORIZED,
      effectiveAt: now,
      metadata: {
        trigger,
        status_before: before,
        ltv_bps: ctx.ltv,
        hf: ctx.hf,
        price_idr: ctx.price?.priceIdr,
      },
    },
    t,
  );
  queueChainOp(s, { type: "LIQUIDATE", trigger });
  queuePush(s, {
    title: "Loan Liquidation",
    body: `Your ${p.collateralAsset === ASSET.XAUT ? "XAUT" : "VVLR"} loan reached the liquidation condition (${trigger.replace(/_/g, " ").toLowerCase()}). Settlement is being processed.`,
    data: {
      type: "loan",
      event: "liquidation_authorized",
      position_id: String(p.id),
    },
  });
}

/**
 * Evaluasi risk dengan precedence B.1. `price` = hasil pricing.getValidatedPrice.
 * Mengembalikan { tdd, collValue, ltv, hf, changed }.
 */
async function evaluateRisk(p, s, price, now, policy, t) {
  if (!isOpen(p) || !p.activatedAt) return null;
  const before = p.status;
  const risk = calc.riskParams(p.collateralAsset, policy);
  const hfB = calc.hfBoundaries(risk);
  const d = dues(s);
  const tdd = d.tdd;

  // Terminal settlement lock: sudah authorized -> tidak ada transisi lain
  if (p.status === STATUS.LIQUIDATION_PENDING) {
    return { tdd, ltv: null, hf: null, changed: false, locked: true };
  }

  // Price integrity (B.1 Second): tanpa harga valid tidak ada aksi otomatis
  if (!price || !price.usableForRisk) {
    const newStatus = price?.status || PRICE_STATUS.UNAVAILABLE;
    const transitioned = p.lastPriceStatus !== newStatus;
    p.set({ lastPriceStatus: newStatus, lastRiskCheckAt: now });
    if (transitioned) {
      await ledger.recordEvent(
        p,
        {
          eventType: EVENT.PRICE_STALE,
          effectiveAt: now,
          metadata: { status: newStatus, age_ms: price?.ageMs },
        },
        t,
      );
      await snapshotRisk(
        p,
        {
          now,
          price,
          tdd,
          before,
          after: p.status,
          policy,
          note: "PRICE_NOT_USABLE_HOLD",
        },
        t,
      );
    }
    return { tdd, ltv: null, hf: null, changed: false, priceHold: true };
  }

  const collValue = calc.collateralValue(s.lockedQty, price.priceIdr);
  const ltv = calc.ltvBps(tdd, collValue);
  const hf = calc.healthFactor(collValue, risk.liquidationBps, tdd);
  const ctx = { ltv, hf: hf.toFixed(4), price };
  const isX = p.collateralAsset === ASSET.XAUT;
  const inObservation =
    Boolean(p.observationEndsAt) && cal.isBefore(now, p.observationEndsAt);
  const inCure = Boolean(p.cureEndsAt);

  const liqHit = tdd.gt(0) && (ltv >= risk.liquidationBps || hf.lte(1));
  const emergencyHit =
    isX && risk.emergencyBps && tdd.gt(0) && ltv >= risk.emergencyBps;

  let note = null;
  if (tdd.lte(0)) {
    // Tidak ada hutang (mis. menunggu release akhir) — tidak ada risk action
    note = "NO_DEBT";
  } else if (emergencyHit) {
    // B.1 Third: emergency -> immediate auth, cut window/cure
    p.set({ status: STATUS.EMERGENCY });
    await ledger.recordEvent(
      p,
      { eventType: EVENT.EMERGENCY, effectiveAt: now, metadata: ctx },
      t,
    );
    await authorizeLiquidation(
      p,
      s,
      LIQUIDATION_TRIGGER.EMERGENCY,
      now,
      ctx,
      t,
    );
  } else if (isMatured(p, now)) {
    // B.1 Fourth/Fifth: maturity path
    if (inCure) {
      if (hf.lte(hfB.marginCall)) {
        await ledger.recordEvent(
          p,
          { eventType: EVENT.CURE_TERMINATED, effectiveAt: now, metadata: ctx },
          t,
        );
        await authorizeLiquidation(
          p,
          s,
          LIQUIDATION_TRIGGER.CURE_TERMINATED,
          now,
          ctx,
          t,
        );
      } else if (cal.isAfterOrEqual(now, p.cureEndsAt)) {
        await authorizeLiquidation(
          p,
          s,
          LIQUIDATION_TRIGGER.CURE_EXPIRED,
          now,
          ctx,
          t,
        );
      } else {
        p.set({ status: STATUS.PAST_DUE });
      }
    } else if (hf.gt(hfB.marginCall) && !inObservation && !liqHit) {
      const cureEndsAt = cal.addDays(p.maturityAt, policy.rules.CURE_DAYS);
      p.set({
        status: STATUS.PAST_DUE,
        cureEligible: true,
        cureStartedAt: p.maturityAt,
        cureEndsAt,
      });
      await ledger.recordEvent(
        p,
        {
          eventType: EVENT.CURE_STARTED,
          effectiveAt: p.maturityAt,
          metadata: { ...ctx, cure_ends_at: cureEndsAt },
        },
        t,
      );
      queuePush(s, {
        title: "Loan Matured — 3-Day Cure",
        body: `Your loan matured. Settle ${fmtIdr(tdd)} before ${cureEndsAt.toISOString()} to release your collateral.`,
        data: {
          type: "loan",
          event: "cure_started",
          position_id: String(p.id),
        },
      });
      if (cal.isAfterOrEqual(now, cureEndsAt)) {
        await authorizeLiquidation(
          p,
          s,
          LIQUIDATION_TRIGGER.CURE_EXPIRED,
          now,
          ctx,
          t,
        );
      }
    } else {
      p.set({ status: STATUS.PAST_DUE, cureEligible: false });
      await authorizeLiquidation(
        p,
        s,
        LIQUIDATION_TRIGGER.MATURITY_NO_CURE,
        now,
        ctx,
        t,
      );
    }
  } else if (liqHit) {
    // B.1 Sixth/Seventh/Eighth: pre-maturity threshold
    if (!isX) {
      await authorizeLiquidation(
        p,
        s,
        LIQUIDATION_TRIGGER.VVLR_THRESHOLD,
        now,
        ctx,
        t,
      );
    } else if (inObservation) {
      p.set({ status: STATUS.LIQUIDATION_OBSERVATION });
    } else if (p.observationUsed) {
      const trig =
        p.observationEndsAt &&
        cal.isAfterOrEqual(now, p.observationEndsAt) &&
        before === STATUS.LIQUIDATION_OBSERVATION
          ? LIQUIDATION_TRIGGER.OBSERVATION_EXPIRED
          : LIQUIDATION_TRIGGER.REPEAT_HIT;
      await authorizeLiquidation(p, s, trig, now, ctx, t);
    } else {
      const endsAt = cal.addHours(now, risk.observationWindowHours);
      p.set({
        status: STATUS.LIQUIDATION_OBSERVATION,
        observationUsed: true,
        observationStartedAt: now,
        observationEndsAt: endsAt,
      });
      await ledger.recordEvent(
        p,
        {
          eventType: EVENT.OBSERVATION_STARTED,
          effectiveAt: now,
          metadata: { ...ctx, ends_at: endsAt },
        },
        t,
      );
      queuePush(s, {
        title: "Liquidation Observation Started",
        body: `Your XAUT loan hit the liquidation threshold. You have up to 4 hours to repay or add collateral.`,
        data: {
          type: "loan",
          event: "observation_started",
          position_id: String(p.id),
        },
      });
    }
  } else {
    // Di bawah threshold likuidasi
    if (inObservation) {
      if (p.status !== STATUS.RECOVERING) {
        p.set({ status: STATUS.RECOVERING, lastRecoveredAt: now });
        await ledger.recordEvent(
          p,
          { eventType: EVENT.RECOVERED, effectiveAt: now, metadata: ctx },
          t,
        );
      }
    } else {
      if (p.observationEndsAt && cal.isAfterOrEqual(now, p.observationEndsAt)) {
        // window habis dalam kondisi sehat -> consumed, kembali normal
        p.set({ observationStartedAt: null, observationEndsAt: null });
      }
      if (ltv >= risk.marginCallBps || hf.lte(hfB.marginCall)) {
        if (p.status !== STATUS.MARGIN_CALL) {
          p.set({ status: STATUS.MARGIN_CALL, marginCallAt: now });
          await ledger.recordEvent(
            p,
            { eventType: EVENT.MARGIN_CALL, effectiveAt: now, metadata: ctx },
            t,
          );
          queuePush(s, {
            title: "Margin Call",
            body: `Your loan LTV is ${(ltv / 100).toFixed(2)}%. Repay or add collateral to stay safe.`,
            data: {
              type: "loan",
              event: "margin_call",
              position_id: String(p.id),
            },
          });
        }
      } else {
        p.set({ status: STATUS.ACTIVE });
      }
    }
  }

  p.set({
    lastLtvBps: ltv,
    lastHf: hf.toFixed(4),
    lastPriceIdr: price.priceIdr.toFixed(18),
    lastPriceStatus: price.status,
    lastRiskCheckAt: now,
    riskState:
      p.riskState && p.status === STATUS.LIQUIDATION_PENDING
        ? p.riskState
        : p.status,
  });

  const changed = p.status !== before;
  if (changed || note) {
    await snapshotRisk(
      p,
      {
        now,
        price,
        tdd,
        collValue,
        ltv,
        hf,
        before,
        after: p.status,
        policy,
        note,
      },
      t,
    );
  }
  return { tdd, collValue, ltv, hf, changed };
}

// ============================================================
// Scheduling
// ============================================================

function computeNextEventAt(p, s, now, policy) {
  if (!isOpen(p) || !p.activatedAt) return null;
  const candidates = [];
  const nextK = s.lastAnniv + 1;
  candidates.push(cal.anniversaryAt(p.activatedAt, nextK));
  if (p.maturityAt && cal.isBefore(now, p.maturityAt))
    candidates.push(p.maturityAt);
  if (p.observationEndsAt && cal.isBefore(now, p.observationEndsAt))
    candidates.push(p.observationEndsAt);
  if (p.cureEndsAt && cal.isBefore(now, p.cureEndsAt))
    candidates.push(p.cureEndsAt);
  if (isMatured(p, now) && s.pdpDays < policy.rules.PDP_MAX_DAYS) {
    candidates.push(cal.addDays(p.maturityAt, s.pdpDays + 1));
  }
  // Risk check reguler
  candidates.push(
    cal.addSeconds(now, Number(process.env.LOAN_RISK_INTERVAL_SECONDS || 60)),
  );
  return cal.minDate(...candidates);
}

module.exports = {
  loadState,
  flushState,
  queuePush,
  queueChainOp,
  isOpen,
  isRiskLocked,
  isMatured,
  dues,
  settleToNow,
  evaluateRisk,
  postPendingProrata,
  accrueUnposted,
  computeNextEventAt,
  fmtIdr,
  fmtQty,
};
