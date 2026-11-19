/*
 * Loan V1 service — orkestrasi operasi user (brief 05-09) di atas engine.
 *
 * Pola: setiap operasi = settlePosition dulu (interest/PDP/risk sampai
 * waktu efektif), lalu operasi dalam transaction dengan row lock, lalu
 * side effect (chain op, push) SETELAH commit.
 */

const crypto = require("crypto");
const { Op } = require("sequelize");
const {
  sequelize,
  LoanPosition,
  LoanDrawdown,
  LoanRepayment,
  LoanCollateralRelease,
  LoanInterestEvent,
  LoanLiquidation,
  LoanEvent,
  KycProfile,
} = require("../../models");
const calc = require("./loan.calc");
const cal = require("./loan.calendar");
const engine = require("./loan.engine");
const ledger = require("./loan.ledger");
const pool = require("./loan.pool");
const pricing = require("./loan.pricing");
const bc = require("./loan.blockchain.service");
const liquidation = require("./loan.liquidation");
const v = require("./loan.validation");
const { getActivePolicy } = require("./loan.policy");
const { LoanError, toJsonSafe } = require("./loan.errors");
const pushService = require("../pushService");
const {
  RULES_VERSION,
  ASSET,
  TENOR_DAYS,
  STATUS,
  OPEN_STATUSES,
  TERMINAL_STATUSES,
  EVENT,
  REV_ID,
  RELEASE_STATUS,
  SETTLEMENT_STATUS,
} = require("./loan.constants");

const { dec, ZERO, clamp0, minDec } = calc;

const REQUIRE_KYC = String(process.env.LOAN_REQUIRE_KYC ?? "1") !== "0";

// ============================================================
// Helpers
// ============================================================

const withTransaction = (transaction, fn) =>
  transaction
    ? sequelize.transaction({ transaction }, fn)
    : sequelize.transaction(fn);

