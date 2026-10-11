/*
 * State machine + financial engine Gold Installment.
 *
 * Semua fungsi di sini:
 * - menerima `plan` yang SUDAH di-lock FOR UPDATE dalam `transaction`,
 * - bekerja dengan waktu efektif (`effectiveAt`), bukan waktu cron,
 * - memutasi plan/schedules di memori lalu menyimpannya via transaction.
 *
 * Urutan boundary (brief 7.4): event terjadwal dengan t <= effectiveAt
 * diterapkan dulu (settleToNow) sebelum pembayaran dieksekusi.
 */

const { InstallmentSchedule } = require("../../models");
const calc = require("./installment.calc");
const cal = require("./installment.calendar");
const ledger = require("./installment.ledger");
const { InstallmentError, toJsonSafe } = require("./installment.errors");
const {
  PLAN_TYPE,
  STATUS,
  RUNNING_STATUSES,
  EVENT,
  REV_ID,
  RULES,
  PAYMENT_KIND,
} = require("./installment.constants");

const { big, bpsOf, ratioBps, minBig, clampNonNegative } = calc;

// ============================================================
// State helpers
// ============================================================

function isFlexible(plan) {
  return plan.planType === PLAN_TYPE.FLEXIBLE;
}

function isRunning(plan) {
  return RUNNING_STATUSES.includes(plan.status);
}

/** Snapshot BigInt dari kolom finansial plan. */
function loadState(plan) {
  return {
    po: big(plan.principalOutstandingIdr),
    ac: big(plan.accruedCarryingIdr),
    acPaid: big(plan.carryingPaidIdr),
    lp: big(plan.latePenaltyIdr),
    lpPaid: big(plan.latePenaltyPaidIdr),
    pdp: big(plan.pastDuePenaltyIdr),
    pdpPaid: big(plan.pastDuePenaltyPaidIdr),
    rf: big(plan.restructureFeeIdr),
    rfPaid: big(plan.restructureFeePaidIdr),
    epp: big(plan.eligiblePlanPaymentIdr),
    sepa: big(plan.standardEligiblePaidIdr),
    gross: big(plan.grossCashPaidIdr),
    actualCost: big(plan.actualCostIdr),
    // Push notifications yang di-queue selama settle; dikirim oleh service
    // SETELAH transaction commit agar notif selalu konsisten dengan DB.
    pushes: [],
    // Operasi on-chain (allocate/reclaim pool) — dieksekusi service SETELAH
    // commit, best-effort: kegagalan chain tidak me-rollback state DB.
    chainOps: [],
  };
}

function queuePush(s, push) {
  if (Array.isArray(s.pushes)) s.pushes.push(push);
}

function queueChainOp(s, op) {
  if (Array.isArray(s.chainOps)) s.chainOps.push(op);
}

const fmtIdr = (v) => `${Number(big(v)).toLocaleString("id-ID")} IDR`;

const fmtDateId = (d) =>
  new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
    timeZoneName: "short",
  }).format(cal.toDate(d));

function flushState(plan, s) {
  plan.set({
    principalOutstandingIdr: s.po.toString(),
    accruedCarryingIdr: s.ac.toString(),
    carryingPaidIdr: s.acPaid.toString(),
    latePenaltyIdr: s.lp.toString(),
    latePenaltyPaidIdr: s.lpPaid.toString(),
    pastDuePenaltyIdr: s.pdp.toString(),
    pastDuePenaltyPaidIdr: s.pdpPaid.toString(),
    restructureFeeIdr: s.rf.toString(),
    restructureFeePaidIdr: s.rfPaid.toString(),
    eligiblePlanPaymentIdr: s.epp.toString(),
    standardEligiblePaidIdr: s.sepa.toString(),
    grossCashPaidIdr: s.gross.toString(),
    paymentCompletionBps: completionBps(plan, s),
  });
}

function eligiblePaid(plan, s) {
  return isFlexible(plan) ? s.epp : s.sepa;
}

function planValue(plan) {
  return isFlexible(plan)
    ? big(plan.lockedPlanValueIdr)
    : big(plan.standardTotalPaymentIdr);
}

function completionBps(plan, s) {
  return ratioBps(eligiblePaid(plan, s), planValue(plan));
}

function totalObligation(s) {
  return s.po + s.ac + s.lp + s.pdp + s.rf;
}

function effectiveMaturity(plan) {
  return plan.status === STATUS.RESTRUCTURED
    ? plan.restructureMaturityAt
    : plan.maturityAt;
}

