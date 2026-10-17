/*
 * Lending Pool, Borrower Cap & Reserve Separation (brief 04, 16).
 *
 * - eligible_lending_capital = basis cap & utilisasi (BUKAN termasuk reserve).
 * - protected_reserve ring-fenced; dipakai hanya menutup shortfall liquidation
 *   (settlement advance), lalu alert injeksi untuk kembali ke target 120%.
 * - Borrower cycle snapshot: cap 5% x capital saat loan pertama siklus;
 *   dipertahankan sampai SEMUA posisi user closed.
 *
 * Semua fungsi mutasi WAJIB dipanggil dalam transaction (row lock pool).
 */

const { Op } = require("sequelize");
const {
  LoanPool,
  LoanPoolSnapshot,
  LoanBorrowerCycle,
  LoanPosition,
} = require("../../models");
const calc = require("./loan.calc");
const { COUNTED_STATUSES, OPEN_STATUSES } = require("./loan.constants");
const { LoanError } = require("./loan.errors");

const { dec, clamp0, minDec } = calc;

const SEED_CAPITAL = process.env.LOAN_POOL_CAPITAL_IDR || "100000000";
const SEED_RESERVE = process.env.LOAN_POOL_RESERVE_IDR || "20000000";

async function getPool({ transaction, lock = false } = {}) {
  const opts = { where: { id: 1 }, transaction };
  if (lock && transaction) opts.lock = transaction.LOCK.UPDATE;
  let pool = await LoanPool.findOne(opts);
  if (!pool) {
    // Seed dev/staging. Production: admin set via endpoint pool/config.
    pool = await LoanPool.create(
      {
        id: 1,
        eligibleLendingCapitalIdr: SEED_CAPITAL,
        protectedReserveIdr: SEED_RESERVE,
        protectedReserveTargetIdr: SEED_RESERVE,
        confirmedCashIdr: SEED_CAPITAL,
        updatedBy: "seed",
      },
      { transaction },
    );
  }
  return pool;
}

/** Metrik pool (brief 04 tabel). */
function metrics(pool, policy) {
  const rules = policy?.rules || {};
  const capital = dec(pool.eligibleLendingCapitalIdr);
  const onloan = dec(pool.onloanPrincipalIdr);
  const reserve = dec(pool.protectedReserveIdr);
  const target = dec(pool.protectedReserveTargetIdr);
  const cash = dec(pool.confirmedCashIdr);
  const restricted = dec(pool.restrictedAllocationIdr);
  const utilizationCap = calc.utilizationCap(capital, rules.MAX_POOL_UTILIZATION_BPS);
  const utilizationHeadroom = clamp0(utilizationCap.minus(onloan));
  const availableCash = clamp0(cash.minus(restricted));
  const committed = capital.plus(reserve);
  const requiredCoverage = capital.plus(target);
  const coverageBps = capital.gt(0)
    ? Number(committed.div(capital).mul(10000).toFixed(2))
    : 0;
  const requiredInjection = clamp0(requiredCoverage.minus(committed));
  return {
    eligible_lending_capital_idr: capital,
    protected_reserve_idr: reserve,
    protected_reserve_target_idr: target,
    confirmed_cash_idr: cash,
    restricted_allocation_idr: restricted,
    free_cash_idr: availableCash,
    onloan_principal_idr: onloan,
    outstanding_advance_idr: dec(pool.outstandingAdvanceIdr),
    utilization_cap_idr: utilizationCap,
    utilization_headroom_idr: utilizationHeadroom,
    utilization_bps: capital.gt(0) ? calc.ratioBps(onloan, capital) : 0,
    loan_funding_coverage_bps: coverageBps,
    coverage_target_bps: rules.LOAN_FUNDING_COVERAGE_BPS,
    required_injection_idr: requiredInjection,
    lending_paused: Boolean(pool.lendingPaused),
    pause_reason: pool.pauseReason || null,
  };
}

async function snapshot(pool, reason, { positionId, now, transaction }) {
  return LoanPoolSnapshot.create(
    {
      eligibleCapitalIdr: pool.eligibleLendingCapitalIdr,
      protectedReserveIdr: pool.protectedReserveIdr,
      onloanPrincipalIdr: pool.onloanPrincipalIdr,
      confirmedCashIdr: pool.confirmedCashIdr,
      reason,
      positionId: positionId || null,
      asOf: now,
    },
    { transaction },
  );
}

/** Jumlah posisi yang dihitung untuk limit 2 / customer. */
async function countActivePositions(coreId, { transaction, excludeId } = {}) {
  const where = { coreId, status: { [Op.in]: COUNTED_STATUSES } };
  if (excludeId) where.id = { [Op.ne]: excludeId };
  return LoanPosition.count({ where, transaction });
}

/** Aggregate PO seluruh posisi open user. */
async function aggregatePrincipal(coreId, { transaction } = {}) {
  const rows = await LoanPosition.findAll({
    attributes: ["principalOutstandingIdr"],
    where: { coreId, status: { [Op.in]: OPEN_STATUSES } },
    transaction,
  });
  return rows.reduce((s, r) => s.plus(dec(r.principalOutstandingIdr)), dec(0));
}

/**
 * Ambil/buat borrower cycle OPEN. Snapshot cap = 5% x capital saat
 * pembukaan pertama; posisi kedua memakai snapshot yang sama.
 */
