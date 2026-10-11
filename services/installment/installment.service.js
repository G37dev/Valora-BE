const {
  sequelize,
  Price,
  InstallmentPlan,
  InstallmentSchedule,
  InstallmentPayment,
  InstallmentEvent,
  InternalWallet,
} = require("../../models");
const calc = require("./installment.calc");
const cal = require("./installment.calendar");
const engine = require("./installment.engine");
const ledger = require("./installment.ledger");
const bc = require("./installment.blockchain.service");
const v = require("./installment.validation");
const { InstallmentError, toJsonSafe } = require("./installment.errors");
const pushService = require("../pushService");
const {
  RULES_VERSION,
  PLAN_TYPE,
  STATUS,
  RULES,
  EVENT,
  PAYMENT_KIND,
  TERMINAL_STATUSES,
  PROTOCOL_FEE_STATUS,
  REV_ID,
} = require("./installment.constants");

const Decimal = require("decimal.js");

const MAX_PRICE_AGE_MS = Number(
  process.env.INSTALLMENT_MAX_PRICE_AGE_MS ?? 10 * 60 * 1000,
);

// Price table stores gold-backed assets per GRAM (see priceController:
// Indodax XAUT/oz is divided by 31.1035). Installment amounts are token
// units — for XAUT, 1 token = 1 troy ounce — so the locked price must be
// converted back to per-ounce before quoting. Same convention as swap.
const OZ_TO_GRAMS = new Decimal("31.1035");

// ============================================================
// Helpers
// ============================================================

/**
 * Jalankan fn dalam transaction baru, atau SAVEPOINT di dalam transaction
 * yang diberikan (sehingga kegagalan fn hanya me-rollback bagian fn).
 */
function withTransaction(transaction, fn) {
  return transaction
    ? sequelize.transaction({ transaction }, fn)
    : sequelize.transaction(fn);
}

const fmtIdr = (v) => `${Number(v).toLocaleString("id-ID")} IDR`;

// Token amount: trim trailing zeros — "10.000000" -> "10", "10.470000" -> "10.47"
const fmtToken = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "0");
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
};

const tokenUnit = (assetCode) => (assetCode === "XAUT" ? "XAUT" : "VVLR");

const fmtDateId = (d) =>
  new Intl.DateTimeFormat("id-ID", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
    timeZoneName: "short",
  }).format(new Date(d));

/**
 * Kirim push notification yang di-queue engine selama settle (s.pushes).
 * Dipanggil SETELAH transaction commit — kegagalan push tidak boleh
 * menggagalkan operasi finansial.
 */
async function dispatchPushes(plan, s) {
  for (const p of s?.pushes ?? []) {
    try {
      await pushService.sendPushToUser(plan.coreId, p);
    } catch (error) {
      console.log(`[Installment] push gagal plan ${plan.id}:`, error.message);
    }
  }
}

async function sendInstallmentPush(coreId, push) {
  try {
    await pushService.sendPushToUser(coreId, push);
  } catch (error) {
    console.log(`[Installment] push gagal core ${coreId}:`, error.message);
  }
}

/**
 * Operasi on-chain yang di-queue engine selama settle (s.chainOps).
 * Dipanggil SETELAH transaction commit — best-effort: kegagalan chain
 * hanya di-log, tidak me-rollback state DB. Claim endpoint punya
 * ensure-allocation sendiri sehingga allocate yang gagal di sini
 * tetap bisa di-retry lewat jalur claim.
 */
async function dispatchChainOps(plan, s) {
  for (const op of s?.chainOps ?? []) {
    try {
      if (op.type === "ALLOCATE") {
        const beneficiary = await bc.getBeneficiaryAddress(plan.coreId);
        if (!beneficiary) {
          console.log(
            `[Installment Chain] allocate skip plan ${plan.id}: wallet on-chain belum ada`,
          );
          continue;
        }
        const txHash = await bc.allocatePlanOnChain(plan, beneficiary);
        console.log(`[Installment Chain] allocate plan ${plan.id}: ${txHash}`);
      } else if (op.type === "RECLAIM") {
        const onchain = await bc.readOnchainPlan(plan);
        if (onchain.status !== bc.ONCHAIN_STATUS.ALLOCATED) continue;
        const txHash = await bc.reclaimPlanOnChain(plan);
        console.log(`[Installment Chain] reclaim plan ${plan.id}: ${txHash}`);
      }
    } catch (error) {
      console.error(
        `[Installment Chain] ${op.type} plan ${plan.id} gagal:`,
        error.message,
      );
    }
  }
}