async function loadSchedules(plan, transaction) {
  if (isFlexible(plan)) return [];
  return InstallmentSchedule.findAll({
    where: { planId: plan.id },
    order: [["sequence", "ASC"]],
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
}

function buildSnapshot(plan, s, extra = {}) {
  return {
    rules_version: plan.rulesVersion,
    plan_type: plan.planType,
    locked_price: String(plan.lockedPriceIdr),
    gold_amount: String(plan.goldAmount),
    asset_value: String(plan.assetValueIdr),
    price_lock_margin_bps: plan.priceLockMarginBps,
    locked_plan_value:
      plan.lockedPlanValueIdr && String(plan.lockedPlanValueIdr),
    standard_total_payment:
      plan.standardTotalPaymentIdr && String(plan.standardTotalPaymentIdr),
    standard_eligible_paid: s.sepa.toString(),
    eligible_plan_payment: s.epp.toString(),
    principal_outstanding: s.po.toString(),
    accrued_carrying: s.ac.toString(),
    late_penalty: s.lp.toString(),
    past_due_penalty: s.pdp.toString(),
    restructure_fee: s.rf.toString(),
    gross_cash_paid: s.gross.toString(),
    payment_completion_bps: completionBps(plan, s),
    actual_cost: s.actualCost.toString(),
    protocol_fee_bps: plan.protocolFeeBps,
    protocol_fee_amount: String(plan.protocolFeeIdr),
    status: plan.status,
    ...extra,
  };
}

/** Waktu event terjadwal berikutnya untuk query scheduler. */
function computeNextEventAt(plan, schedules = []) {
  switch (plan.status) {
    case STATUS.REQUEST_CREATED:
      return plan.requestExpiresAt;
    case STATUS.ACTIVE:
    case STATUS.CANCELLATION_CLOSED:
    case STATUS.RESTRUCTURED: {
      const candidates = [effectiveMaturity(plan)];
      if (isFlexible(plan) && plan.nextCarryingAt)
        candidates.push(plan.nextCarryingAt);
      if (plan.status === STATUS.RESTRUCTURED && !plan.h3NotifiedAt) {
        candidates.push(
          cal.addDays(plan.restructureMaturityAt, -RULES.H3_REMINDER_DAYS),
        );
      }
      if (!isFlexible(plan)) {
        const open = schedules.find((x) => x.status !== "PAID");
        if (open) {
          // Belum pernah overdue -> visit tepat di dueAt supaya checker bisa
          // menandai overdue + kirim notif di boundary. Setelah ditandai
          // (penaltyAccruedThroughAt terisi) -> visit harian untuk akru.
          candidates.push(
            open.penaltyAccruedThroughAt
              ? cal.addDays(open.penaltyAccruedThroughAt, 1)
              : cal.toDate(open.dueAt),
          );
        }
      }
      return cal.minDate(...candidates);
    }
    case STATUS.PAST_DUE:
      return plan.cureEndsAt;
    case STATUS.COMPLETE_PENDING_CLAIM:
      return plan.claimableAt;
    default:
      return null;
  }
}

async function persist(plan, s, schedules, effectiveAt, transaction) {
  flushState(plan, s);
  plan.set({
    settledThroughAt:
      plan.settledThroughAt &&
      cal.toDate(plan.settledThroughAt) > cal.toDate(effectiveAt)
        ? plan.settledThroughAt
        : effectiveAt,
    nextEventAt: computeNextEventAt(plan, schedules),
  });
  await plan.save({ transaction });
  for (const schedule of schedules) {
    if (schedule.changed()) await schedule.save({ transaction });
  }
}

// ============================================================
// Standard: late penalty & schedule allocation
// ============================================================

/** Akru late penalty harian per item overdue sampai `throughAt` (idempotent). */
async function accrueLatePenalty(plan, s, schedules, throughAt, transaction) {
  for (const item of schedules) {
    if (item.status === "PAID") continue;
    if (!(cal.toDate(item.dueAt) < cal.toDate(throughAt))) continue;

    const from = item.penaltyAccruedThroughAt || item.dueAt;
    const days = cal.fullDaysBetween(from, throughAt);
    if (days === 0) continue;

    const overdue = big(item.amountIdr) - big(item.paidIdr);
    const add = calc.latePenaltyAccrual({
      overdueRemaining: overdue,
      days,
      alreadyCharged: item.latePenaltyChargedIdr,
      installmentAmount: item.amountIdr,
    });
    const newThrough = cal.addDays(from, days);

    item.set({
      latePenaltyChargedIdr: (big(item.latePenaltyChargedIdr) + add).toString(),
      penaltyAccruedThroughAt: newThrough,
    });

    if (add > 0n) {
      s.lp += add;
      await ledger.recordEvent(
        plan,
        {
          eventType: EVENT.LATE_PENALTY_ACCRUED,
          effectiveAt: newThrough,
          metadata: { sequence: item.sequence, days, overdue, amount: add },
        },
        transaction,
      );
    }
  }
}

/**
 * Tandai schedule Standard yang sudah melewati dueAt sebagai overdue:
 * isi penaltyAccruedThroughAt=dueAt (sekaligus jadi marker + kursor akru),
 * catat event, dan queue push notification. Idempotent — marker null berarti
 * schedule belum pernah ditandai overdue.
 */
async function markOverdueSchedules(plan, s, schedules, now, transaction) {
  for (const item of schedules) {
    if (item.status === "PAID") continue;
    const due = cal.toDate(item.dueAt);
    if (due > cal.toDate(now)) continue;
    if (item.penaltyAccruedThroughAt) continue;

    item.set({ penaltyAccruedThroughAt: item.dueAt });
    queuePush(s, {
      title: "Installment Overdue",
      body: `Installment #${item.sequence} of ${fmtIdr(big(item.amountIdr) - big(item.paidIdr))} was due ${fmtDateId(due)} and is unpaid. Late penalty of 0.05%/day is accruing.`,
      data: {
        type: "installment",
        event: "overdue",
        plan_id: String(plan.id),
        sequence: item.sequence,
      },
    });
    await ledger.recordEvent(
      plan,
      {
        eventType: EVENT.INSTALLMENT_OVERDUE,
        effectiveAt: due,
        metadata: {
          sequence: item.sequence,
          due_at: due,
          remaining_idr: (big(item.amountIdr) - big(item.paidIdr)).toString(),
        },
      },
      transaction,
    );
  }
}

/** Alokasikan pembayaran principal Standard ke jadwal berurutan. */
function allocateToSchedules(schedules, amount, effectiveAt) {
  let remaining = amount;
  for (const item of schedules) {
    if (remaining === 0n) break;
    if (item.status === "PAID") continue;
    const due = big(item.amountIdr) - big(item.paidIdr);
    const take = minBig(remaining, due);
    if (take === 0n) continue;
    const paid = big(item.paidIdr) + take;
    const isPaid = paid >= big(item.amountIdr);
    item.set({
      paidIdr: paid.toString(),
      status: isPaid ? "PAID" : "PARTIAL",
      paidAt: isPaid ? effectiveAt : item.paidAt,
    });
    remaining -= take;
  }
}

// ============================================================
// Timed transitions
// ============================================================

async function expireRequest(plan, effectiveAt, transaction) {
  plan.set({ status: STATUS.REQUEST_EXPIRED, closedAt: effectiveAt });
  await ledger.recordEvent(
    plan,
    { eventType: EVENT.REQUEST_EXPIRED, effectiveAt },
    transaction,
  );
}

async function accrueCarrying(plan, s, effectiveAt, transaction) {
  const amount = s.po > 0n ? calc.carryingAccrual(s.po) : 0n;
  s.ac += amount;

  const nextIndex = Number(plan.nextCarryingIndex) + 1;
  plan.set({
    nextCarryingIndex: nextIndex,
    nextCarryingAt: cal.anniversaryAt(plan.activatedAt, nextIndex),
  });

  await ledger.recordEvent(
    plan,
    {
      eventType: EVENT.CARRYING_ACCRUED,
      effectiveAt,
      metadata: {
        anniversary_index: nextIndex - 1,
        principal_base: s.po,
        amount,
        accrued_carrying_after: s.ac,
      },
    },
    transaction,
  );
}

async function markFullySettled(plan, s, effectiveAt, transaction) {
  const claimable = cal.isAfterOrEqual(effectiveAt, plan.claimableAt);
  queuePush(s, {
    title: "Installment Complete",
    body: claimable
      ? "All obligations settled — your asset is ready to claim."
      : `All obligations settled. Your asset is claimable from ${fmtDateId(plan.claimableAt)}.`,
    data: { type: "installment", event: "settled", plan_id: String(plan.id) },
  });
  plan.set({
    status: claimable ? STATUS.CLAIMABLE : STATUS.COMPLETE_PENDING_CLAIM,
    fullySettledAt: effectiveAt,
    nextCarryingAt: null,
  });
  await ledger.recordEvent(
    plan,
    {
      eventType: EVENT.FULLY_SETTLED,
      effectiveAt,
      metadata: buildSnapshot(plan, s),
    },
    transaction,
  );
  if (claimable) {
    await ledger.recordEvent(
      plan,
      { eventType: EVENT.CLAIMABLE, effectiveAt },
      transaction,
    );
  }
}

async function enterPastDue(plan, s, effectiveAt, transaction) {
  const pdp = calc.pastDuePenalty(s.po);
  s.pdp += pdp;
  plan.set({
    status: STATUS.PAST_DUE,
    pastDueAt: effectiveAt,
    cureEndsAt: cal.calendarDaysFrom(effectiveAt, RULES.CURE_DAYS),
    nextCarryingAt: null,
  });
  queuePush(s, {
    title: "Plan Past Due",
    body: `Your plan passed its final due date. Settle the remaining obligation before ${fmtDateId(plan.cureEndsAt)} to avoid automatic liquidation.`,
    data: { type: "installment", event: "past_due", plan_id: String(plan.id) },
  });
  await ledger.recordEvent(
    plan,
    {
      eventType: EVENT.PAST_DUE,
      effectiveAt,
      metadata: {
        principal_outstanding: s.po,
        past_due_penalty: pdp,
        accrued_carrying: s.ac,
        late_penalty: s.lp,
        cure_ends_at: plan.cureEndsAt,
        payment_completion_bps: completionBps(plan, s),
      },
    },
    transaction,
  );
}

/**
 * Auto Liquidation (brief 11 & 12.1).
 * Termination settlement waterfall dari eligible paid:
 * ALC -> carrying -> late penalty -> PDP -> RF -> actual cost -> refund.
 */
async function autoLiquidate(plan, s, effectiveAt, transaction) {
  const base = eligiblePaid(plan, s);
  const pcBps = completionBps(plan, s);
  const alc = calc.autoLiquidCompensation({
    pcBps,
    eligiblePaid: base,
    planValue: planValue(plan),
  });

  const buckets = [
    { key: "alc", due: alc.amount },
    { key: "carrying", due: s.ac },
    { key: "latePenalty", due: s.lp },
    { key: "pastDuePenalty", due: s.pdp },
    { key: "restructureFee", due: s.rf },
    { key: "actualCost", due: s.actualCost },
  ];
  const totalDeductions = buckets.reduce((acc, b) => acc + b.due, 0n);
  const rawRefund = base - totalDeductions;
  const { allocations: got, remainder: finalRefund } = calc.allocateWaterfall(
    base,
    buckets,
  );

  const before = buildSnapshot(plan, s);

  s.acPaid += got.carrying;
  s.lpPaid += got.latePenalty;
  s.pdpPaid += got.pastDuePenalty;
  s.rfPaid += got.restructureFee;
  s.ac = 0n;
  s.lp = 0n;
  s.pdp = 0n;
  s.rf = 0n;

  plan.set({
    status: STATUS.AUTO_LIQUIDATED,
    alcRateBps: alc.rateBps,
    alcAmountIdr: alc.amount.toString(),
    rawRefundIdr: rawRefund.toString(),
    finalRefundIdr: finalRefund.toString(),
    nextCarryingAt: null,
    closedAt: effectiveAt,
  });
  queueChainOp(s, { type: "RECLAIM" });

  const refundTx = await ledger.creditWallet(
    {
      coreId: plan.coreId,
      amount: finalRefund,
      reference: `INSTALLMENT-LIQUIDATION-REFUND-${plan.id}`,
      description: `Refund auto liquidation Gold Installment ${plan.assetCode}`,
      metadata: { planId: plan.id, rawRefund, finalRefund },
    },
    transaction,
  );

  const flex = isFlexible(plan);
  const revenues = [
    [
      REV_ID.FLEX_ALC,
      got.alc,
      alc.rateBps,
      alc.base === "PLAN_VALUE" ? planValue(plan) : base,
    ],
    [REV_ID.FLEX_CARRY, got.carrying, RULES.CARRYING_BPS, null],
    [REV_ID.STD_LATE, got.latePenalty, RULES.LATE_PENALTY_DAILY_BPS, null],
    [REV_ID.FLEX_PASTDUE, got.pastDuePenalty, RULES.PAST_DUE_PENALTY_BPS, null],
    [REV_ID.FLEX_RESTRUCT, got.restructureFee, RULES.RESTRUCTURE_FEE_BPS, null],
  ];
  for (const [revId, amount, rateBps, calcBase] of revenues) {
    await ledger.recordRevenue(
      plan,
      {
        revId,
        amount,
        rateBps,
        base: calcBase,
        effectiveAt,
        sourceTransactionId: refundTx?.id ?? null,
        metadata: {
          trigger: "AUTO_LIQUIDATION",
          plan_type: flex ? "FLEXIBLE" : "STANDARD",
        },
      },
      transaction,
    );
  }

  const snapshot = buildSnapshot(plan, s, {
    alc_rate_bps: alc.rateBps,
    alc_amount: alc.amount.toString(),
    raw_refund: rawRefund.toString(),
    final_refund: finalRefund.toString(),
    deductions_collected: got,
    before,
    effective_at: effectiveAt,
  });
  plan.set({ calculationSnapshot: toJsonSafe(snapshot) });

  queuePush(s, {
    title: "Plan Liquidated",
    body: `Your plan was automatically liquidated. A refund of ${fmtIdr(finalRefund)} has been credited to your IDR wallet.`,
    data: {
      type: "installment",
      event: "auto_liquidated",
      plan_id: String(plan.id),
    },
  });

  await ledger.recordEvent(
    plan,
    { eventType: EVENT.AUTO_LIQUIDATED, effectiveAt, metadata: snapshot },
    transaction,
  );
}

/**
 * Terapkan semua event terjadwal dengan t <= effectiveAt secara kronologis.
 * Idempotent: state di DB yang menentukan, bukan waktu cron.
 */
async function settleToNow(plan, s, schedules, effectiveAt, transaction) {
  const now = cal.toDate(effectiveAt);

  // Sudah settle melewati now (mis. business clock dikembalikan ke REAL
  // setelah simulasi): semua event <= settled_through_at sudah teraplikasi,
  // settle jadi no-op dan plan tetap bisa dibaca/dibayar.
  if (plan.settledThroughAt && cal.toDate(plan.settledThroughAt) > now) {
    return;
  }

  // Loop sampai tidak ada event terjadwal tersisa <= now
  for (let guard = 0; guard < 1000; guard += 1) {
    if (plan.status === STATUS.REQUEST_CREATED) {
      if (now >= cal.toDate(plan.requestExpiresAt)) {
        await expireRequest(plan, plan.requestExpiresAt, transaction);
      }
      break;
    }

    if (isRunning(plan)) {
      if (!isFlexible(plan)) {
        await markOverdueSchedules(plan, s, schedules, now, transaction);
      }
      const maturity = cal.toDate(effectiveMaturity(plan));
      const candidates = [];

      if (isFlexible(plan) && plan.nextCarryingAt) {
        const t = cal.toDate(plan.nextCarryingAt);
        if (t <= now && t <= maturity)
          candidates.push({ t, type: "CARRY", order: 0 });
      }
      if (plan.status === STATUS.RESTRUCTURED && !plan.h3NotifiedAt) {
        const t = cal.addDays(
          plan.restructureMaturityAt,
          -RULES.H3_REMINDER_DAYS,
        );
        if (t <= now) candidates.push({ t, type: "H3", order: -1 });
      }
      if (maturity <= now)
        candidates.push({ t: maturity, type: "MATURITY", order: 1 });

      if (!candidates.length) {
        if (!isFlexible(plan)) {
          await accrueLatePenalty(
            plan,
            s,
            schedules,
            cal.minDate(now, maturity),
            transaction,
          );
        }
        break;
      }

      candidates.sort((a, b) => a.t - b.t || a.order - b.order);
      const next = candidates[0];

      if (next.type === "CARRY") {
        await accrueCarrying(plan, s, next.t, transaction);
      } else if (next.type === "H3") {
        plan.set({ h3NotifiedAt: next.t });
        await ledger.recordEvent(
          plan,
          {
            eventType: EVENT.RESTRUCTURE_H3_NOTICE,
            effectiveAt: next.t,
            metadata: { restructure_maturity_at: plan.restructureMaturityAt },
          },
          transaction,
        );
      } else {
        if (!isFlexible(plan)) {
          await accrueLatePenalty(plan, s, schedules, next.t, transaction);
        }
        if (s.po === 0n && totalObligation(s) === 0n) {
          await markFullySettled(plan, s, next.t, transaction);
        } else if (plan.status === STATUS.RESTRUCTURED) {
          await autoLiquidate(plan, s, next.t, transaction);
        } else {
          await enterPastDue(plan, s, next.t, transaction);
        }
      }
      continue;
    }

    if (plan.status === STATUS.PAST_DUE) {
      if (!isFlexible(plan)) {
        await markOverdueSchedules(plan, s, schedules, now, transaction);
      }
      if (now >= cal.toDate(plan.cureEndsAt)) {
        await autoLiquidate(plan, s, plan.cureEndsAt, transaction);
      }
      break;
    }

    if (plan.status === STATUS.COMPLETE_PENDING_CLAIM) {
      if (now >= cal.toDate(plan.claimableAt)) {
        plan.set({ status: STATUS.CLAIMABLE });
        await ledger.recordEvent(
          plan,
          { eventType: EVENT.CLAIMABLE, effectiveAt: plan.claimableAt },
          transaction,
        );
      }
      break;
    }

    break;
  }
}

// ============================================================
// User actions
// ============================================================

/**
 * Aktivasi kontrak: bayar DP (Flexible) / tanpa pembayaran awal (Standard).
 * Mengembalikan { applied, allocation }.
 */
async function activate(
  plan,
  s,
  schedules,
  requestedAmount,
  effectiveAt,
  transaction,
) {
  if (plan.status !== STATUS.REQUEST_CREATED) {
    throw new InstallmentError(
      `Plan is not in REQUEST_CREATED status (${plan.status})`,
      {
        status: 409,
        code: "INVALID_STATE",
      },
    );
  }

  const initial = big(plan.initialPaymentIdr);
  if (requestedAmount < initial) {
    throw new InstallmentError(
      `Initial payment must be exactly ${initial.toString()} IDR (DP)`,
      { code: "INITIAL_PAYMENT_MISMATCH", details: { required_idr: initial } },
    );
  }

  const activatedAt = cal.toDate(effectiveAt);
  const maturityAt = cal.calendarMonthsFrom(activatedAt, plan.tenorMonths);
  const claimableAt = cal.calendarDaysFrom(activatedAt, RULES.CLAIM_DELAY_DAYS);

  plan.set({ status: STATUS.ACTIVE, activatedAt, maturityAt, claimableAt });
  queueChainOp(s, { type: "ALLOCATE" });

  let allocation;
  if (isFlexible(plan)) {
    s.epp += initial;
    s.po = big(plan.lockedPlanValueIdr) - s.epp;
    plan.set({
      nextCarryingIndex: 1,
      nextCarryingAt: cal.anniversaryAt(activatedAt, 1),
    });
    allocation = { carrying: 0n, principal: initial };

    await ledger.recordRevenue(
      plan,
      {
        revId: REV_ID.FLEX_LOCK,
        amount: big(plan.lockedPlanValueIdr) - big(plan.assetValueIdr),
        rateBps: plan.priceLockMarginBps,
        base: big(plan.assetValueIdr),
        effectiveAt: activatedAt,
        metadata: { trigger: "ACTIVATION", note: "embedded into LPV" },
      },
      transaction,
    );
  } else {
    const amounts = calc.buildStandardInstallments(
      plan.standardTotalPaymentIdr,
      plan.scheduleCount,
    );
    const rows = amounts.map((amountIdr, i) => ({
      planId: plan.id,
      sequence: i + 1,
      // Standard tidak ada pembayaran awal: cicilan ke-N jatuh tempo di
      // interval ke-N setelah aktivasi (bulan 1..tenor, bukan dari hari H).
      dueAt:
        plan.installmentGap === "MONTHLY"
          ? cal.calendarMonthsFrom(activatedAt, i + 1)
          : cal.calendarDaysFrom(activatedAt, 7 * (i + 1)),
      amountIdr: amountIdr.toString(),
    }));
    const created = await InstallmentSchedule.bulkCreate(rows, {
      transaction,
      returning: true,
    });
    schedules.splice(0, schedules.length, ...created);

    allocateToSchedules(schedules, initial, activatedAt);
    s.sepa += initial;
    s.po = big(plan.standardTotalPaymentIdr) - s.sepa;
    allocation = { latePenalty: 0n, principal: initial };

    await ledger.recordRevenue(
      plan,
      {
        revId: REV_ID.STD_MARKUP,
        amount: big(plan.standardTotalPaymentIdr) - big(plan.assetValueIdr),
        rateBps: plan.markupBps,
        base: big(plan.assetValueIdr),
        effectiveAt: activatedAt,
        metadata: { trigger: "ACTIVATION" },
      },
      transaction,
    );
  }

  s.gross += initial;

  await ledger.recordEvent(
    plan,
    {
      eventType: EVENT.ACTIVATED,
      effectiveAt: activatedAt,
      metadata: {
        maturity_at: maturityAt,
        claimable_at: claimableAt,
        initial_payment: initial,
        schedule_count: plan.scheduleCount,
      },
    },
    transaction,
  );

  await afterPrincipalChange(plan, s, activatedAt, transaction);

  return { applied: initial, allocation };
}

/** Tutup cancellation jika PC > 50%; selesaikan plan jika PO = 0. */
async function afterPrincipalChange(plan, s, effectiveAt, transaction) {
  const pc = completionBps(plan, s);

  if (plan.status === STATUS.ACTIVE && pc > RULES.CANCEL_MAX_PC_BPS) {
    plan.set({
      status: STATUS.CANCELLATION_CLOSED,
      cancellationClosedAt: effectiveAt,
    });
    await ledger.recordEvent(
      plan,
      {
        eventType: EVENT.CANCELLATION_CLOSED,
        effectiveAt,
        metadata: { payment_completion_bps: pc },
      },
      transaction,
    );
  }

  if (s.po === 0n && totalObligation(s) === 0n && !plan.fullySettledAt) {
    await markFullySettled(plan, s, effectiveAt, transaction);
  }
}

function paymentBuckets(plan, s) {
  const flex = isFlexible(plan);
  const restructured = plan.status === STATUS.RESTRUCTURED;
  const pastDue = plan.status === STATUS.PAST_DUE;

  const buckets = [];
  if (!flex) buckets.push({ key: "latePenalty", due: s.lp });
  if (flex) buckets.push({ key: "carrying", due: s.ac });
  if (restructured || pastDue) {
    buckets.push({ key: "pastDuePenalty", due: s.pdp });
    buckets.push({ key: "restructureFee", due: s.rf });
  }
  buckets.push({ key: "principal", due: s.po });
  return buckets;
}

/**
 * Pembayaran reguler / settlement. Mengembalikan { applied, allocation, kind }.
 * Kelebihan di atas total obligation TIDAK didebit (tidak menjadi revenue).
 */
async function applyPayment(
  plan,
  s,
  schedules,
  requestedAmount,
  effectiveAt,
  transaction,
) {
  const obligation = totalObligation(s);

  if (!isRunning(plan) && plan.status !== STATUS.PAST_DUE) {
    throw new InstallmentError(`Plan cannot accept payment (${plan.status})`, {
      status: 409,
      code: "INVALID_STATE",
    });
  }
  if (obligation <= 0n) {
    throw new InstallmentError("No remaining obligation", {
      status: 409,
      code: "NOTHING_TO_PAY",
    });
  }

  let kind = PAYMENT_KIND.PAYMENT;
  if (plan.status === STATUS.PAST_DUE) {
    // 9.2: tidak ada partial payment selama Cure
    if (requestedAmount < obligation) {
      throw new InstallmentError(
        `During the Cure Period only full settlement is allowed: ${obligation.toString()} IDR`,
        {
          code: "FULL_SETTLEMENT_REQUIRED",
          details: { required_idr: obligation },
        },
      );
    }
    kind = PAYMENT_KIND.SETTLEMENT;
  } else {
    const minAllowed = minBig(RULES.MIN_PAYMENT_IDR, obligation);
    if (requestedAmount < minAllowed) {
      throw new InstallmentError(
        `Minimum payment is ${minAllowed.toString()} IDR`,
        { code: "BELOW_MINIMUM_PAYMENT", details: { min_idr: minAllowed } },
      );
    }
  }

  const applied = minBig(requestedAmount, obligation);
  if (applied === obligation) kind = PAYMENT_KIND.SETTLEMENT;

  const { allocations } = calc.allocateWaterfall(
    applied,
    paymentBuckets(plan, s),
  );
  const got = {
    carrying: allocations.carrying ?? 0n,
    latePenalty: allocations.latePenalty ?? 0n,
    pastDuePenalty: allocations.pastDuePenalty ?? 0n,
    restructureFee: allocations.restructureFee ?? 0n,
    principal: allocations.principal ?? 0n,
  };

  s.ac -= got.carrying;
  s.acPaid += got.carrying;
  s.lp -= got.latePenalty;
  s.lpPaid += got.latePenalty;
  s.pdp -= got.pastDuePenalty;
  s.pdpPaid += got.pastDuePenalty;
  s.rf -= got.restructureFee;
  s.rfPaid += got.restructureFee;
  s.po -= got.principal;
  s.gross += applied;

  if (isFlexible(plan)) {
    s.epp += got.principal;
  } else {
    s.sepa += got.principal;
    allocateToSchedules(schedules, got.principal, effectiveAt);
  }

  const revenues = [
    [REV_ID.FLEX_CARRY, got.carrying, RULES.CARRYING_BPS],
    [REV_ID.STD_LATE, got.latePenalty, RULES.LATE_PENALTY_DAILY_BPS],
    [REV_ID.FLEX_PASTDUE, got.pastDuePenalty, RULES.PAST_DUE_PENALTY_BPS],
    [REV_ID.FLEX_RESTRUCT, got.restructureFee, RULES.RESTRUCTURE_FEE_BPS],
  ];
  for (const [revId, amount, rateBps] of revenues) {
    await ledger.recordRevenue(
      plan,
      { revId, amount, rateBps, effectiveAt, metadata: { trigger: "PAYMENT" } },
      transaction,
    );
  }

  if (plan.status === STATUS.PAST_DUE) {
    plan.set({ status: STATUS.CANCELLATION_CLOSED });
  }

  await afterPrincipalChange(plan, s, effectiveAt, transaction);

  return { applied, allocation: got, kind };
}

/**
 * Voluntary cancellation (brief 8). Hanya ACTIVE & PC <= 50%.
 * Base: Flexible = EPP, Standard = SEPA.
 */
async function cancel(plan, s, effectiveAt, transaction) {
  const pc = completionBps(plan, s);
  if (plan.status !== STATUS.ACTIVE || pc > RULES.CANCEL_MAX_PC_BPS) {
    throw new InstallmentError(
      "Cancellation is not available (only while ACTIVE and Payment Completion <= 50%)",
      {
        status: 409,
        code: "CANCELLATION_NOT_AVAILABLE",
        details: { payment_completion_bps: pc },
      },
    );
  }

  const base = eligiblePaid(plan, s);
  const rateBps = calc.cancellationRateBps(pc);
  const compensation = bpsOf(base, rateBps);
  const flex = isFlexible(plan);

  const buckets = [
    { key: "compensation", due: compensation },
    { key: flex ? "carrying" : "latePenalty", due: flex ? s.ac : s.lp },
    { key: "actualCost", due: s.actualCost },
  ];
  const rawRefund = base - buckets.reduce((acc, b) => acc + b.due, 0n);
  const { allocations: got, remainder: finalRefund } = calc.allocateWaterfall(
    base,
    buckets,
  );

  const before = buildSnapshot(plan, s);

  if (flex) {
    s.acPaid += got.carrying;
    s.ac = 0n;
  } else {
    s.lpPaid += got.latePenalty;
    s.lp = 0n;
  }

  plan.set({
    status: STATUS.CANCELLED,
    cancellationRateBps: rateBps,
    cancellationCompensationIdr: compensation.toString(),
    rawRefundIdr: rawRefund.toString(),
    finalRefundIdr: finalRefund.toString(),
    nextCarryingAt: null,
    closedAt: effectiveAt,
  });
  queueChainOp(s, { type: "RECLAIM" });

  const refundTx = await ledger.creditWallet(
    {
      coreId: plan.coreId,
      amount: finalRefund,
      reference: `INSTALLMENT-CANCEL-REFUND-${plan.id}`,
      description: `Refund pembatalan Gold Installment ${plan.assetCode}`,
      metadata: { planId: plan.id, rawRefund, finalRefund },
    },
    transaction,
  );

  await ledger.recordRevenue(
    plan,
    {
      revId: flex ? REV_ID.FLEX_CANCEL : REV_ID.STD_CANCEL,
      amount: got.compensation,
      rateBps,
      base,
      effectiveAt,
      sourceTransactionId: refundTx?.id ?? null,
      metadata: { trigger: "CANCELLATION", payment_completion_bps: pc },
    },
    transaction,
  );
  await ledger.recordRevenue(
    plan,
    {
      revId: flex ? REV_ID.FLEX_CARRY : REV_ID.STD_LATE,
      amount: flex ? got.carrying : got.latePenalty,
      effectiveAt,
      sourceTransactionId: refundTx?.id ?? null,
      metadata: { trigger: "CANCELLATION" },
    },
    transaction,
  );

  const snapshot = buildSnapshot(plan, s, {
    cancellation_rate_bps: rateBps,
    cancellation_compensation: compensation.toString(),
    raw_refund: rawRefund.toString(),
    final_refund: finalRefund.toString(),
    deductions_collected: got,
    before,
    effective_at: effectiveAt,
  });
  plan.set({ calculationSnapshot: toJsonSafe(snapshot) });

  await ledger.recordEvent(
    plan,
    { eventType: EVENT.CANCELLED, effectiveAt, metadata: snapshot },
    transaction,
  );

  return { rateBps, compensation, rawRefund, finalRefund };
}

/**
 * One-time restructure (brief 10). Hanya FLEXIBLE, PAST_DUE dalam Cure,
 * dan PC > 80%. Standard tidak punya restructure.
 */
async function restructure(plan, s, effectiveAt, transaction) {
  const pc = completionBps(plan, s);
  const now = cal.toDate(effectiveAt);

  if (!isFlexible(plan)) {
    throw new InstallmentError(
      "Restructure is only available for Flexible plans",
      { status: 409, code: "RESTRUCTURE_NOT_AVAILABLE" },
    );
  }
  if (plan.status !== STATUS.PAST_DUE || now >= cal.toDate(plan.cureEndsAt)) {
    throw new InstallmentError(
      "Restructure is only available during the Cure Period",
      {
        status: 409,
        code: "RESTRUCTURE_NOT_AVAILABLE",
      },
    );
  }
  if (plan.restructureStartedAt) {
    throw new InstallmentError("Restructure is only allowed once", {
      status: 409,
      code: "RESTRUCTURE_ALREADY_USED",
    });
  }
  if (pc <= RULES.RESTRUCTURE_MIN_PC_BPS) {
    throw new InstallmentError(
      "Restructure requires Payment Completion > 80%",
      {
        status: 409,
        code: "RESTRUCTURE_NOT_ELIGIBLE",
        details: { payment_completion_bps: pc },
      },
    );
  }

  const fee = calc.restructureFee(s.po);
  const extension = calc.restructureExtensionMonths(plan.tenorMonths);
  const restructureMaturityAt = cal.calendarMonthsFrom(
    plan.activatedAt,
    Number(plan.tenorMonths) + extension,
  );

  s.rf += fee;
  plan.set({
    status: STATUS.RESTRUCTURED,
    restructureStartedAt: effectiveAt,
    restructureMaturityAt,
    restructureExtensionMonths: extension,
    nextCarryingAt: isFlexible(plan)
      ? cal.anniversaryAt(plan.activatedAt, plan.nextCarryingIndex)
      : null,
  });

  await ledger.recordEvent(
    plan,
    {
      eventType: EVENT.RESTRUCTURE_ACTIVATED,
      effectiveAt,
      metadata: {
        restructure_fee: fee,
        extension_months: extension,
        restructure_maturity_at: restructureMaturityAt,
        principal_outstanding: s.po,
        past_due_penalty_outstanding: s.pdp,
        payment_completion_bps: pc,
      },
    },
    transaction,
  );

  return { fee, extension, restructureMaturityAt };
}

// ============================================================
// Read-side helpers (tanpa mutasi DB)
// ============================================================

function eligibility(plan, s, at = new Date()) {
  const pc = completionBps(plan, s);
  const obligation = totalObligation(s);
  const now = cal.toDate(at);

  const canPay = isRunning(plan) || plan.status === STATUS.PAST_DUE;
  const minPayment =
    plan.status === STATUS.PAST_DUE
      ? obligation
      : minBig(RULES.MIN_PAYMENT_IDR, clampNonNegative(obligation));

  const canCancel =
    plan.status === STATUS.ACTIVE && pc <= RULES.CANCEL_MAX_PC_BPS;
  let cancelQuote = null;
  if (canCancel) {
    const base = eligiblePaid(plan, s);
    const rateBps = calc.cancellationRateBps(pc);
    const compensation = bpsOf(base, rateBps);
    const deductions =
      compensation + (isFlexible(plan) ? s.ac : s.lp) + s.actualCost;
    cancelQuote = {
      rate_bps: rateBps,
      compensation_idr: compensation,
      raw_refund_idr: base - deductions,
      final_refund_idr: clampNonNegative(base - deductions),
    };
  }

  const canRestructure =
    isFlexible(plan) &&
    plan.status === STATUS.PAST_DUE &&
    !plan.restructureStartedAt &&
    now < cal.toDate(plan.cureEndsAt) &&
    pc > RULES.RESTRUCTURE_MIN_PC_BPS;

  const claimQuote =
    plan.status === STATUS.CLAIMABLE ||
    plan.status === STATUS.COMPLETE_PENDING_CLAIM
      ? {
          protocol_fee_bps: plan.protocolFeeBps,
          protocol_fee_idr: big(plan.protocolFeeIdr),
          estimated_network_fee_idr: big(plan.claimNetworkFeeIdr ?? 0),
          claimable_at: plan.claimableAt,
          is_claimable: plan.status === STATUS.CLAIMABLE,
        }
      : null;

  return {
    payment_completion_bps: pc,
    total_obligation_idr: obligation,
    can_pay: canPay && obligation > 0n,
    min_payment_idr: canPay ? minPayment : null,
    can_cancel: canCancel,
    cancel_quote: cancelQuote,
    cancellation_available_until_bps: RULES.CANCEL_MAX_PC_BPS,
    can_restructure: canRestructure,
    restructure_quote: canRestructure
      ? {
          fee_idr: calc.restructureFee(s.po),
          extension_months: calc.restructureExtensionMonths(plan.tenorMonths),
          new_maturity_at: cal.calendarMonthsFrom(
            plan.activatedAt,
            Number(plan.tenorMonths) +
              calc.restructureExtensionMonths(plan.tenorMonths),
          ),
        }
      : null,
    claim_quote: claimQuote,
  };
}

module.exports = {
  isFlexible,
  isRunning,
  loadState,
  loadSchedules,
  totalObligation,
  completionBps,
  buildSnapshot,
  computeNextEventAt,
  persist,
  settleToNow,
  activate,
  applyPayment,
  cancel,
  restructure,
  eligibility,
};