async function lockPosition(positionId, coreId, t) {
  const where = { id: positionId };
  if (coreId) where.coreId = coreId;
  const p = await LoanPosition.findOne({
    where,
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!p)
    throw new LoanError("Loan position not found", {
      status: 404,
      code: "POSITION_NOT_FOUND",
    });
  return p;
}

async function requireKyc(coreId) {
  if (!REQUIRE_KYC) return;
  const kyc = await KycProfile.findOne({ where: { core_id: coreId } });
  if (!kyc || String(kyc.status).toUpperCase() !== "VERIFIED") {
    throw new LoanError("KYC verification is required before using Loan", {
      status: 403,
      code: "KYC_REQUIRED",
    });
  }
}

async function dispatchPushes(coreId, pushes) {
  for (const push of pushes || []) {
    try {
      await pushService.sendPushToUser(coreId, push);
    } catch (error) {
      console.log(`[Loan] push gagal ${coreId}:`, error.message);
    }
  }
}

async function afterCommit(p, s, now) {
  await dispatchPushes(p.coreId, s?.pushes);
  for (const op of s?.chainOps || []) {
    try {
      if (op.type === "LIQUIDATE") await liquidation.processPending(p.id, now);
      if (op.type === "RELEASE") await executeRelease(op.releaseId, now);
    } catch (error) {
      console.error(
        `[Loan Chain] ${op.type} posisi ${p.id} gagal:`,
        error.message,
      );
    }
  }
}

/**
 * Settle + risk evaluation posisi sampai `now` (dipakai scheduler & sebelum
 * setiap operasi user). Return status terbaru.
 */
async function settlePosition(
  positionId,
  now,
  { transaction, priceCache } = {},
) {
  const policy = await getActivePolicy(now, { transaction });
  let sRef = null;
  let pRef = null;
  await withTransaction(transaction, async (t) => {
    const p = await lockPosition(positionId, null, t);
    if (!engine.isOpen(p)) return;
    const s = engine.loadState(p);
    await engine.settleToNow(p, s, now, policy, t);
    const price =
      priceCache?.[p.collateralAsset] ||
      (await pricing.getValidatedPrice(p.collateralAsset, now, {
        policy,
        transaction: t,
      }));
    await engine.evaluateRisk(p, s, price, now, policy, t);
    engine.flushState(p, s);
    p.set({
      settledThroughAt: now,
      nextEventAt: engine.computeNextEventAt(p, s, now, policy),
    });
    await p.save({ transaction: t });
    sRef = s;
    pRef = p;
  });
  if (!transaction && pRef) {
    await afterCommit(pRef, sRef, now);
    // Retry release yang tertunda (tx gagal sebelumnya) tanpa double gas
    const pending = await LoanCollateralRelease.findAll({
      where: {
        positionId,
        state: [RELEASE_STATUS.PENDING, RELEASE_STATUS.FAILED],
      },
    });
    for (const r of pending) await executeRelease(r.id, now).catch(() => {});
  }
  return pRef;
}

// ============================================================
// Config
// ============================================================

async function config(now) {
  const policy = await getActivePolicy(now);
  return toJsonSafe({
    rules_version: RULES_VERSION,
    policy_version: policy.version,
    tenor_days: TENOR_DAYS,
    apr_bps: policy.aprBps,
    risk: policy.risk,
    rules: policy.rules,
    chain_mode: bc.MODE,
  });
}

// ============================================================
// 05 Quote & Open
// ============================================================

function parseOpenInput(body) {
  return {
    asset: v.normalizeAsset(body.collateral_asset),
    qty: v.parseQty(body.collateral_qty),
    tenorDays: v.parseTenor(body.tenor_days),
    grossIdr:
      body.gross_loan_idr !== undefined
        ? v.parseIdr(body.gross_loan_idr, "gross_loan_idr")
        : null,
  };
}

/**
 * Quote pembukaan (D.1). gross_loan_idr opsional: bila kosong, quote
 * menampilkan maksimum yang bisa dipinjam dari MIN(semua limit).
 */
async function quoteOpen({ coreId, body, now }) {
  const input = parseOpenInput(body);
  const policy = await getActivePolicy(now);
  const risk = calc.riskParams(input.asset, policy);
  const price = pricing.requireBorrowingPrice(
    await pricing.getValidatedPrice(input.asset, now, { policy }),
  );
  const poolRow = await pool.getPool();
  const pm = pool.metrics(poolRow, policy);

  const cycle = coreId
    ? await require("../../models").LoanBorrowerCycle.findOne({
        where: { coreId, status: "OPEN" },
      })
    : null;
  const borrowerCapIdr = cycle
    ? dec(cycle.borrowerCapIdr)
    : calc.borrowerCap(
        pm.eligible_lending_capital_idr,
        policy.rules.BORROWER_CAP_BPS,
        policy.rules.BORROWER_CAP_MAX_IDR,
      );
  const aggregatePo = coreId ? await pool.aggregatePrincipal(coreId) : ZERO;

  const cap = calc.availableCapacity({
    initialLtvBps: risk.initialLtvBps,
    lockedQty: input.qty,
    eligiblePrice: price.eligiblePriceIdr,
    tdd: 0,
    borrowerCapIdr,
    aggregatePoIdr: aggregatePo,
    utilizationHeadroomIdr: pm.utilization_headroom_idr,
    availableCashIdr: pm.free_cash_idr,
  });

  const gross = input.grossIdr ?? cap.available;
  const d = calc.disbursement(gross, policy.rules.PROTOCOL_FEE_BPS);
  const apr = calc.aprBps(input.asset, input.tenorDays, policy);
  const collValue = calc.collateralValue(input.qty, price.priceIdr);
  const ltv = calc.ltvBps(gross, collValue);
  const hf = calc.healthFactor(collValue, risk.liquidationBps, gross);
  const maturityAt = cal.addDays(now, input.tenorDays);

  const violations = [];
  if (gross.lt(policy.rules.MIN_INITIAL_GROSS_IDR))
    violations.push("BELOW_MINIMUM_GROSS");
  if (ltv != null && ltv < (risk.minInitialLtvBps ?? 0)) {
    if (policy.rules.MIN_INITIAL_LTV_ENABLED !== false)
      violations.push("PAWN_INITIAL_LTV_BELOW_MIN");
  }
  if (ltv != null && ltv > risk.initialLtvBps)
    violations.push("PAWN_INITIAL_LTV_ABOVE_MAX");
  if (gross.gt(cap.ltvCap)) violations.push("EXCEEDS_LTV_CAPACITY");
  if (gross.gt(cap.customerCap)) violations.push("EXCEEDS_BORROWER_CAP");
  if (gross.gt(cap.poolCap)) violations.push("EXCEEDS_POOL_CAPACITY");
  if (pm.lending_paused) violations.push("LENDING_PAUSED");

  return toJsonSafe({
    request_id: crypto.randomUUID(),
    customer_id: coreId || null,
    collateral_asset: input.asset,
    collateral_qty: input.qty,
    tenor_days: input.tenorDays,
    gross_loan_idr: gross,
    protocol_fee_idr: d.fee,
    protocol_fee_bps: policy.rules.PROTOCOL_FEE_BPS,
    net_disbursement_idr: d.net,
    canonical_principal_idr: d.principal,
    apr_snapshot_bps: apr,
    maturity_at: maturityAt,
    first_anniversary_at: cal.anniversaryAt(now, 1),
    locked_qty_raw: calc.tokenRaw(input.qty, policy.rules.TOKEN_DECIMALS),
    validated_price_idr: price.priceIdr,
    borrowing_eligible_price_idr: price.eligiblePriceIdr,
    price_status: price.status,
    source_price_timestamp: price.observedAt,
    collateral_value_idr: collValue,
    ltv_current_bps: ltv,
    hf_scaled: hf,
    initial_ltv_bps: risk.initialLtvBps,
    min_initial_ltv_bps: risk.minInitialLtvBps ?? null,
    min_ltv_enabled: policy.rules.MIN_INITIAL_LTV_ENABLED !== false,
    margin_call_bps: risk.marginCallBps,
    liquidation_threshold_bps: risk.liquidationBps,
    emergency_threshold_bps: risk.emergencyBps,
    post_release_ltv_max_bps: risk.postReleaseMaxBps,
    max_gross_by_ltv_idr: cap.ltvCap,
    borrower_cap_idr: borrowerCapIdr,
    borrower_cap_remaining_idr: cap.customerCap,
    pool_utilization_headroom_idr: pm.utilization_headroom_idr,
    available_cash_idr: pm.free_cash_idr,
    max_gross_available_idr: cap.available,
    min_gross_idr: policy.rules.MIN_INITIAL_GROSS_IDR,
    violations,
    quote_expires_at: cal.addSeconds(now, policy.rules.QUOTE_TTL_SECONDS),
    config_version: policy.version,
  });
}

async function findExisting(Model, idempotencyKey, coreId, t) {
  const existing = await Model.findOne({
    where: { idempotencyKey },
    transaction: t,
  });
  if (existing && coreId && existing.coreId !== coreId) {
    throw new LoanError("idempotency_key already used", {
      status: 409,
      code: "IDEMPOTENCY_CONFLICT",
    });
  }
  return existing;
}

/**
 * Open position: validate -> reserve (PENDING_COLLATERAL) -> chain lock ->
 * activate (disburse IDR net, fee, ACTIVE, maturity clock).
 */
async function openPosition({ coreId, body, now, isTest = false }) {
  const idempotencyKey = v.requireIdempotencyKey(body.idempotency_key);
  const input = parseOpenInput(body);
  if (!input.grossIdr) {
    throw new LoanError("gross_loan_idr is required", {
      code: "INVALID_AMOUNT",
    });
  }
  await requireKyc(coreId);
  const policy = await getActivePolicy(now);
  const risk = calc.riskParams(input.asset, policy);
  const apr = calc.aprBps(input.asset, input.tenorDays, policy);
  const price = pricing.requireBorrowingPrice(
    await pricing.getValidatedPrice(input.asset, now, { policy }),
  );
  const ownerAddress = await bc.getBeneficiaryAddress(coreId);
  if (!ownerAddress && bc.MODE === "live") {
    throw new LoanError("On-chain wallet not found", {
      status: 409,
      code: "WALLET_NOT_FOUND",
    });
  }

  let created = false;
  let position;
  let drawdown;
  try {
    position = await sequelize.transaction(async (t) => {
      const existing = await findExisting(
        LoanPosition,
        idempotencyKey,
        coreId,
        t,
      );
      if (existing) return existing;

      const count = await pool.countActivePositions(coreId, { transaction: t });
      if (count >= policy.rules.MAX_ACTIVE_POSITIONS) {
        throw new LoanError(
          `Maximum ${policy.rules.MAX_ACTIVE_POSITIONS} active loan positions`,
          {
            status: 409,
            code: "MAX_POSITIONS",
          },
        );
      }
      const gross = input.grossIdr;
      if (gross.lt(policy.rules.MIN_INITIAL_GROSS_IDR)) {
        throw new LoanError(
          `Minimum initial gross loan is ${policy.rules.MIN_INITIAL_GROSS_IDR} IDR`,
          {
            code: "BELOW_MINIMUM_GROSS",
          },
        );
      }
      const poolRow = await pool.getPool({ transaction: t, lock: true });
      const pm = pool.assertPoolCanLend(poolRow, policy, gross);
      const { cycle } = await pool.getOrOpenCycle(coreId, poolRow, policy, {
        now,
        transaction: t,
      });
      const ch = await pool.customerHeadroom(coreId, cycle, { transaction: t });
      const cap = calc.availableCapacity({
        initialLtvBps: risk.initialLtvBps,
        lockedQty: input.qty,
        eligiblePrice: price.eligiblePriceIdr,
        tdd: 0,
        borrowerCapIdr: ch.cap,
        aggregatePoIdr: ch.aggregatePo,
        utilizationHeadroomIdr: pm.utilization_headroom_idr,
        availableCashIdr: pm.free_cash_idr,
      });
      if (gross.gt(cap.ltvCap)) {
        throw new LoanError("Gross loan exceeds initial LTV capacity", {
          status: 409,
          code: "EXCEEDS_LTV_CAPACITY",
          details: { max_gross_by_ltv_idr: cap.ltvCap.toFixed(0) },
        });
      }
      // Temporary minimum initial-LTV floor (origination only). Initial LTV
      // = gross / (qty x validated price). Checked inside the txn, before
      // collateral lock / position creation.
      const collValue = calc.collateralValue(input.qty, price.priceIdr);
      const ltvBps = calc.ltvBps(gross, collValue);
      if (
        policy.rules.MIN_INITIAL_LTV_ENABLED !== false &&
        risk.minInitialLtvBps != null &&
        ltvBps != null &&
        ltvBps < risk.minInitialLtvBps
      ) {
        throw new LoanError(
          `Initial LTV ${(ltvBps / 100).toFixed(2)}% below minimum ${(risk.minInitialLtvBps / 100).toFixed(2)}% for ${input.asset}`,
          {
            status: 409,
            code: "PAWN_INITIAL_LTV_BELOW_MIN",
            details: {
              ltv_bps: ltvBps,
              min_initial_ltv_bps: risk.minInitialLtvBps,
            },
          },
        );
      }
      if (ltvBps != null && ltvBps > risk.initialLtvBps) {
        throw new LoanError(
          `Initial LTV ${(ltvBps / 100).toFixed(2)}% above maximum ${(risk.initialLtvBps / 100).toFixed(2)}% for ${input.asset}`,
          {
            status: 409,
            code: "PAWN_INITIAL_LTV_ABOVE_MAX",
            details: {
              ltv_bps: ltvBps,
              max_initial_ltv_bps: risk.initialLtvBps,
            },
          },
        );
      }
      if (gross.gt(cap.customerCap)) {
        throw new LoanError("Loan amount exceeds your borrower cap.",
          {
            status: 409,
            code: "EXCEEDS_BORROWER_CAP",
            details: {
              borrower_cap_idr: ch.cap.toFixed(0),
              remaining_idr: cap.customerCap.toFixed(0),
            },
          },
        );
      }

      const d = calc.disbursement(gross, policy.rules.PROTOCOL_FEE_BPS);
      const p = await LoanPosition.create(
        {
          coreId,
          collateralAsset: input.asset,
          tokenDecimals: policy.rules.TOKEN_DECIMALS,
          lockedQty: 0,
          originalQty: input.qty.toFixed(18),
          aprBps: apr,
          tenorDays: input.tenorDays,
          initialLtvBps: risk.initialLtvBps,
          status: STATUS.PENDING_COLLATERAL,
          borrowerCycleId: cycle.id,
          poolSnapshotId: cycle.poolSnapshotId,
          ownerAddress,
          idempotencyKey,
          policyVersionId: policy.id,
          rulesVersion: RULES_VERSION,
          isTest,
          openingSnapshot: toJsonSafe({
            gross_idr: gross,
            fee_idr: d.fee,
            net_idr: d.net,
            price_idr: price.priceIdr,
            eligible_price_idr: price.eligiblePriceIdr,
            price_source: price.source,
            price_observed_at: price.observedAt,
            ltv_bps: calc.ltvBps(
              gross,
              calc.collateralValue(input.qty, price.priceIdr),
            ),
            min_initial_ltv_bps: risk.minInitialLtvBps ?? null,
            max_initial_ltv_bps: risk.initialLtvBps,
            capacity: cap,
            policy_version: policy.version,
            effective_at: now,
          }),
        },
        { transaction: t },
      );
      p.set({ onchainPositionId: bc.positionIdBytes32(p.id) });
      await p.save({ transaction: t });
      drawdown = await LoanDrawdown.create(
        {
          positionId: p.id,
          coreId,
          kind: "INITIAL",
          grossIdr: gross.toFixed(18),
          protocolFeeIdr: d.fee.toFixed(18),
          paidIdr: d.net.toFixed(18),
          status: "PENDING",
          priceSnapshotIdr: price.priceIdr.toFixed(18),
          eligiblePriceIdr: price.eligiblePriceIdr.toFixed(18),
          configVersion: policy.version,
          idempotencyKey: `${idempotencyKey}:initial`,
          effectiveAt: now,
        },
        { transaction: t },
      );
      await ledger.recordEvent(
        p,
        {
          eventType: EVENT.POSITION_CREATED,
          effectiveAt: now,
          metadata: { gross_idr: gross, qty: input.qty },
        },
        t,
      );
      created = true;
      return p;
    });
  } catch (error) {
    if (error?.name === "SequelizeUniqueConstraintError") {
      const winner = await findExisting(LoanPosition, idempotencyKey, coreId);
      if (winner) return { position: winner, created: false };
    }
    throw error;
  }
  if (!created) return { position, created: false };

  let activated;
  try {
    activated = await withTimeout(
      completePendingCollateral(position.id, {
        now,
        qty: input.qty,
        apr,
        policy,
        cancelOnLockError: false,
      }),
      OPEN_CHAIN_BUDGET_MS,
      "openPosition collateral lock",
    );
  } catch (e) {
    // Chain op tidak instant-cancel di request path — revert transient
    // (mis. RPC node belum sync approve UserOp) sembuh di tick reconcile
    // berikutnya; failure definitif auto-cancel setelah retry budget.
    // Posisi tetap PENDING_COLLATERAL; app dapat status pending daripada
    // posisi langsung CANCELLED karena race sesaat.
    console.error(
      `[LOAN] collateral lock pending di request (reconcile mengambil alih): ${e.message}`,
    );
    return {
      position: await LoanPosition.findByPk(position.id),
      created: true,
    };
  }
  return { position: activated, created: true };
}

/**
 * Cleanup posisi yang gagal sebelum aktivasi: CANCELLED + drawdown FAILED +
 * DISBURSEMENT_FAILED event + tutup cycle bila idle. Dipakai openPosition
 * dan reconciler.
 */
async function cancelPendingCollateral(position, { now, reason }) {
  await sequelize.transaction(async (t) => {
    const p = await lockPosition(position.id, position.coreId, t);
    if (p.status !== STATUS.PENDING_COLLATERAL) return;
    p.set({ status: STATUS.CANCELLED, closedAt: now });
    await p.save({ transaction: t });
    await LoanDrawdown.update(
      { status: "FAILED" },
      { where: { positionId: p.id }, transaction: t },
    );
    await ledger.recordEvent(
      p,
      {
        eventType: EVENT.DISBURSEMENT_FAILED,
        effectiveAt: now,
        metadata: { reason },
      },
      t,
    );
    await pool.closeCycleIfIdle(p.coreId, { now, transaction: t });
  });
}

/**
 * Fase setelah reserve (PENDING_COLLATERAL): lock collateral on-chain
 * lalu aktivasi + disburse. Dipanggil dua jalan:
 *  - fast path: openPosition tepat setelah create (fail -> cancel langsung)
 *  - heal path: scheduler reconcilePendingCollateral (fail -> retry,
 *    cancel hanya setelah budget habis)
 * Idempotent: cek on-chain getPosition dulu — kalau lock sudah landing tapi
 * request mati sebelum simpan lock_tx_hash, lanjut aktivasi tanpa kirim
 * lock tx kedua. Activation sendiri satu DB transaction (atomic).
 */
async function completePendingCollateral(
  positionId,
  { now, qty, apr, policy, cancelOnLockError = true },
) {
  const p0 = await LoanPosition.findByPk(positionId);
  if (!p0 || p0.status !== STATUS.PENDING_COLLATERAL) return p0;
  const coreId = p0.coreId;
  qty = qty || dec(p0.originalQty);
  apr = apr ?? p0.aprBps;
  policy = policy || (await getActivePolicy(now));

  const expectedRaw = qty.mul(10 ** p0.tokenDecimals).toFixed(0);
  const onchain = await bc.readOnchainPosition(p0).catch(() => null);
  const alreadyLocked =
    onchain?.locked != null &&
    BigInt(expectedRaw) > 0n &&
    BigInt(onchain.locked) >= BigInt(expectedRaw);

  let lockTx;
  let onchainConfirmed = false;
  if (alreadyLocked) {
    lockTx = p0.lockTxHash || "onchain:confirmed";
    onchainConfirmed = true;
  } else {
    try {
      lockTx = await bc.lockCollateral(p0, p0.ownerAddress || "0x0", qty);
    } catch (error) {
      // On-chain revert/stall adalah operational signal, bukan client
      // error — log selalu supaya muncul di Vercel (LoanError sendiri
      // sengaja tidak di-log oleh handleError).
      console.error(
        `[LOAN] collateral lock gagal posisi ${positionId}:`,
        error.message,
      );
      if (cancelOnLockError) {
        await cancelPendingCollateral(p0, {
          now,
          reason: `collateral lock failed: ${error.message}`,
        });
        throw new LoanError(`Collateral lock failed: ${error.message}`, {
          status: 502,
          code: "COLLATERAL_LOCK_FAILED",
        });
      }
      throw error;
    }
  }

  const s = { pushes: [], chainOps: [] };
  const activated = await sequelize.transaction(async (t) => {
    const p = await lockPosition(positionId, coreId, t);
    if (p.status !== STATUS.PENDING_COLLATERAL) return p;
    const poolRow = await pool.getPool({ transaction: t, lock: true });
    const dd = await LoanDrawdown.findOne({
      where: { positionId: p.id, kind: "INITIAL", status: "PENDING" },
      order: [["created_at", "ASC"]],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!dd) return p;
    const gross = dec(dd.grossIdr);
    const fee = dec(dd.protocolFeeIdr);
    const net = dec(dd.paidIdr);

    p.set({
      lockedQty: qty.toFixed(18),
      lockTxHash: lockTx,
      status: STATUS.PENDING_DISBURSEMENT,
    });
    await ledger.recordEvent(
      p,
      {
        eventType: EVENT.COLLATERAL_LOCKED,
        effectiveAt: now,
        amountQty: qty,
        metadata: { tx_hash: lockTx, onchain_confirmed: onchainConfirmed },
      },
      t,
    );

    // PG disbursement = kredit internal wallet (net = gross - fee)
    const credit = await ledger.creditWallet(
      {
        coreId,
        amount: net,
        reference: `LOAN-DISB-${dd.id}`,
        description: `Loan disbursement (gross ${engine.fmtIdr(gross)}, protocol fee ${engine.fmtIdr(fee)})`,
        metadata: { position_id: p.id, drawdown_id: dd.id },
      },
      t,
    );
    const feeEv = await ledger.recordRevenue(
      p,
      {
        revId: REV_ID.PROTOCOL,
        amountIdr: fee,
        rateBps: policy.rules.PROTOCOL_FEE_BPS,
        baseIdr: gross,
        sourceTxId: dd.id,
        effectiveAt: now,
        metadata: { kind: "INITIAL" },
      },
      t,
    );
    await dd.update(
      {
        status: "CONFIRMED",
        pgReference: String(credit?.tx?.id || ""),
        feeEventId: feeEv.id,
      },
      { transaction: t },
    );
    await pool.applyDisbursement(poolRow, gross, net, { transaction: t });
    await pool.snapshot(poolRow, "DISBURSEMENT", {
      positionId: p.id,
      now,
      transaction: t,
    });

    const maturityAt = cal.addDays(now, p.tenorDays);
    p.set({
      status: STATUS.ACTIVE,
      riskState: STATUS.ACTIVE,
      activatedAt: now,
      maturityAt,
      principalOutstandingIdr: gross.toFixed(18),
      grossDisbursedIdr: gross.toFixed(18),
      netDisbursedIdr: net.toFixed(18),
      protocolFeeIdr: fee.toFixed(18),
      settledThroughAt: now,
      interestAccruedThroughAt: null,
      nextEventAt: cal.minDate(
        cal.anniversaryAt(now, 1),
        cal.addSeconds(now, 60),
      ),
    });
    await p.save({ transaction: t });
    await ledger.recordEvent(
      p,
      {
        eventType: EVENT.DISBURSEMENT_CONFIRMED,
        effectiveAt: now,
        amountIdr: net,
        metadata: {
          gross_idr: gross,
          fee_idr: fee,
          maturity_at: maturityAt,
          apr_bps: apr,
        },
      },
      t,
    );
    s.pushes.push({
      title: "Loan Active",
      body: `${engine.fmtIdr(net)} has been credited to your IDR wallet (gross ${engine.fmtIdr(gross)}, fee ${engine.fmtIdr(fee)}). Matures ${maturityAt.toISOString().slice(0, 10)}.`,
      data: { type: "loan", event: "activated", position_id: String(p.id) },
    });
    return p;
  });
  await afterCommit(activated, s, now);
  return activated;
}

// ============================================================
// 05b Reconcile posisi stuck PENDING_COLLATERAL
// ============================================================
//
// Request bisa mati di tengah chain lock (serverless timeout/kill): posisi
// tinggal PENDING_COLLATERAL, drawdown PENDING, collateral belum ke-lock.
// Scheduler memanggil ini tiap tick untuk posisi yang umurnya > staleMs:
//  - coba completePendingCollateral (idempotent, cek on-chain dulu)
//  - gagal -> catat attempt; cancel hanya setelah maxAttempts ATAU umur
//    posisi > giveUpMs (bebasin borrower cap/slot).
const PENDING_COLLATERAL_STALE_MS = Number(
  process.env.LOAN_PENDING_COLLATERAL_STALE_MS ?? 5 * 60 * 1000,
);
const PENDING_COLLATERAL_GIVE_UP_MS = Number(
  process.env.LOAN_PENDING_COLLATERAL_GIVE_UP_MS ?? 2 * 60 * 60 * 1000,
);
const PENDING_COLLATERAL_MAX_ATTEMPTS = Number(
  process.env.LOAN_PENDING_COLLATERAL_MAX_ATTEMPTS ?? 5,
);
const RECONCILE_RESUME_TIMEOUT_MS = Number(
  process.env.LOAN_RECONCILE_RESUME_TIMEOUT_MS ?? 150_000,
);
const OPEN_CHAIN_BUDGET_MS = Number(
  process.env.LOAN_OPEN_CHAIN_BUDGET_MS ?? 90_000,
);
const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      ).unref?.(),
    ),
  ]);