async function getOrOpenCycle(coreId, pool, policy, { now, transaction }) {
  let cycle = await LoanBorrowerCycle.findOne({
    where: { coreId, status: "OPEN" },
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });
  if (cycle) return { cycle, created: false };
  const snap = await snapshot(pool, "BORROWER_CYCLE_OPEN", { now, transaction });
  const capital = dec(pool.eligibleLendingCapitalIdr);
  cycle = await LoanBorrowerCycle.create(
    {
      coreId,
      poolSnapshotId: snap.id,
      eligibleCapitalAtFirstLoanIdr: capital.toFixed(18),
      borrowerCapIdr: calc.borrowerCap(capital, policy.rules.BORROWER_CAP_BPS).toFixed(18),
      cycleStartedAt: now,
      status: "OPEN",
    },
    { transaction },
  );
  return { cycle, created: true };
}

/** Tutup cycle jika user tidak punya posisi counted lagi. */
async function closeCycleIfIdle(coreId, { now, transaction }) {
  const remaining = await countActivePositions(coreId, { transaction });
  if (remaining > 0) return false;
  await LoanBorrowerCycle.update(
    { status: "CLOSED", cycleClosedAt: now },
    { where: { coreId, status: "OPEN" }, transaction },
  );
  return true;
}

/** Headroom customer = cap siklus - aggregate PO. */
async function customerHeadroom(coreId, cycle, { transaction }) {
  const agg = await aggregatePrincipal(coreId, { transaction });
  return { cap: dec(cycle.borrowerCapIdr), aggregatePo: agg, headroom: clamp0(dec(cycle.borrowerCapIdr).minus(agg)) };
}

/** Reservasi cash + utilisasi untuk disbursement baru (semua limit serentak). */
function assertPoolCanLend(pool, policy, grossIdr) {
  const m = metrics(pool, policy);
  if (m.lending_paused) {
    throw new LoanError(`Lending paused: ${m.pause_reason || "treasury hold"}`, {
      status: 503,
      code: "LENDING_PAUSED",
    });
  }
  const g = dec(grossIdr);
  if (g.gt(m.utilization_headroom_idr)) {
    throw new LoanError("Pool utilization headroom insufficient", {
      status: 409,
      code: "POOL_UTILIZATION_EXCEEDED",
      details: { utilization_headroom_idr: m.utilization_headroom_idr.toFixed(0) },
    });
  }
  if (g.gt(m.free_cash_idr)) {
    throw new LoanError("Confirmed PG cash insufficient for disbursement", {
      status: 503,
      code: "CASH_INSUFFICIENT",
      details: { free_cash_idr: m.free_cash_idr.toFixed(0) },
    });
  }
  return m;
}

/** Disbursement confirmed: on-loan naik, cash turun. */
async function applyDisbursement(pool, grossIdr, netIdr, { transaction }) {
  await pool.update(
    {
      onloanPrincipalIdr: dec(pool.onloanPrincipalIdr).plus(grossIdr).toFixed(18),
      confirmedCashIdr: dec(pool.confirmedCashIdr).minus(netIdr).toFixed(18),
    },
    { transaction },
  );
}

/** Repayment confirmed: principal kembali ke on-loan, kas masuk. */
async function applyRepayment(pool, principalIdr, cashInIdr, { transaction }) {
  await pool.update(
    {
      onloanPrincipalIdr: clamp0(dec(pool.onloanPrincipalIdr).minus(principalIdr)).toFixed(18),
      confirmedCashIdr: dec(pool.confirmedCashIdr).plus(cashInIdr).toFixed(18),
    },
    { transaction },
  );
}

/**
 * Settlement advance saat liquidation (brief 14/16): perusahaan menutup
 * pool dengan IDR advance sebesar TDD; shortfall (deficit) ditutup reserve.
 */
async function applyLiquidationAdvance(pool, { principalIdr, totalDebtDueIdr, deficitIdr }, { transaction }) {
  const reserve = dec(pool.protectedReserveIdr);
  const deficit = dec(deficitIdr);
  const reserveUsed = minDec(reserve, deficit);
  await pool.update(
    {
      onloanPrincipalIdr: clamp0(dec(pool.onloanPrincipalIdr).minus(principalIdr)).toFixed(18),
      // Advance IDR mereplenish pool; kas dianggap masuk sebesar TDD (perusahaan prefund)
      confirmedCashIdr: dec(pool.confirmedCashIdr).plus(totalDebtDueIdr).toFixed(18),
      outstandingAdvanceIdr: dec(pool.outstandingAdvanceIdr).plus(totalDebtDueIdr).toFixed(18),
      protectedReserveIdr: reserve.minus(reserveUsed).toFixed(18),
    },
    { transaction },
  );
  return { reserveUsed, uncovered: clamp0(deficit.minus(reserveUsed)) };
}

/** Treasury sale proceeds menutup advance; TIDAK menambah eligible capital. */
async function applyTreasuryProceeds(pool, netProceedsIdr, { transaction }) {
  const adv = dec(pool.outstandingAdvanceIdr);
  const applied = minDec(adv, dec(netProceedsIdr));
  await pool.update(
    { outstandingAdvanceIdr: adv.minus(applied).toFixed(18) },
    { transaction },
  );
  return applied;
}

async function injectReserve(pool, amountIdr, { transaction }) {
  await pool.update(
    { protectedReserveIdr: dec(pool.protectedReserveIdr).plus(amountIdr).toFixed(18) },
    { transaction },
  );
}

module.exports = {
  getPool,
  metrics,
  snapshot,
  countActivePositions,
  aggregatePrincipal,
  getOrOpenCycle,
  closeCycleIfIdle,
  customerHeadroom,
  assertPoolCanLend,
  applyDisbursement,
  applyRepayment,
  applyLiquidationAdvance,
  applyTreasuryProceeds,
  injectReserve,
};