async function lockPrice(asset) {
  const row = await Price.findOne({ where: { asset } });
  if (!row) {
    throw new InstallmentError(`Price for ${asset} is not available`, {
      status: 503,
      code: "PRICE_UNAVAILABLE",
    });
  }
  const ageMs = Date.now() - new Date(row.updatedAt).getTime();
  if (MAX_PRICE_AGE_MS > 0 && ageMs > MAX_PRICE_AGE_MS) {
    throw new InstallmentError(`Price for ${asset} is stale, please retry`, {
      status: 503,
      code: "PRICE_STALE",
      details: { age_ms: ageMs },
    });
  }
  const pricePerUnit =
    asset === "XAUT"
      ? new Decimal(String(row.priceIdr)).mul(OZ_TO_GRAMS)
      : new Decimal(String(row.priceIdr));
  return {
    priceIdr: pricePerUnit.toFixed(0),
    source: row.source,
    updatedAt: row.updatedAt,
  };
}

function parseQuoteInput(body, requestAt) {
  const planType = v.parsePlanType(body.plan_type);
  const asset = v.normalizeAsset(body.asset);
  const tenorMonths = v.parseTenor(body.tenor_months);
  const goldAmount = v.parseGoldAmount(body.gold_amount);

  if (planType === PLAN_TYPE.STANDARD) {
    return {
      planType,
      asset,
      tenorMonths,
      goldAmount,
      installmentGap: v.parseGap(body.installment_gap),
      requestAt,
    };
  }
  return {
    planType,
    asset,
    tenorMonths,
    goldAmount,
    dpBps: v.parseDpBps(body),
    requestAt,
  };
}

function buildQuote(input, lockedPriceIdr) {
  if (input.planType === PLAN_TYPE.STANDARD) {
    return calc.standardQuote({ ...input, lockedPriceIdr });
  }
  return calc.flexibleQuote({ ...input, lockedPriceIdr });
}