async function reconcilePendingCollateral(now, { limit = 5 } = {}) {
  const staleBeforeMs = now.getTime() - PENDING_COLLATERAL_STALE_MS;
  const pending = await LoanPosition.findAll({
    where: { status: STATUS.PENDING_COLLATERAL },
    order: [["created_at", "ASC"]],
    limit: 50,
  });
  const createdAtOf = (p) => p.get("created_at") || p.createdAt;
  const stuck = pending
    .filter((p) => {
      const c = createdAtOf(p);
      return c && new Date(c).getTime() < staleBeforeMs;
    })
    .slice(0, limit);

  let resumed = 0;
  let cancelled = 0;
  for (const row of stuck) {
    try {
      // Bounded: kalau chain op (approve UserOp/lock) stall — mis. bundler
      // degrade — tick tidak keburn habis; operasi tetap jalan di
      // background dan tick berikutnya verifikasi via on-chain read.
      const p = await withTimeout(
        completePendingCollateral(row.id, {
          now,
          cancelOnLockError: false,
        }),
        RECONCILE_RESUME_TIMEOUT_MS,
        `reconcile resume ${row.id}`,
      );
      if (p && p.status === STATUS.ACTIVE) resumed += 1;
    } catch (error) {
      const attempts = await LoanEvent.count({
        where: {
          positionId: row.id,
          eventType: EVENT.DISBURSEMENT_FAILED,
        },
      });
      const ageMs = now.getTime() - new Date(createdAtOf(row)).getTime();
      if (attempts + 1 >= PENDING_COLLATERAL_MAX_ATTEMPTS || ageMs > PENDING_COLLATERAL_GIVE_UP_MS) {
        await cancelPendingCollateral(row, {
          now,
          reason: `collateral lock failed after ${attempts + 1} reconcile attempts: ${error.message}`,
        }).catch(() => {});
        cancelled += 1;
      } else {
        await LoanEvent.create({
          positionId: row.id,
          coreId: row.coreId,
          eventType: EVENT.DISBURSEMENT_FAILED,
          effectiveAt: now,
          metadata: {
            reason: `reconcile attempt failed: ${error.message}`,
            reconcile_attempt: true,
          },
        }).catch(() => {});
      }
      console.error(
        `[LOAN RECONCILE] posisi ${row.id} gagal (attempt ${attempts + 1}):`,
        error.message,
      );
    }
  }
  if (resumed || cancelled) {
    console.log(`[LOAN RECONCILE] resumed=${resumed} cancelled=${cancelled}`);
  }
  return { resumed, cancelled, found: stuck.length };
}

/**
 * Admin/ops repair: posisi sudah ACTIVE/PENDING_DISBURSEMENT tapi lock
 * on-chain belum benar-benar ada (lock_tx_hash kosong / "0xmock…" dari
 * reconcile yang jalan di mode mock). Kirim lock tx beneran lalu update
 * lock_tx_hash. Idempotent: kalau on-chain sudah locked, cuma rekam hash.
 */
async function repairCollateralLock(positionId, { now }) {
  const p0 = await LoanPosition.findByPk(positionId);
  if (!p0) {
    throw new LoanError("Loan position not found", {
      status: 404,
      code: "POSITION_NOT_FOUND",
    });
  }
  if (p0.status !== STATUS.ACTIVE && p0.status !== STATUS.PENDING_DISBURSEMENT) {
    throw new LoanError(`Position ${p0.status} does not need lock repair`, {
      status: 409,
      code: "NO_REPAIR_NEEDED",
    });
  }
  const qty = dec(p0.lockedQty).gt(0) ? dec(p0.lockedQty) : dec(p0.originalQty);
  const expectedRaw = qty.mul(10 ** p0.tokenDecimals).toFixed(0);
  const onchain = await bc.readOnchainPosition(p0);
  if (
    onchain?.locked != null &&
    BigInt(expectedRaw) > 0n &&
    BigInt(onchain.locked) >= BigInt(expectedRaw)
  ) {
    if (p0.lockTxHash && !p0.lockTxHash.startsWith("0xmock")) {
      return { repaired: false, reason: "already_locked_onchain" };
    }
    await p0.update({ lockTxHash: "onchain:confirmed" });
    return { repaired: true, txHash: "onchain:confirmed" };
  }
  const txHash = await bc.lockCollateral(p0, p0.ownerAddress || "0x0", qty);
  await p0.update({ lockTxHash: txHash });
  await ledger.recordEvent(
    p0,
    {
      eventType: EVENT.COLLATERAL_LOCKED,
      effectiveAt: now,
      amountQty: qty,
      metadata: { tx_hash: txHash, repair: true },
    },
  );
  return { repaired: true, txHash };
}

// ============================================================
// 09 Additional drawdown
// ============================================================

async function capacityFor(p, s, price, policy, t) {
  const risk = calc.riskParams(p.collateralAsset, policy);
  const poolRow = await pool.getPool({ transaction: t });
  const pm = pool.metrics(poolRow, policy);
  const cycle = await require("../../models").LoanBorrowerCycle.findByPk(
    p.borrowerCycleId,
    { transaction: t },
  );
  const ch = await pool.customerHeadroom(p.coreId, cycle, { transaction: t });
  const d = engine.dues(s);
  const cap = calc.availableCapacity({
    initialLtvBps: risk.initialLtvBps,
    lockedQty: s.lockedQty,
    eligiblePrice: price.eligiblePriceIdr,
    tdd: d.tdd,
    borrowerCapIdr: ch.cap,
    aggregatePoIdr: ch.aggregatePo,
    utilizationHeadroomIdr: pm.utilization_headroom_idr,
    availableCashIdr: pm.free_cash_idr,
  });
  return { cap, pm, ch, poolRow, d };
}

function assertBorrowable(p, now) {
  if (
    engine.isRiskLocked(p) ||
    p.status === STATUS.PAST_DUE ||
    engine.isMatured(p, now)
  ) {
    throw new LoanError(
      `Additional borrowing blocked while position is ${p.status}`,
      {
        status: 409,
        code: "RISK_LOCKED",
      },
    );
  }
  if (!engine.isOpen(p)) {
    throw new LoanError(`Position is ${p.status}`, {
      status: 409,
      code: "POSITION_NOT_OPEN",
    });
  }
}