async function lockPlan(planId, coreId, transaction) {
  const plan = await InstallmentPlan.findOne({
    where: { id: planId, coreId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!plan) {
    throw new InstallmentError("Plan not found", {
      status: 404,
      code: "PLAN_NOT_FOUND",
    });
  }
  return plan;
}

// ============================================================
// Quote
// ============================================================

async function quote(body, { now = new Date() } = {}) {
  const input = parseQuoteInput(body, now);
  const price = await lockPrice(input.asset);
  const q = buildQuote(input, price.priceIdr);
  return toJsonSafe({
    ...q,
    price_source: price.source,
    price_updated_at: price.updatedAt,
    request_window_hours: RULES.REQUEST_WINDOW_HOURS,
    rules_version: RULES_VERSION,
  });
}

// ============================================================
// Create request (price lock)
// ============================================================

async function findExistingPlan(idempotencyKey, coreId, transaction) {
  const existing = await InstallmentPlan.findOne({
    where: { idempotencyKey },
    transaction,
  });
  if (existing && existing.coreId !== coreId) {
    throw new InstallmentError("idempotency_key already used", {
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
  }
  return existing;
}

async function createRequest({
  coreId,
  body,
  now = new Date(),
  isTest = false,
  transaction,
}) {
  const idempotencyKey = v.requireIdempotencyKey(body.idempotency_key);

  const existing = await findExistingPlan(idempotencyKey, coreId, transaction);
  if (existing) return { plan: existing, created: false };

  const input = parseQuoteInput(body, now);
  const price = await lockPrice(input.asset);
  const q = buildQuote(input, price.priceIdr);

  if (input.planType === PLAN_TYPE.STANDARD && !q.meetsMinimum) {
    throw new InstallmentError(
      `Each installment must be >= ${RULES.MIN_INSTALLMENT_IDR.toString()} IDR. Minimum amount: ${q.minGoldAmount} ${tokenUnit(input.asset)}`,
      {
        code: "BELOW_MINIMUM_INSTALLMENT",
        details: {
          min_gold_amount: q.minGoldAmount,
          installments: q.installments,
        },
      },
    );
  }

  const isStandard = input.planType === PLAN_TYPE.STANDARD;
  const protocolFee = calc.protocolFee(q.assetValue);

  let sRef = null;
  let plan;
  try {
    plan = await withTransaction(transaction, async (t) => {
      const created = await InstallmentPlan.create(
        {
          coreId,
          planType: input.planType,
          assetCode: input.asset,
          goldAmount: input.goldAmount,
          lockedPriceIdr: price.priceIdr,
          priceSource: price.source,
          assetValueIdr: q.assetValue.toString(),
          tenorMonths: input.tenorMonths,
          installmentGap: isStandard ? input.installmentGap : null,
          markupBps: isStandard ? q.markupBps : null,
          scheduleCount: isStandard ? q.scheduleCount : null,
          standardTotalPaymentIdr: isStandard
            ? q.totalPayment.toString()
            : null,
          priceLockMarginBps: isStandard ? null : q.priceLockMarginBps,
          lockedPlanValueIdr: isStandard ? null : q.lockedPlanValue.toString(),
          dpBps: isStandard ? null : q.dpBps,
          // Standard: tanpa pembayaran awal — aktivasi otomatis.
          initialPaymentIdr: isStandard ? "0" : q.initialPayment.toString(),
          principalOutstandingIdr: (isStandard
            ? q.totalPayment
            : q.lockedPlanValue
          ).toString(),
          protocolFeeBps: RULES.PROTOCOL_FEE_BPS,
          protocolFeeIdr: protocolFee.toString(),
          status: STATUS.REQUEST_CREATED,
          requestCreatedAt: now,
          requestExpiresAt: cal.addHours(now, RULES.REQUEST_WINDOW_HOURS),
          nextEventAt: cal.addHours(now, RULES.REQUEST_WINDOW_HOURS),
          settledThroughAt: now,
          idempotencyKey,
          rulesVersion: RULES_VERSION,
          isTest,
          calculationSnapshot: toJsonSafe({
            quote: q,
            price_source: price.source,
            price_updated_at: price.updatedAt,
            effective_at: now,
            rules_version: RULES_VERSION,
          }),
        },
        { transaction: t },
      );

      await ledger.recordEvent(
        created,
        {
          eventType: EVENT.REQUEST_CREATED,
          effectiveAt: now,
          metadata: { quote: q, expires_at: created.requestExpiresAt },
        },
        t,
      );

      // Standard tidak butuh pembayaran awal: kontrak langsung aktif di
      // request creation, cicilan pertama jatuh tempo di interval pertama.
      if (isStandard) {
        const s = engine.loadState(created);
        sRef = s;
        const schedules = [];
        await engine.activate(created, s, schedules, 0n, now, t);
        await engine.persist(created, s, schedules, now, t);
      }

      return created;
    });
  } catch (error) {
    // Race: request paralel dengan idempotency_key sama -> kembalikan yang menang
    if (error?.name === "SequelizeUniqueConstraintError" && !transaction) {
      const winner = await findExistingPlan(idempotencyKey, coreId);
      if (winner) return { plan: winner, created: false };
    }
    throw error;
  }

  if (!transaction) {
    await dispatchChainOps(plan, sRef);
    await sendInstallmentPush(
      plan.coreId,
      plan.status === STATUS.ACTIVE
        ? {
            title: "Installment Active",
            body: `Your ${isStandard ? "Standard" : "Flexible"} plan for ${fmtToken(plan.goldAmount)} ${tokenUnit(plan.assetCode)} is now active. Total payment ${fmtIdr(plan.standardTotalPaymentIdr ?? plan.lockedPlanValueIdr)}.`,
            data: {
              type: "installment",
              event: "activated",
              plan_id: String(plan.id),
            },
          }
        : {
            title: "Awaiting Payment",
            body: `Pay ${fmtIdr(plan.initialPaymentIdr)} before ${fmtDateId(plan.requestExpiresAt)} to activate your installment plan.`,
            data: {
              type: "installment",
              event: "request_created",
              plan_id: String(plan.id),
            },
          },
    );
  }

  return { plan, created: true };
}

// ============================================================
// Pay (activation / payment / settlement)
// ============================================================

async function pay({ coreId, planId, body, now = new Date(), transaction }) {
  const idempotencyKey = v.requireIdempotencyKey(body.idempotency_key);
  const requested = v.parseIdrAmount(body.amount_idr);

  await settlePlan(planId, now, transaction);

  let sRef = null;
  const out = await withTransaction(transaction, async (t) => {
    // Lock plan dulu -> pembayaran paralel untuk plan yang sama diserialisasi,
    // sehingga cek idempotency di bawah ini bebas race.
    const plan = await lockPlan(planId, coreId, t);

    const duplicate = await InstallmentPayment.findOne({
      where: { idempotencyKey },
      transaction: t,
    });
    if (duplicate) {
      if (duplicate.coreId !== coreId || duplicate.planId !== planId) {
        throw new InstallmentError("idempotency_key already used", {
          status: 409,
          code: "IDEMPOTENCY_CONFLICT",
        });
      }
      return { plan, payment: duplicate, duplicate: true, excess: 0n };
    }

    const s = engine.loadState(plan);
    sRef = s;
    const schedules = await engine.loadSchedules(plan, t);

    await engine.settleToNow(plan, s, schedules, now, t);

    if (
      TERMINAL_STATUSES.includes(plan.status) ||
      plan.status === STATUS.REQUEST_EXPIRED
    ) {
      throw new InstallmentError(`Plan is already ${plan.status}`, {
        status: 409,
        code: "INVALID_STATE",
      });
    }

    const statusBefore = plan.status;
    let result;
    let kind;
    if (plan.status === STATUS.REQUEST_CREATED) {
      result = await engine.activate(plan, s, schedules, requested, now, t);
      kind = PAYMENT_KIND.INITIAL;
    } else {
      result = await engine.applyPayment(plan, s, schedules, requested, now, t);
      kind = result.kind;
    }

    const reference = `INSTALLMENT-PAY-${plan.id}-${idempotencyKey}`;
    const debit = await ledger.debitWallet(
      {
        coreId,
        amount: result.applied,
        reference,
        description: `Gold Installment ${plan.planType} ${plan.assetCode} (${kind})`,
        metadata: { planId: plan.id, kind, allocation: result.allocation },
      },
      t,
    );

    const payment = await InstallmentPayment.create(
      {
        planId: plan.id,
        coreId,
        kind,
        requestedAmountIdr: requested.toString(),
        amountIdr: result.applied.toString(),
        effectiveAt: now,
        allocation: toJsonSafe(result.allocation),
        statusBefore,
        statusAfter: plan.status,
        internalTransactionId: debit.id,
        reference,
        idempotencyKey,
        calculationSnapshot: toJsonSafe(
          engine.buildSnapshot(plan, s, { effective_at: now }),
        ),
      },
      { transaction: t },
    );

    await ledger.recordEvent(
      plan,
      {
        eventType: EVENT.PAYMENT_APPLIED,
        effectiveAt: now,
        metadata: {
          payment_id: payment.id,
          kind,
          requested: requested,
          applied: result.applied,
          excess_not_debited: requested - result.applied,
          allocation: result.allocation,
          status_before: statusBefore,
          status_after: plan.status,
        },
      },
      t,
    );

    await engine.persist(plan, s, schedules, now, t);

    return {
      plan,
      payment,
      duplicate: false,
      excess: requested - result.applied,
    };
  });

  if (!transaction) {
    await dispatchPushes(out.plan, sRef);
    await dispatchChainOps(out.plan, sRef);
    if (!out.duplicate) {
      await sendInstallmentPush(coreId, {
        title: "Payment Received",
        body: `Payment of ${fmtIdr(out.payment.amountIdr)} received. Remaining obligation: ${fmtIdr(out.plan.principalOutstandingIdr)}.`,
        data: {
          type: "installment",
          event: "payment_applied",
          plan_id: String(out.plan.id),
          payment_id: String(out.payment.id),
        },
      });
    }
  }

  return out;
}

// ============================================================
// Cancel / Restructure
// ============================================================

async function cancel({ coreId, planId, now = new Date(), transaction }) {
  await settlePlan(planId, now, transaction);

  let sRef = null;
  const out = await withTransaction(transaction, async (t) => {
    const plan = await lockPlan(planId, coreId, t);
    const s = engine.loadState(plan);
    sRef = s;
    const schedules = await engine.loadSchedules(plan, t);

    await engine.settleToNow(plan, s, schedules, now, t);
    const result = await engine.cancel(plan, s, now, t);
    await engine.persist(plan, s, schedules, now, t);

    return { plan, result };
  });
  if (!transaction) await dispatchChainOps(out.plan, sRef);
  return out;
}

async function restructure({ coreId, planId, now = new Date(), transaction }) {
  await settlePlan(planId, now, transaction);

  return withTransaction(transaction, async (t) => {
    const plan = await lockPlan(planId, coreId, t);
    const s = engine.loadState(plan);
    const schedules = await engine.loadSchedules(plan, t);

    await engine.settleToNow(plan, s, schedules, now, t);
    const result = await engine.restructure(plan, s, now, t);
    await engine.persist(plan, s, schedules, now, t);

    return { plan, result };
  });
}

// ============================================================
// Claim (release asset on-chain)
// ============================================================

/**
 * Claim asset plan yang sudah CLAIMABLE.
 * Urutan: validasi -> cek fee & beneficiary -> on-chain allocate (jika
 * perlu) + releaseClaim -> finalisasi DB (fee debit, CLOSED, tx hash).
 * Idempotent: plan CLOSED / chain CLAIMED langsung di-return tanpa tx baru.
 */
async function claim({ coreId, planId, now = new Date(), transaction }) {
  await settlePlan(planId, now, transaction);

  const plan = await InstallmentPlan.findOne({
    where: { id: planId, coreId },
  });
  if (!plan) {
    throw new InstallmentError("Plan not found", {
      status: 404,
      code: "PLAN_NOT_FOUND",
    });
  }

  if (plan.status === STATUS.CLOSED && plan.releaseTxHash) {
    return { plan, txHash: plan.releaseTxHash, duplicate: true };
  }

  if (plan.status === STATUS.COMPLETE_PENDING_CLAIM) {
    throw new InstallmentError(
      `Asset will be claimable from ${fmtDateId(plan.claimableAt)}`,
      {
        status: 409,
        code: "NOT_CLAIMABLE_YET",
        details: { claimable_at: plan.claimableAt },
      },
    );
  }
  if (plan.status !== STATUS.CLAIMABLE && plan.status !== STATUS.CLAIMING) {
    throw new InstallmentError(`Plan is not claimable (${plan.status})`, {
      status: 409,
      code: "NOT_CLAIMABLE",
    });
  }

  const beneficiary = await bc.getBeneficiaryAddress(coreId);
  if (!beneficiary) {
    throw new InstallmentError(
      "On-chain wallet address not found for this account",
      { status: 409, code: "WALLET_NOT_FOUND" },
    );
  }

  // Fee protokol didebit dari wallet IDR — cek saldo DULU supaya release
  // on-chain tidak tereksekusi lalu gagal debit.
  const protocolFee = calc.big(plan.protocolFeeIdr ?? 0);
  const feeDue =
    protocolFee > 0n && plan.protocolFeeStatus !== PROTOCOL_FEE_STATUS.CHARGED;
  if (feeDue) {
    const wallet = await InternalWallet.findOne({ where: { coreId } });
    const balance = calc.big(new Decimal(wallet?.balanceIdr ?? 0).toFixed(0));
    if (balance < protocolFee) {
      throw new InstallmentError(
        `Insufficient IDR balance for claim fee (${fmtIdr(protocolFee)})`,
        {
          status: 402,
          code: "INSUFFICIENT_BALANCE",
          details: {
            balance_idr: balance.toString(),
            required_idr: protocolFee.toString(),
          },
        },
      );
    }
  }

  // Tandai claim in-flight supaya request ulang (double-tap / re-entry
  // dari FE) tidak menembak release tx kedua. CLAIMING = resume path:
  // on-chain check di bawah menentukan release perlu dikirim atau tidak.
  if (plan.status === STATUS.CLAIMABLE) {
    await plan.update({ status: STATUS.CLAIMING });
  }

  // Pastikan alokasi on-chain ada (plan lama / allocate gagal saat aktivasi),
  // lalu release ke beneficiary. Kalau chain sudah CLAIMED tapi DB belum,
  // cukup finalisasi DB (idempotent sync).
  const amountRaw = bc.tokenAmountRaw(plan);
  let releaseTxHash = null;
  try {
    const onchain = await bc.readOnchainPlan(plan);
    if (onchain.status === bc.ONCHAIN_STATUS.VOID) {
      throw new InstallmentError(
        "Plan allocation was already voided on-chain",
        { status: 409, code: "ALLOCATION_VOID" },
      );
    }
    if (onchain.status === bc.ONCHAIN_STATUS.NONE) {
      await bc.allocatePlanOnChain(plan, beneficiary);
    }
    if (onchain.status !== bc.ONCHAIN_STATUS.CLAIMED) {
      releaseTxHash = await bc.releaseClaimOnChain(plan);
    }
  } catch (error) {
    // Release gagal -> buka lagi gate claim supaya user bisa retry.
    await plan.update({ status: STATUS.CLAIMABLE }).catch(() => {});
    if (error instanceof InstallmentError) throw error;
    throw new InstallmentError(
      "Asset release failed on-chain. Please try again.",
      {
        status: 502,
        code: "CHAIN_RELEASE_FAILED",
        details: { error: error.message },
      },
    );
  }

  const out = await withTransaction(transaction, async (t) => {
    const locked = await lockPlan(planId, coreId, t);
    if (locked.status === STATUS.CLOSED) {
      return { plan: locked, duplicate: true };
    }
    if (
      locked.status !== STATUS.CLAIMABLE &&
      locked.status !== STATUS.CLAIMING
    ) {
      throw new InstallmentError(`Plan is not claimable (${locked.status})`, {
        status: 409,
        code: "NOT_CLAIMABLE",
      });
    }

    if (feeDue) {
      const debit = await ledger.debitWallet(
        {
          coreId,
          amount: protocolFee,
          reference: `INSTALLMENT-CLAIM-FEE-${plan.id}`,
          description: `Protocol fee claim Gold Installment ${plan.assetCode}`,
          metadata: { planId: plan.id, protocol_fee_bps: plan.protocolFeeBps },
        },
        t,
      );
      await ledger.recordRevenue(
        locked,
        {
          revId: REV_ID.PROTOCOL_FEE,
          amount: protocolFee,
          rateBps: plan.protocolFeeBps,
          base: calc.big(plan.assetValueIdr ?? 0),
          effectiveAt: now,
          sourceTransactionId: debit.id,
          metadata: { trigger: "CLAIM" },
        },
        t,
      );
      await ledger.recordEvent(
        locked,
        {
          eventType: EVENT.PROTOCOL_FEE_CHARGED,
          effectiveAt: now,
          metadata: {
            protocol_fee_idr: protocolFee,
            transaction_id: debit.id,
          },
        },
        t,
      );
    }

    locked.set({
      status: STATUS.CLOSED,
      closedAt: now,
      releaseTxHash: releaseTxHash ?? locked.releaseTxHash,
      protocolFeeStatus: PROTOCOL_FEE_STATUS.CHARGED,
      nextEventAt: null,
    });
    await locked.save({ transaction: t });

    await ledger.recordEvent(
      locked,
      {
        eventType: EVENT.ASSET_RELEASED,
        effectiveAt: now,
        metadata: {
          tx_hash: releaseTxHash,
          beneficiary,
          asset: plan.assetCode,
          amount_token: String(plan.goldAmount),
          amount_raw: amountRaw,
        },
      },
      t,
    );

    return { plan: locked, duplicate: false };
  });

  if (!transaction && !out.duplicate) {
    await sendInstallmentPush(coreId, {
      title: "Asset Claimed",
      body: `Your ${fmtToken(plan.goldAmount)} ${tokenUnit(plan.assetCode)} has been released to your wallet.`,
      data: {
        type: "installment",
        event: "asset_released",
        plan_id: String(plan.id),
      },
    });
  }

  return {
    plan: out.plan,
    txHash: releaseTxHash,
    beneficiary,
    duplicate: out.duplicate,
  };
}

// ============================================================
// Scheduler entry point
// ============================================================

/**
 * Settle satu plan sampai `now` dalam transaction/savepoint tersendiri.
 * Dipanggil scheduler, read-side, dan SEBELUM setiap aksi user supaya
 * transisi waktu tetap durable walaupun aksinya ditolak.
 */
async function settlePlan(planId, now = new Date(), transaction) {
  let sRef = null;
  const plan = await withTransaction(transaction, async (t) => {
    const plan = await InstallmentPlan.findByPk(planId, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!plan || TERMINAL_STATUSES.includes(plan.status)) return plan;

    const s = engine.loadState(plan);
    sRef = s;
    const schedules = await engine.loadSchedules(plan, t);
    await engine.settleToNow(plan, s, schedules, now, t);
    await engine.persist(plan, s, schedules, now, t);
    return plan;
  });
  if (!transaction && plan && sRef) {
    await dispatchPushes(plan, sRef);
    await dispatchChainOps(plan, sRef);
  }
  return plan;
}

// ============================================================
// Read side
// ============================================================

function serializeSchedule(item) {
  return toJsonSafe({
    sequence: item.sequence,
    due_at: item.dueAt,
    amount_idr: item.amountIdr,
    paid_idr: item.paidIdr,
    remaining_idr: calc.big(item.amountIdr) - calc.big(item.paidIdr),
    late_penalty_charged_idr: item.latePenaltyChargedIdr,
    status: item.status,
    paid_at: item.paidAt,
  });
}

function serializePayment(p) {
  return toJsonSafe({
    id: p.id,
    kind: p.kind,
    requested_amount_idr: p.requestedAmountIdr,
    amount_idr: p.amountIdr,
    effective_at: p.effectiveAt,
    allocation: p.allocation,
    status_before: p.statusBefore,
    status_after: p.statusAfter,
    reference: p.reference,
    created_at: p.createdAt,
  });
}

function serializeEvent(e) {
  return toJsonSafe({
    id: e.id,
    event_type: e.eventType,
    effective_at: e.effectiveAt,
    rev_id: e.revId,
    revenue_event_id: e.revenueEventId,
    amount_idr: e.amountIdr,
    rate_bps: e.rateBps,
    calculation_base_idr: e.calculationBaseIdr,
    metadata: e.metadata,
  });
}

/**
 * Serialisasi plan untuk UI. `at` dipakai untuk eligibility flags;
 * nilai finansial adalah nilai tersimpan (sudah settled sampai settled_through_at).
 */
/** Info cicilan overdue dari daftar schedule (untuk serializePlan). */
function overdueInfoFromSchedules(schedules, now) {
  let count = 0;
  let amount = 0n;
  let oldest = null;
  for (const item of schedules ?? []) {
    if (item.status === "PAID") continue;
    const due = cal.toDate(item.dueAt);
    if (due > now) continue;
    count += 1;
    amount += calc.big(item.amountIdr) - calc.big(item.paidIdr ?? 0);
    if (!oldest || due < oldest) oldest = due;
  }
  return { count, amountIdr: amount.toString(), oldestDueAt: oldest };
}

function serializePlan(
  plan,
  {
    schedules = null,
    payments = null,
    events = null,
    at = new Date(),
    overdue = null,
  } = {},
) {
  const s = engine.loadState(plan);
  const flex = engine.isFlexible(plan);

  return toJsonSafe({
    id: plan.id,
    core_id: plan.coreId,
    plan_type: plan.planType,
    asset: plan.assetCode,
    gold_amount: plan.goldAmount,
    locked_price_idr: plan.lockedPriceIdr,
    price_source: plan.priceSource,
    asset_value_idr: plan.assetValueIdr,
    tenor_months: plan.tenorMonths,
    status: plan.status,
    rules_version: plan.rulesVersion,
    is_test: plan.isTest,

    standard: flex
      ? null
      : {
          installment_gap: plan.installmentGap,
          markup_bps: plan.markupBps,
          schedule_count: plan.scheduleCount,
          total_payment_idr: plan.standardTotalPaymentIdr,
          eligible_paid_idr: s.sepa,
          late_penalty_idr: s.lp,
          late_penalty_paid_idr: s.lpPaid,
        },

    flexible: flex
      ? {
          price_lock_margin_bps: plan.priceLockMarginBps,
          locked_plan_value_idr: plan.lockedPlanValueIdr,
          dp_bps: plan.dpBps,
          eligible_plan_payment_idr: s.epp,
          accrued_carrying_idr: s.ac,
          carrying_paid_idr: s.acPaid,
          next_carrying_at: plan.nextCarryingAt,
        }
      : null,

    balances: {
      initial_payment_idr: plan.initialPaymentIdr,
      principal_outstanding_idr: s.po,
      past_due_penalty_idr: s.pdp,
      past_due_penalty_paid_idr: s.pdpPaid,
      restructure_fee_idr: s.rf,
      restructure_fee_paid_idr: s.rfPaid,
      total_obligation_idr: engine.totalObligation(s),
      gross_cash_paid_idr: s.gross,
      payment_completion_bps: engine.completionBps(plan, s),
      actual_cost_idr: s.actualCost,
    },

    settlement: {
      cancellation_rate_bps: plan.cancellationRateBps,
      cancellation_compensation_idr: plan.cancellationCompensationIdr,
      alc_rate_bps: plan.alcRateBps,
      alc_amount_idr: plan.alcAmountIdr,
      raw_refund_idr: plan.rawRefundIdr,
      final_refund_idr: plan.finalRefundIdr,
    },

    claim: {
      protocol_fee_bps: plan.protocolFeeBps,
      protocol_fee_idr: plan.protocolFeeIdr,
      protocol_fee_status: plan.protocolFeeStatus,
      claim_network_fee_idr: plan.claimNetworkFeeIdr,
      release_tx_hash: plan.releaseTxHash,
    },

    timeline: {
      request_created_at: plan.requestCreatedAt,
      request_expires_at: plan.requestExpiresAt,
      activated_at: plan.activatedAt,
      maturity_at: plan.maturityAt,
      cancellation_closed_at: plan.cancellationClosedAt,
      past_due_at: plan.pastDueAt,
      cure_ends_at: plan.cureEndsAt,
      restructure_started_at: plan.restructureStartedAt,
      restructure_maturity_at: plan.restructureMaturityAt,
      restructure_extension_months: plan.restructureExtensionMonths,
      fully_settled_at: plan.fullySettledAt,
      claimable_at: plan.claimableAt,
      closed_at: plan.closedAt,
      next_event_at: plan.nextEventAt,
      settled_through_at: plan.settledThroughAt,
    },

    eligibility: engine.eligibility(plan, s, at),

    overdue:
      overdue ??
      (schedules
        ? overdueInfoFromSchedules(schedules, at)
        : { count: 0, amountIdr: "0", oldestDueAt: null }),

    schedules: schedules ? schedules.map(serializeSchedule) : undefined,
    payments: payments ? payments.map(serializePayment) : undefined,
    events: events ? events.map(serializeEvent) : undefined,

    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
  });
}

async function listPlans({
  coreId,
  status,
  includeTest = false,
  now = new Date(),
}) {
  const where = { coreId };
  if (status) where.status = String(status).toUpperCase();
  if (!includeTest) where.isTest = false;

  const plans = await InstallmentPlan.findAll({
    where,
    order: [["created_at", "DESC"]],
  });

  // Settle plan yang punya event terlewat agar angka yang ditampilkan up-to-date
  const stale = plans.filter(
    (p) =>
      p.nextEventAt &&
      new Date(p.nextEventAt) <= now &&
      !TERMINAL_STATUSES.includes(p.status),
  );
  for (const p of stale) {
    try {
      await settlePlan(p.id, now);
    } catch (error) {
      console.error(`[Installment] settlePlan ${p.id} gagal:`, error.message);
    }
  }

  const fresh = stale.length
    ? await InstallmentPlan.findAll({ where, order: [["created_at", "DESC"]] })
    : plans;

  // Info overdue per plan (sekali query, group di JS) — untuk badge list.
  const { Op } = require("sequelize");
  const stdIds = fresh.filter((p) => !engine.isFlexible(p)).map((p) => p.id);
  const overdueByPlan = new Map();
  if (stdIds.length) {
    const rows = await InstallmentSchedule.findAll({
      where: {
        planId: { [Op.in]: stdIds },
        status: { [Op.ne]: "PAID" },
        dueAt: { [Op.lte]: now },
      },
      raw: true,
    });
    for (const r of rows) {
      const cur = overdueByPlan.get(r.planId) ?? {
        count: 0,
        amount: 0n,
        oldest: null,
      };
      cur.count += 1;
      cur.amount += calc.big(r.amountIdr) - calc.big(r.paidIdr ?? 0);
      const due = new Date(r.dueAt);
      if (!cur.oldest || due < cur.oldest) cur.oldest = due;
      overdueByPlan.set(r.planId, cur);
    }
  }

  return fresh.map((p) => {
    const o = overdueByPlan.get(p.id);
    return serializePlan(p, {
      at: now,
      overdue: o
        ? {
            count: o.count,
            amountIdr: o.amount.toString(),
            oldestDueAt: o.oldest,
          }
        : null,
    });
  });
}

async function getPlanDetail({ coreId, planId, now = new Date() }) {
  let plan = await InstallmentPlan.findOne({ where: { id: planId, coreId } });
  if (!plan) {
    throw new InstallmentError("Plan not found", {
      status: 404,
      code: "PLAN_NOT_FOUND",
    });
  }

  if (
    plan.nextEventAt &&
    new Date(plan.nextEventAt) <= now &&
    !TERMINAL_STATUSES.includes(plan.status)
  ) {
    plan = await settlePlan(plan.id, now);
  }

  const [schedules, payments, events] = await Promise.all([
    engine.isFlexible(plan)
      ? []
      : InstallmentSchedule.findAll({
          where: { planId },
          order: [["sequence", "ASC"]],
        }),
    InstallmentPayment.findAll({
      where: { planId },
      order: [["effective_at", "ASC"]],
    }),
    InstallmentEvent.findAll({
      where: { planId },
      order: [
        ["effective_at", "ASC"],
        ["created_at", "ASC"],
      ],
    }),
  ]);

  return serializePlan(plan, { schedules, payments, events, at: now });
}

module.exports = {
  quote,
  createRequest,
  pay,
  cancel,
  restructure,
  claim,
  settlePlan,
  listPlans,
  getPlanDetail,
  serializePlan,
};