async function drawdown({ coreId, positionId, body, now }) {
  const idempotencyKey = v.requireIdempotencyKey(body.idempotency_key);
  const gross = v.parseIdr(body.gross_loan_idr, "gross_loan_idr");
  await settlePosition(positionId, now);
  const policy = await getActivePolicy(now);

  const s = { pushes: [], chainOps: [] };
  const out = await sequelize.transaction(async (t) => {
    const existing = await findExisting(
      LoanDrawdown,
      idempotencyKey,
      coreId,
      t,
    );
    const p = await lockPosition(positionId, coreId, t);
    if (existing) return { position: p, drawdown: existing, duplicate: true };
    assertBorrowable(p, now);
    if (gross.lt(policy.rules.MIN_ADDITIONAL_GROSS_IDR)) {
      throw new LoanError(
        `Minimum additional gross drawdown is ${policy.rules.MIN_ADDITIONAL_GROSS_IDR} IDR`,
        { code: "BELOW_MINIMUM_GROSS" },
      );
    }
    const st = engine.loadState(p);
    const price = pricing.requireBorrowingPrice(
      await pricing.getValidatedPrice(p.collateralAsset, now, {
        policy,
        transaction: t,
      }),
    );
    const { cap, poolRow } = await capacityFor(p, st, price, policy, t);
    if (gross.gt(cap.available)) {
      throw new LoanError(
        "Requested amount exceeds available additional borrowing",
        {
          status: 409,
          code: "EXCEEDS_CAPACITY",
          details: {
            available_additional_gross_idr: cap.available.toFixed(0),
            ltv_capacity_idr: cap.ltvCap.toFixed(0),
            customer_capacity_idr: cap.customerCap.toFixed(0),
            pool_capacity_idr: cap.poolCap.toFixed(0),
          },
        },
      );
    }
    await pool.getPool({ transaction: t, lock: true });
    pool.assertPoolCanLend(poolRow, policy, gross);

    const d = calc.disbursement(gross, policy.rules.PROTOCOL_FEE_BPS);
    // Akrual prorata sampai now sudah dilakukan settlePosition; PO naik mulai sekarang
    const dd = await LoanDrawdown.create(
      {
        positionId: p.id,
        coreId,
        kind: "ADDITIONAL",
        grossIdr: gross.toFixed(18),
        protocolFeeIdr: d.fee.toFixed(18),
        paidIdr: d.net.toFixed(18),
        status: "CONFIRMED",
        priceSnapshotIdr: price.priceIdr.toFixed(18),
        eligiblePriceIdr: price.eligiblePriceIdr.toFixed(18),
        configVersion: policy.version,
        idempotencyKey,
        effectiveAt: now,
      },
      { transaction: t },
    );
    const credit = await ledger.creditWallet(
      {
        coreId,
        amount: d.net,
        reference: `LOAN-DISB-${dd.id}`,
        description: `Additional loan drawdown (gross ${engine.fmtIdr(gross)}, fee ${engine.fmtIdr(d.fee)})`,
        metadata: { position_id: p.id, drawdown_id: dd.id },
      },
      t,
    );
    const feeEv = await ledger.recordRevenue(
      p,
      {
        revId: REV_ID.PROTOCOL,
        amountIdr: d.fee,
        rateBps: policy.rules.PROTOCOL_FEE_BPS,
        baseIdr: gross,
        sourceTxId: dd.id,
        effectiveAt: now,
        metadata: { kind: "ADDITIONAL" },
      },
      t,
    );
    await dd.update(
      { pgReference: String(credit?.tx?.id || ""), feeEventId: feeEv.id },
      { transaction: t },
    );
    await pool.applyDisbursement(poolRow, gross, d.net, { transaction: t });

    st.po = st.po.plus(gross);
    engine.flushState(p, st);
    p.set({
      grossDisbursedIdr: dec(p.grossDisbursedIdr).plus(gross).toFixed(18),
      netDisbursedIdr: dec(p.netDisbursedIdr).plus(d.net).toFixed(18),
      protocolFeeIdr: dec(p.protocolFeeIdr).plus(d.fee).toFixed(18),
    });
    await p.save({ transaction: t });
    await ledger.recordEvent(
      p,
      {
        eventType: EVENT.ADDITIONAL_DRAWDOWN,
        effectiveAt: now,
        amountIdr: gross,
        metadata: { fee_idr: d.fee, net_idr: d.net, drawdown_id: dd.id },
      },
      t,
    );
    s.pushes.push({
      title: "Additional Drawdown",
      body: `${engine.fmtIdr(d.net)} credited (gross ${engine.fmtIdr(gross)}). Maturity and APR unchanged.`,
      data: { type: "loan", event: "drawdown", position_id: String(p.id) },
    });
    return { position: p, drawdown: dd, duplicate: false };
  });
  await dispatchPushes(coreId, s.pushes);
  return out;
}

// ============================================================
// 07/08 Repayment quote, repay, full settlement, release
// ============================================================

async function previewRepayment(p, s, amountIdr, { full, price, policy, t }) {
  const d = engine.dues(s);
  const risk = calc.riskParams(p.collateralAsset, policy);
  const tddRounded = dec(calc.roundIdr(d.tdd).toString());
  const requested = full ? tddRounded : dec(amountIdr);
  const debit = minDec(requested, tddRounded);
  const wf = calc.waterfall(debit, {
    pdpDue: d.pdpDue,
    interestDue: d.interestDue,
    principal: d.principal,
  });
  const principalAfter = clamp0(d.principal.minus(wf.principal));
  const debtAfter = principalAfter
    .plus(d.interestDue.minus(wf.interest))
    .plus(d.pdpDue.minus(wf.pdp));
  const isFull = full || debtAfter.lt("0.5");
  let release = null;
  let releaseBlocked = null;
  if (engine.isRiskLocked(p) && !isFull)
    releaseBlocked = `RISK_LOCKED_${p.status}`;
  else if (!price?.usableForBorrowing && !isFull)
    releaseBlocked = `PRICE_${price?.status || "UNAVAILABLE"}`;
  if (!releaseBlocked && price?.priceIdr) {
    release = calc.doubleLimitRelease({
      debtAfter: isFull ? 0 : debtAfter,
      qLocked: s.lockedQty,
      price: price.priceIdr,
      postReleaseMaxBps: risk.postReleaseMaxBps,
      principalPaid: wf.principal,
      decimals: p.tokenDecimals,
      fullSettlement: isFull,
    });
  }
  const gas = await bc.estimateReleaseGasIdr();
  const hfAfter =
    price?.priceIdr && release
      ? calc.healthFactor(
          calc.collateralValue(release.qRemaining, price.priceIdr),
          risk.liquidationBps,
          debtAfter,
        )
      : null;
  return {
    d,
    requested,
    debit,
    wf,
    principalAfter,
    debtAfter,
    isFull,
    release,
    releaseBlocked,
    gasQuoteIdr: gas,
    hfAfter,
    quote: toJsonSafe({
      repayment_requested_idr: requested,
      amount_to_debit_idr: debit,
      full_settlement: isFull,
      payment_waterfall: {
        pdp: wf.pdp,
        normal_interest: wf.interest,
        principal: wf.principal,
      },
      interest_breakdown: {
        posted_unpaid_idr: d.postedInterestDue,
        current_cycle_prorata_idr: d.unpostedInterest,
      },
      total_debt_due_before_idr: d.tdd,
      principal_before_idr: d.principal,
      principal_after_idr: principalAfter,
      interest_after_idr: d.interestDue.minus(wf.interest),
      pdp_after_idr: d.pdpDue.minus(wf.pdp),
      total_debt_after_idr: debtAfter,
      collateral_locked_before: s.lockedQty,
      collateral_locked_before_raw: calc.tokenRaw(s.lockedQty, p.tokenDecimals),
      max_release_by_ltv: release?.qRisk ?? null,
      max_release_by_payment: release?.qPayment ?? null,
      eligible_release: release?.qRelease ?? ZERO,
      eligible_release_raw: release
        ? calc.tokenRaw(release.qRelease, p.tokenDecimals)
        : 0n,
      collateral_after_release: release?.qRemaining ?? s.lockedQty,
      post_release_ltv_bps: release?.postReleaseLtvBps ?? null,
      hf_after: hfAfter,
      release_blocked_reason: releaseBlocked,
      gas_estimate_idr: gas,
      user_approval_required: Boolean(release && release.qRelease.gt(0)),
      price_idr: price?.priceIdr ?? null,
      price_status: price?.status ?? null,
      operation_nonce: Number(p.settlementNonce || 0) + 1,
      quote_expires_at: cal.addSeconds(
        new Date(),
        policy.rules.QUOTE_TTL_SECONDS,
      ),
    }),
  };
}

async function quoteRepayment({ coreId, positionId, body, now }) {
  await settlePosition(positionId, now);
  const policy = await getActivePolicy(now);
  const full = v.parseBool(body.full_settlement);
  const amount = full ? null : v.parseIdr(body.amount_idr);
  return sequelize.transaction(async (t) => {
    const p = await lockPosition(positionId, coreId, t);
    if (!engine.isOpen(p)) {
      throw new LoanError(`Position is ${p.status}`, {
        status: 409,
        code: "POSITION_NOT_OPEN",
      });
    }
    const s = engine.loadState(p);
    const price = await pricing.getValidatedPrice(p.collateralAsset, now, {
      policy,
      transaction: t,
    });
    const pv = await previewRepayment(p, s, amount, { full, price, policy, t });
    return pv.quote;
  });
}

/**
 * Repay (partial) / full settlement. body: amount_idr | full_settlement,
 * approve_release (default true), idempotency_key.
 */
async function repay({ coreId, positionId, body, now }) {
  const idempotencyKey = v.requireIdempotencyKey(body.idempotency_key);
  const full = v.parseBool(body.full_settlement);
  const amount = full ? null : v.parseIdr(body.amount_idr);
  const approveRelease =
    body.approve_release === undefined
      ? true
      : v.parseBool(body.approve_release);
  await settlePosition(positionId, now);
  const policy = await getActivePolicy(now);

  const s = { pushes: [], chainOps: [] };
  let pRef;
  const out = await sequelize.transaction(async (t) => {
    const existing = await findExisting(
      LoanRepayment,
      idempotencyKey,
      coreId,
      t,
    );
    const p = await lockPosition(positionId, coreId, t);
    pRef = p;
    if (existing) return { position: p, repayment: existing, duplicate: true };
    if (p.status === STATUS.LIQUIDATION_PENDING) {
      throw new LoanError("Position is locked for liquidation settlement", {
        status: 409,
        code: "SETTLEMENT_LOCKED",
      });
    }
    if (!engine.isOpen(p)) {
      throw new LoanError(`Position is ${p.status}`, {
        status: 409,
        code: "POSITION_NOT_OPEN",
      });
    }
    const st = engine.loadState(p);
    const price = await pricing.getValidatedPrice(p.collateralAsset, now, {
      policy,
      transaction: t,
    });
    const pv = await previewRepayment(p, st, amount, {
      full,
      price,
      policy,
      t,
    });
    if (pv.debit.lte(0)) {
      throw new LoanError("Nothing to pay", { code: "NOTHING_DUE" });
    }

    // Post prorata belum-post dulu (segmen dibayar ditandai, tidak double charge)
    await engine.postPendingProrata(p, st, now, t);

    const statusBefore = p.status;
    const debit = await ledger.debitWallet(
      {
        coreId,
        amount: pv.debit,
        reference: `LOAN-REPAY-${p.id}-${idempotencyKey}`,
        description: pv.isFull ? "Loan full settlement" : "Loan repayment",
        metadata: { position_id: p.id, waterfall: pv.wf },
      },
      t,
    );
    const wf = pv.wf;
    st.pdpPaid = st.pdpPaid.plus(wf.pdp);
    st.unpaidInterest = clamp0(st.unpaidInterest.minus(wf.interest));
    st.interestPaid = st.interestPaid.plus(wf.interest);
    st.po = clamp0(st.po.minus(wf.principal));
    st.principalRepaid = st.principalRepaid.plus(wf.principal);
    // Tandai interest events terbayar (FIFO) untuk audit
    let payLeft = wf.interest;
    const evs = await LoanInterestEvent.findAll({
      where: { positionId: p.id },
      order: [["period_end_at", "ASC"]],
      transaction: t,
    });
    for (const ev of evs) {
      if (payLeft.lte(0)) break;
      const open = dec(ev.accrualIdr).minus(dec(ev.paidIdr));
      if (open.lte(0)) continue;
      const pay = minDec(open, payLeft);
      await ev.update(
        { paidIdr: dec(ev.paidIdr).plus(pay).toFixed(18) },
        { transaction: t },
      );
      payLeft = payLeft.minus(pay);
    }

    let isFull = pv.isFull;
    if (isFull) {
      // Sisa pembulatan rupiah di-post sebagai final rounding
      st.po = ZERO;
      st.unpaidInterest = ZERO;
      st.unpostedInterest = ZERO;
      st.pdpPaid = st.pdpAccrued;
    }

    const poolRow = await pool.getPool({ transaction: t, lock: true });
    await pool.applyRepayment(poolRow, wf.principal, debit.amount, {
      transaction: t,
    });

    const rep = await LoanRepayment.create(
      {
        positionId: p.id,
        coreId,
        kind: isFull ? "FULL_SETTLEMENT" : "PARTIAL",
        requestedIdr: pv.requested.toFixed(18),
        debitedIdr: debit.amount.toFixed(18),
        pdpIdr: wf.pdp.toFixed(18),
        interestIdr: wf.interest.toFixed(18),
        principalIdr: wf.principal.toFixed(18),
        excessIdr: pv.requested.minus(pv.debit).toFixed(18),
        principalBeforeIdr: pv.d.principal.toFixed(18),
        principalAfterIdr: st.po.toFixed(18),
        pgReference: String(debit.tx.id),
        idempotencyKey,
        effectiveAt: now,
        statusBefore,
        metadata: toJsonSafe({ quote: pv.quote }),
      },
      { transaction: t },
    );
    await ledger.recordEvent(
      p,
      {
        eventType: EVENT.REPAYMENT_CONFIRMED,
        effectiveAt: now,
        amountIdr: debit.amount,
        metadata: {
          waterfall: wf,
          repayment_id: rep.id,
          full_settlement: isFull,
        },
      },
      t,
    );

    // Collateral release
    let release = null;
    const rel = pv.release;
    if (
      rel &&
      rel.qRelease.gt(0) &&
      calc.tokenRaw(rel.qRelease, p.tokenDecimals) > 0n
    ) {
      let gasOk = approveRelease;
      let gasCharged = false;
      if (gasOk && pv.gasQuoteIdr.gt(0)) {
        try {
          await ledger.debitWallet(
            {
              coreId,
              amount: pv.gasQuoteIdr,
              reference: `LOAN-GAS-${rep.id}`,
              description: "Collateral release network fee (actual, no markup)",
              metadata: { position_id: p.id },
            },
            t,
          );
          gasCharged = true;
        } catch (e) {
          if (isFull) throw e; // full settlement wajib bayar gas release
          gasOk = false;
        }
      }
      release = await LoanCollateralRelease.create(
        {
          positionId: p.id,
          coreId,
          repaymentId: rep.id,
          kind: isFull ? "FULL" : "PARTIAL",
          tokenQty: rel.qRelease.toFixed(18),
          tokenQtyRaw: calc.tokenRaw(rel.qRelease, p.tokenDecimals).toString(),
          valueIdr: rel.qRelease.mul(price.priceIdr).toFixed(18),
          priceIdr: price.priceIdr.toFixed(18),
          qRiskLimit: rel.qRisk.toFixed(18),
          qPaymentLimit: rel.qPayment.toFixed(18),
          ltvAfterBps: rel.postReleaseLtvBps,
          gasQuoteIdr: pv.gasQuoteIdr.toFixed(18),
          gasActualIdr: gasCharged ? pv.gasQuoteIdr.toFixed(18) : null,
          gasCharged,
          userApproved: gasOk,
          recipient: p.ownerAddress,
          nonce: Number(p.settlementNonce || 0) + 1,
          state: gasOk ? RELEASE_STATUS.PENDING : RELEASE_STATUS.DEFERRED,
          effectiveAt: now,
        },
        { transaction: t },
      );
      if (gasOk) {
        p.set({ settlementNonce: release.nonce });
        s.chainOps.push({ type: "RELEASE", releaseId: release.id });
        if (gasCharged) {
          await ledger.recordRevenue(
            p,
            {
              revId: REV_ID.COST_GAS,
              amountIdr: pv.gasQuoteIdr,
              sourceTxId: release.id,
              effectiveAt: now,
              metadata: { kind: "release_gas_collected" },
            },
            t,
          );
        }
      }
      await rep.update({ releaseId: release.id }, { transaction: t });
      await ledger.recordEvent(
        p,
        {
          eventType: EVENT.RELEASE_REQUESTED,
          effectiveAt: now,
          amountQty: rel.qRelease,
          metadata: {
            release_id: release.id,
            state: release.state,
            post_release_ltv_bps: rel.postReleaseLtvBps,
            gas_quote_idr: pv.gasQuoteIdr,
          },
        },
        t,
      );
    }

    engine.flushState(p, st);
    if (isFull) {
      p.set({
        status: STATUS.COMPLETED,
        riskState: STATUS.COMPLETED,
        completedAt: now,
        nextEventAt: null,
        observationEndsAt: null,
        cureEndsAt: null,
        closedAt: now,
      });
      await p.save({ transaction: t });
      await ledger.recordEvent(
        p,
        {
          eventType: EVENT.COMPLETED,
          effectiveAt: now,
          metadata: { repayment_id: rep.id },
        },
        t,
      );
      await pool.closeCycleIfIdle(coreId, { now, transaction: t });
      s.pushes.push({
        title: "Loan Settled",
        body: `Your loan is fully settled. ${engine.fmtQty(st.lockedQty, p.collateralAsset)} collateral is being released to your wallet.`,
        data: { type: "loan", event: "completed", position_id: String(p.id) },
      });
    } else {
      // Re-evaluasi risk setelah PO turun (status bisa membaik)
      await engine.evaluateRisk(p, st, price, now, policy, t);
      engine.flushState(p, st);
      p.set({ nextEventAt: engine.computeNextEventAt(p, st, now, policy) });
      s.pushes.push({
        title: "Repayment Received",
        body: `${engine.fmtIdr(debit.amount)} applied — principal ${engine.fmtIdr(wf.principal)}, interest ${engine.fmtIdr(wf.interest)}${wf.pdp.gt(0) ? `, penalty ${engine.fmtIdr(wf.pdp)}` : ""}. Outstanding ${engine.fmtIdr(st.po)}.`,
        data: { type: "loan", event: "repayment", position_id: String(p.id) },
      });
    }
    await rep.update({ statusAfter: p.status }, { transaction: t });
    await p.save({ transaction: t });
    return {
      position: p,
      repayment: rep,
      release,
      duplicate: false,
      quote: pv.quote,
    };
  });
  await afterCommit(pRef, s, now);
  return out;
}

/** Eksekusi release on-chain + konfirmasi (lockedQty turun saat confirmed). */
async function executeRelease(releaseId, now) {
  const r = await LoanCollateralRelease.findByPk(releaseId);
  if (!r || ![RELEASE_STATUS.PENDING, RELEASE_STATUS.FAILED].includes(r.state))
    return r;
  const p0 = await LoanPosition.findByPk(r.positionId);
  let txHash;
  try {
    txHash = await bc.releaseCollateral(
      p0,
      r.recipient || (await bc.getBeneficiaryAddress(p0.coreId)) || "0x0",
      dec(r.tokenQty),
      r.nonce,
    );
  } catch (error) {
    await r.update({
      state: RELEASE_STATUS.FAILED,
      attempts: r.attempts + 1,
      lastError: error.message,
    });
    await sequelize.transaction(async (t) => {
      await ledger.recordEvent(
        p0,
        {
          eventType: EVENT.RELEASE_PENDING_RETRY,
          effectiveAt: now,
          metadata: {
            release_id: r.id,
            error: error.message,
            attempts: r.attempts + 1,
          },
        },
        t,
      );
    });
    return r;
  }
  let confirmedQty = null;
  await sequelize.transaction(async (t) => {
    const p = await lockPosition(r.positionId, null, t);
    const rr = await LoanCollateralRelease.findByPk(r.id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (rr.state === RELEASE_STATUS.CONFIRMED) return;
    const s = engine.loadState(p);
    const qty = minDec(dec(rr.tokenQty), s.lockedQty);
    s.lockedQty = s.lockedQty.minus(qty);
    s.releasedQty = s.releasedQty.plus(qty);
    engine.flushState(p, s);
    await p.save({ transaction: t });
    await rr.update(
      {
        state: RELEASE_STATUS.CONFIRMED,
        txHash,
        confirmedAt: now,
        attempts: rr.attempts + 1,
      },
      { transaction: t },
    );
    await ledger.recordEvent(
      p,
      {
        eventType: EVENT.RELEASE_CONFIRMED,
        effectiveAt: now,
        amountQty: qty,
        metadata: { release_id: rr.id, tx_hash: txHash },
      },
      t,
    );
    confirmedQty = qty;
  });
  if (confirmedQty) {
    try {
      await pushService.sendPushToUser(p0.coreId, {
        title: "Collateral Released",
        body: `${engine.fmtQty(confirmedQty, p0.collateralAsset)} sent to your wallet.`,
        data: {
          type: "loan",
          event: "release_confirmed",
          position_id: String(p0.id),
          tx_hash: txHash,
        },
      });
    } catch (error) {
      console.log(`[Loan] push gagal ${p0.coreId}:`, error.message);
    }
  }
  return LoanCollateralRelease.findByPk(r.id);
}

// ============================================================
// Add collateral (top-up)
// ============================================================

async function topUpCollateral({ coreId, positionId, body, now }) {
  const idempotencyKey = v.requireIdempotencyKey(body.idempotency_key);
  const qty = v.parseQty(body.collateral_qty);
  await settlePosition(positionId, now);
  const policy = await getActivePolicy(now);
  const p0 = await LoanPosition.findOne({ where: { id: positionId, coreId } });
  if (!p0)
    throw new LoanError("Loan position not found", {
      status: 404,
      code: "POSITION_NOT_FOUND",
    });
  if (p0.status === STATUS.LIQUIDATION_PENDING || !engine.isOpen(p0)) {
    throw new LoanError(
      `Add collateral blocked while position is ${p0.status}`,
      { status: 409, code: "SETTLEMENT_LOCKED" },
    );
  }
  const dup = await LoanEvent.findOne({
    where: {
      positionId,
      eventType: EVENT.COLLATERAL_TOPUP,
      correlationId: idempotencyKey,
    },
  });
  if (dup) return { position: p0, duplicate: true };

  const txHash = await bc.lockCollateral(p0, p0.ownerAddress || "0x0", qty);
  const s = { pushes: [], chainOps: [] };
  let pRef;
  await sequelize.transaction(async (t) => {
    const p = await lockPosition(positionId, coreId, t);
    pRef = p;
    const st = engine.loadState(p);
    st.lockedQty = st.lockedQty.plus(qty);
    engine.flushState(p, st);
    p.set({ toppedUpQty: dec(p.toppedUpQty).plus(qty).toFixed(18) });
    await ledger.recordEvent(
      p,
      {
        eventType: EVENT.COLLATERAL_TOPUP,
        effectiveAt: now,
        amountQty: qty,
        correlationId: idempotencyKey,
        metadata: { tx_hash: txHash },
      },
      t,
    );
    const price = await pricing.getValidatedPrice(p.collateralAsset, now, {
      policy,
      transaction: t,
    });
    await engine.evaluateRisk(p, st, price, now, policy, t);
    engine.flushState(p, st);
    p.set({ nextEventAt: engine.computeNextEventAt(p, st, now, policy) });
    await p.save({ transaction: t });
    s.pushes.push({
      title: "Collateral Added",
      body: `${engine.fmtQty(qty, p.collateralAsset)} added. Status: ${p.status}.`,
      data: { type: "loan", event: "topup", position_id: String(p.id) },
    });
  });
  await afterCommit(pRef, s, now);
  return { position: pRef, duplicate: false, txHash };
}

// ============================================================
// Read models
// ============================================================

async function serializePosition(p, { now, policy, price } = {}) {
  policy = policy || (await getActivePolicy(now));
  const s = engine.loadState(p);
  if (engine.isOpen(p) && p.activatedAt) {
    // Proyeksi prorata sampai now untuk tampilan (tanpa persist)
    const tmp = { ...s };
    engine.accrueUnposted(p, tmp, now);
    s.unpostedInterest = tmp.unpostedInterest;
  }
  const d = engine.dues(s);
  const risk = calc.riskParams(p.collateralAsset, policy);
  const hfB = calc.hfBoundaries(risk);
  price =
    price ||
    (engine.isOpen(p)
      ? await pricing.getValidatedPrice(p.collateralAsset, now, { policy })
      : null);
  const collValue = price?.priceIdr
    ? calc.collateralValue(s.lockedQty, price.priceIdr)
    : null;
  const ltv = collValue ? calc.ltvBps(d.tdd, collValue) : null;
  const hf = collValue
    ? calc.healthFactor(collValue, risk.liquidationBps, d.tdd)
    : null;
  const timers = {};
  if (p.observationEndsAt && now && cal.isBefore(now, p.observationEndsAt))
    timers.observation_seconds_remaining = Math.floor(
      cal.secondsBetween(now, p.observationEndsAt),
    );
  if (p.cureEndsAt && now && cal.isBefore(now, p.cureEndsAt))
    timers.cure_seconds_remaining = Math.floor(
      cal.secondsBetween(now, p.cureEndsAt),
    );
  const nextAnniv = p.activatedAt
    ? cal.anniversaryAt(p.activatedAt, s.lastAnniv + 1)
    : null;
  return toJsonSafe({
    id: p.id,
    status: p.status,
    status_meaning: statusMeaning(p.status),
    settlement_status: p.settlementStatus,
    collateral_asset: p.collateralAsset,
    collateral: {
      locked_qty: s.lockedQty,
      locked_qty_raw: calc.tokenRaw(s.lockedQty, p.tokenDecimals),
      original_qty: p.originalQty,
      topped_up_qty: p.toppedUpQty,
      released_qty: s.releasedQty,
      settled_qty: s.settledQty,
      market_value_idr: collValue,
    },
    debt: {
      gross_disbursed_idr: p.grossDisbursedIdr,
      net_disbursed_idr: p.netDisbursedIdr,
      protocol_fee_idr: p.protocolFeeIdr,
      principal_outstanding_idr: d.principal,
      principal_repaid_idr: s.principalRepaid,
      unpaid_normal_interest_idr: d.interestDue,
      interest_posted_unpaid_idr: d.postedInterestDue,
      interest_current_cycle_prorata_idr: d.unpostedInterest,
      interest_paid_idr: s.interestPaid,
      pdp_due_idr: d.pdpDue,
      pdp_accrued_idr: s.pdpAccrued,
      pdp_days_charged: s.pdpDays,
      total_debt_due_idr: d.tdd,
      first_cycle_interest_free: s.lastAnniv === 0,
    },
    terms: {
      apr_bps: p.aprBps,
      tenor_days: p.tenorDays,
      activated_at: p.activatedAt,
      maturity_at: p.maturityAt,
      next_anniversary_at: nextAnniv,
      anniversaries_posted: s.lastAnniv,
    },
    risk: {
      initial_ltv_bps: p.initialLtvBps,
      min_initial_ltv_bps: risk.minInitialLtvBps ?? null,
      current_ltv_bps: ltv,
      health_factor: hf,
      hf_initial: hfB.initial,
      hf_margin_call: hfB.marginCall,
      hf_liquidation: 1,
      hf_emergency: hfB.emergency,
      margin_call_bps: risk.marginCallBps,
      liquidation_threshold_bps: risk.liquidationBps,
      emergency_threshold_bps: risk.emergencyBps,
      post_release_ltv_max_bps: risk.postReleaseMaxBps,
      observation_used: p.observationUsed,
      observation_started_at: p.observationStartedAt,
      observation_ends_at: p.observationEndsAt,
      cure_eligible: p.cureEligible,
      cure_ends_at: p.cureEndsAt,
      liquidation_trigger: p.liquidationTrigger,
      ...timers,
      price_idr: price?.priceIdr ?? null,
      price_status: price?.status ?? null,
      price_observed_at: price?.observedAt ?? null,
      last_risk_check_at: p.lastRiskCheckAt,
    },
    onchain: {
      position_id: p.onchainPositionId,
      owner: p.ownerAddress,
      lock_tx_hash: p.lockTxHash,
      chain_mode: bc.MODE,
    },
    is_test: p.isTest,
    business_now: now,
    created_at: p.createdAt,
    completed_at: p.completedAt,
    closed_at: p.closedAt,
  });
}

function statusMeaning(status) {
  return (
    {
      PENDING_COLLATERAL: "Waiting for collateral lock confirmation",
      PENDING_DISBURSEMENT: "Collateral locked; waiting IDR disbursement",
      ACTIVE: "Healthy",
      MARGIN_CALL: "LTV in margin zone — repay or add collateral",
      LIQUIDATION_OBSERVATION:
        "Liquidation threshold hit — 4h observation window (XAUT)",
      RECOVERING: "Price recovered but observation timer continues",
      PAST_DUE: "Matured — conditional 3-day cure",
      EMERGENCY: "Emergency threshold reached",
      LIQUIDATION_PENDING: "Liquidation authorized — settlement in progress",
      AUTO_LIQUIDATED: "Settled from collateral; refund sent",
      COMPLETED: "Fully repaid and collateral released",
      CANCELLED: "Cancelled before activation",
    }[status] || status
  );
}

async function listPositions({ coreId, status, includeTest, now }) {
  const where = { coreId };
  if (status) where.status = String(status).toUpperCase();
  if (!includeTest) where.isTest = false;
  const rows = await LoanPosition.findAll({
    where,
    order: [["created_at", "DESC"]],
  });
  const policy = await getActivePolicy(now);
  const priceCache = {};
  const out = [];
  for (const p of rows) {
    if (engine.isOpen(p) && !priceCache[p.collateralAsset]) {
      priceCache[p.collateralAsset] = await pricing.getValidatedPrice(
        p.collateralAsset,
        now,
        { policy },
      );
    }
    out.push(
      await serializePosition(p, {
        now,
        policy,
        price: priceCache[p.collateralAsset],
      }),
    );
  }
  return {
    summary: {
      open: rows.filter((r) => OPEN_STATUSES.includes(r.status)).length,
      closed: rows.filter((r) => TERMINAL_STATUSES.includes(r.status)).length,
      total: rows.length,
    },
    positions: out,
  };
}

async function getPositionDetail({ coreId, positionId, now }) {
  const p = await LoanPosition.findOne({ where: { id: positionId, coreId } });
  if (!p)
    throw new LoanError("Loan position not found", {
      status: 404,
      code: "POSITION_NOT_FOUND",
    });
  if (engine.isOpen(p)) await settlePosition(p.id, now);
  const fresh = await LoanPosition.findByPk(p.id, {
    include: [
      {
        association: "drawdowns",
        separate: true,
        order: [["created_at", "ASC"]],
      },
      {
        association: "repayments",
        separate: true,
        order: [["created_at", "ASC"]],
      },
      {
        association: "releases",
        separate: true,
        order: [["created_at", "ASC"]],
      },
      {
        association: "interestEvents",
        separate: true,
        order: [["period_end_at", "ASC"]],
      },
      { association: "liquidations", separate: true },
      {
        association: "events",
        separate: true,
        order: [["effective_at", "ASC"]],
      },
    ],
  });
  const policy = await getActivePolicy(now);
  const base = await serializePosition(fresh, { now, policy });
  let capacity = null;
  if (
    engine.isOpen(fresh) &&
    !engine.isRiskLocked(fresh) &&
    !engine.isMatured(fresh, now)
  ) {
    const price = await pricing.getValidatedPrice(fresh.collateralAsset, now, {
      policy,
    });
    if (price.usableForBorrowing) {
      const s = engine.loadState(fresh);
      const { cap } = await capacityFor(fresh, s, price, policy, null);
      capacity = {
        available_additional_gross_idr: cap.available,
        ltv_capacity_idr: cap.ltvCap,
        customer_capacity_idr: cap.customerCap,
        pool_capacity_idr: cap.poolCap,
        borrowing_eligible_price_idr: price.eligiblePriceIdr,
        min_additional_gross_idr: policy.rules.MIN_ADDITIONAL_GROSS_IDR,
        quote_expires_at: cal.addSeconds(
          new Date(),
          policy.rules.QUOTE_TTL_SECONDS,
        ),
      };
    } else {
      capacity = {
        available_additional_gross_idr: 0,
        blocked_reason: `PRICE_${price.status}`,
      };
    }
  }
  const dump = (rows) =>
    (rows || []).map((r) =>
      r && typeof r.toJSON === "function" ? r.toJSON() : r,
    );
  return toJsonSafe({
    ...base,
    available_additional_borrowing: capacity,
    drawdowns: dump(fresh.drawdowns),
    repayments: dump(fresh.repayments),
    releases: dump(fresh.releases),
    interest_events: dump(fresh.interestEvents),
    liquidations: (fresh.liquidations || []).map((l) => ({
      ...l.toJSON(),
      signature: undefined,
    })),
    events: dump(fresh.events),
  });
}

module.exports = {
  settlePosition,
  config,
  quoteOpen,
  openPosition,
  drawdown,
  quoteRepayment,
  repay,
  executeRelease,
  topUpCollateral,
  serializePosition,
  listPositions,
  getPositionDetail,
  lockPosition,
  reconcilePendingCollateral,
  completePendingCollateral,
  repairCollateralLock,
};
