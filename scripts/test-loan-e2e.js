/*
 * E2E Loan V1 dengan TIME TRAVEL (BusinessClock SIMULATED) + harga uji.
 * Pakai service layer langsung (tanpa HTTP/JWT), posisi is_test=true,
 * chain mode mock. Clock dikembalikan ke REAL di akhir.
 *
 *   node scripts/test-loan-e2e.js [coreId] [only: A,B,...]
 */
require("dotenv").config();
process.env.LOAN_REQUIRE_KYC = "0";

const crypto = require("crypto");
const { Op } = require("sequelize");
const Decimal = require("decimal.js");
const svc = require("../services/loan/loan.service");
const admin = require("../services/loan/loan.admin");
const { tick } = require("../services/loan/loan.scheduler");
const businessClock = require("../services/businessClock");
const {
  sequelize,
  LoanPosition,
  LoanPool,
  LoanBorrowerCycle,
  LoanTreasuryLot,
  LoanLiquidation,
  LoanCollateralRelease,
  LoanInterestEvent,
  InternalWallet,
} = require("../models");

const CORE_ID = process.argv[2] || "RABv8pXT";
const ONLY = process.argv[3] ? process.argv[3].split(",") : null;
const ik = () => `loan-e2e-${crypto.randomUUID()}`;
const results = [];
const D = (v) => new Decimal(String(v ?? 0));

function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(
    `${cond ? "  PASS" : "  FAIL"} ${name}${extra ? " — " + extra : ""}`,
  );
}
const near = (a, b, tol) => D(a).minus(D(b)).abs().lte(tol);

async function at(date) {
  await businessClock.setClock({
    mode: "SIMULATED",
    simulatedNow: date,
    updatedBy: "loan-e2e",
  });
  console.log(`  >> clock -> ${new Date(date).toISOString()}`);
  return new Date(date);
}
const now = () => businessClock.current();
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 864e5);
const addHours = (d, n) => new Date(new Date(d).getTime() + n * 36e5);

async function price(asset, perToken) {
  await admin.setTestPrice({ asset, price_idr: String(perToken) }, await now());
}
async function setPool(capital, reserve = "20000000") {
  const [pool] = await LoanPool.findOrCreate({
    where: { id: 1 },
    defaults: {},
  });
  await pool.update({
    eligibleLendingCapitalIdr: capital,
    protectedReserveIdr: reserve,
    protectedReserveTargetIdr: reserve,
    confirmedCashIdr: capital,
    onloanPrincipalIdr: 0,
    restrictedAllocationIdr: 0,
    outstandingAdvanceIdr: 0,
    lendingPaused: false,
  });
}
async function fundWallet(amount) {
  const [w] = await InternalWallet.findOrCreate({
    where: { coreId: CORE_ID },
    defaults: { coreId: CORE_ID, balanceIdr: 0 },
  });
  await w.update({ balanceIdr: D(amount).toFixed(2) });
}
async function balance() {
  const w = await InternalWallet.findOne({ where: { coreId: CORE_ID } });
  return D(w?.balanceIdr || 0);
}
async function cleanup() {
  // Tutup posisi test lama agar limit 2 / cap tidak terganggu
  const open = await LoanPosition.findAll({
    where: { coreId: CORE_ID, isTest: true },
  });
  const ids = open.map((p) => p.id);
  for (const p of open) {
    if (!["COMPLETED", "AUTO_LIQUIDATED", "CANCELLED"].includes(p.status)) {
      await p.update({
        status: "CANCELLED",
        closedAt: new Date(),
        nextEventAt: null,
      });
    }
  }
  // Lot treasury & liquidation sisa run lama mengotori agregat dashboard/BEP
  if (ids.length) {
    await LoanTreasuryLot.destroy({
      where: { sourcePositionId: { [Op.in]: ids } },
    });
    await LoanLiquidation.destroy({ where: { positionId: { [Op.in]: ids } } });
  }
  await LoanBorrowerCycle.update(
    { status: "CLOSED", cycleClosedAt: new Date() },
    { where: { coreId: CORE_ID, status: "OPEN" } },
  );
}
async function open(body) {
  const { position } = await svc.openPosition({
    coreId: CORE_ID,
    body: { ...body, idempotency_key: ik() },
    now: await now(),
    isTest: true,
  });
  console.log(
    `  position ${position.id} ${position.collateralAsset} qty=${D(position.lockedQty).toFixed(6)} PO=${D(position.principalOutstandingIdr).toFixed(0)} -> ${position.status}`,
  );
  return position;
}
async function repay(id, amount, extra = {}) {
  return svc.repay({
    coreId: CORE_ID,
    positionId: id,
    body: { amount_idr: String(amount), idempotency_key: ik(), ...extra },
    now: await now(),
  });
}
async function settleFull(id) {
  return svc.repay({
    coreId: CORE_ID,
    positionId: id,
    body: { full_settlement: true, idempotency_key: ik() },
    now: await now(),
  });
}
async function expectError(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}
const reload = (id) => LoanPosition.findByPk(id);
async function runTick() {
  const r = await tick(await now());
  return r;
}
const run = (key) => !ONLY || ONLY.includes(key);

// ============================================================
// Scenarios
// ============================================================

async function scenarioA() {
  console.log(
    "\n[A] Open XAUT 39m / 1 XAUT @60m — fee, net, LTV, interest-free full settlement (Q01, Q08)",
  );
  await cleanup();
  await setPool("1000000000"); // cap 5% = 50m
  await fundWallet("100000000");
  await at("2026-10-09T03:00:00Z");
  await price("XAUT", "60000000");
  const before = await balance();
  const p = await open({
    collateral_asset: "XAUT",
    collateral_qty: "1",
    tenor_days: 90,
    gross_loan_idr: "39000000",
  });
  check("A1 status ACTIVE", p.status === "ACTIVE");
  check(
    "A2 PO = 39m (gross, bukan net)",
    D(p.principalOutstandingIdr).eq(39000000),
  );
  check("A3 fee 195k", D(p.protocolFeeIdr).eq(195000));
  check(
    "A4 net credited 38,805,000",
    (await balance()).minus(before).eq(38805000),
  );
  check(
    "A5 maturity = +90d",
    new Date(p.maturityAt).getTime() ===
      addDays("2026-10-09T03:00:00Z", 90).getTime(),
  );
  const ser = await svc.serializePosition(p, { now: await now() });
  check(
    "A6 LTV 65%",
    near(ser.risk.current_ltv_bps, 6500, 1),
    ser.risk.current_ltv_bps,
  );
  check(
    "A7 HF 1.1538",
    near(ser.risk.health_factor, "1.1538", 0.0002),
    ser.risk.health_factor,
  );

  await at("2026-10-25T03:00:00Z");
  const q = await svc.quoteRepayment({
    coreId: CORE_ID,
    positionId: p.id,
    body: { full_settlement: true },
    now: await now(),
  });
  check(
    "A8 full settlement quote interest = 0 (first cycle free)",
    D(q.payment_waterfall.normal_interest).eq(0),
    q.payment_waterfall.normal_interest,
  );
  check("A9 quote releases ALL collateral", D(q.eligible_release).eq(1));
  const out = await settleFull(p.id);
  const p2 = await reload(p.id);
  check("A10 COMPLETED", p2.status === "COMPLETED");
  check("A11 debited 39m exactly", D(out.repayment.debitedIdr).eq(39000000));
  check(
    "A12 release FULL confirmed 1 XAUT",
    out.release && D(out.release.tokenQty).eq(1),
  );
  check(
    "A13 lockedQty 0, releasedQty 1",
    D(p2.lockedQty).eq(0) && D(p2.releasedQty).eq(1),
  );
  const cyc = await LoanBorrowerCycle.findOne({
    where: { coreId: CORE_ID, status: "OPEN" },
  });
  check("A14 borrower cycle closed (all positions closed)", !cyc);
}

async function scenarioB() {
  console.log(
    "\n[B] Example A — 10m @12%: first anniversary interest 100k; Example B second-cycle prorata",
  );
  await cleanup();
  await setPool("1000000000");
  await fundWallet("100000000");
  await at("2026-10-09T03:00:00Z");
  await price("XAUT", "60000000");
  // tenor 90 -> APR XAUT 12% (matrix); Example A brief pakai 12%
  const p = await open({
    collateral_asset: "XAUT",
    collateral_qty: "0.5",
    tenor_days: 90,
    gross_loan_idr: "10000000",
  });
  await at("2026-11-08T03:00:00Z");
  await runTick();
  let r = await reload(p.id);
  check(
    "B1 day before anniversary: no interest",
    D(r.unpaidInterestIdr).eq(0) && D(r.unpostedInterestIdr).eq(0),
  );
  await at("2026-11-09T03:00:00Z");
  await runTick();
  r = await reload(p.id);
  check(
    "B2 first anniversary posted 100,000",
    near(r.unpaidInterestIdr, 100000, 0.01),
    D(r.unpaidInterestIdr).toFixed(2),
  );
  check(
    "B3 principal unchanged 10m (no compounding)",
    D(r.principalOutstandingIdr).eq(10000000),
  );
  const evs = await LoanInterestEvent.findAll({ where: { positionId: p.id } });
  check(
    "B4 exactly one FIRST_ANNIVERSARY event",
    evs.filter((e) => e.kind === "FIRST_ANNIVERSARY").length === 1,
  );
  await runTick();
  r = await reload(p.id);
  check(
    "B5 re-tick idempotent (still 100k)",
    near(r.unpaidInterestIdr, 100000, 0.01),
  );
  // 20 Nov: 11/30 hari cycle kedua -> prorata 10m x 1% x 11/30 = 36,666.67
  await at("2026-11-20T03:00:00Z");
  const q = await svc.quoteRepayment({
    coreId: CORE_ID,
    positionId: p.id,
    body: { full_settlement: true },
    now: await now(),
  });
  check(
    "B6 prorata 11/30 = 36,666.67",
    near(q.interest_breakdown.current_cycle_prorata_idr, "36666.67", 0.05),
    q.interest_breakdown.current_cycle_prorata_idr,
  );
  check(
    "B7 payoff = 10m + 100k + 36,666.67",
    near(q.total_debt_due_before_idr, "10136666.67", 0.05),
    q.total_debt_due_before_idr,
  );
  const out = await settleFull(p.id);
  check(
    "B8 debited rounded 10,136,667",
    D(out.repayment.debitedIdr).eq(10136667),
    out.repayment.debitedIdr,
  );
  check("B9 COMPLETED", (await reload(p.id)).status === "COMPLETED");
}

async function scenarioC() {
  console.log(
    "\n[C] Worked Example C — two repayments across first anniversary + Double-Limit (Q21, Q56, Q58)",
  );
  await cleanup();
  await setPool("1000000000");
  await fundWallet("100000000");
  await at("2026-10-09T03:00:00Z");
  await price("XAUT", "60000000");
  const p = await open({
    collateral_asset: "XAUT",
    collateral_qty: "1",
    tenor_days: 90,
    gross_loan_idr: "39000000",
  });
  await at("2026-10-25T03:00:00Z");
  const r1 = await repay(p.id, 5000000);
  check("C1 PO 34m", D(r1.repayment.principalAfterIdr).eq(34000000));
  check("C2 interest paid 0 in first cycle", D(r1.repayment.interestIdr).eq(0));
  check(
    "C3 release ≈0.055555 XAUT",
    r1.release && near(r1.release.tokenQty, "0.055555", 0.000002),
    r1.release?.tokenQty,
  );
  check(
    "C4 post-release LTV 60.00%",
    r1.release && near(r1.release.ltvAfterBps, 6000, 1),
    r1.release?.ltvAfterBps,
  );
  let p1 = await reload(p.id);
  check(
    "C5 locked 0.944445",
    near(p1.lockedQty, "0.944445", 0.000002),
    D(p1.lockedQty).toFixed(6),
  );
  await at("2026-11-09T03:00:00Z");
  await runTick();
  p1 = await reload(p.id);
  check(
    "C6 first anniversary interest 340k on PO 34m (snapshot)",
    near(p1.unpaidInterestIdr, 340000, 0.01),
    D(p1.unpaidInterestIdr).toFixed(2),
  );
  await at("2026-11-20T03:00:00Z");
  const q = await svc.quoteRepayment({
    coreId: CORE_ID,
    positionId: p.id,
    body: { amount_idr: "5000000" },
    now: await now(),
  });
  check(
    "C7 prorata 124,666.67",
    near(q.interest_breakdown.current_cycle_prorata_idr, "124666.67", 0.05),
    q.interest_breakdown.current_cycle_prorata_idr,
  );
  check(
    "C8 waterfall interest 464,666.67",
    near(q.payment_waterfall.normal_interest, "464666.67", 0.05),
  );
  check(
    "C9 waterfall principal 4,535,333.33",
    near(q.payment_waterfall.principal, "4535333.33", 0.05),
  );
  const r2 = await repay(p.id, 5000000);
  check(
    "C10 PO 29,464,666.67",
    near(r2.repayment.principalAfterIdr, "29464666.67", 0.05),
    D(r2.repayment.principalAfterIdr).toFixed(2),
  );
  check(
    "C11 release limited by payment ≈0.075588 (not 5m basis)",
    r2.release && near(r2.release.tokenQty, "0.075588", 0.000003),
    r2.release?.tokenQty,
  );
  check(
    "C12 projected LTV ≈56.52%",
    r2.release && near(r2.release.ltvAfterBps, 5652, 3),
    r2.release?.ltvAfterBps,
  );
  p1 = await reload(p.id);
  check("C13 unpaid interest now 0", D(p1.unpaidInterestIdr).lte("0.01"));
  const evs = await LoanInterestEvent.findAll({
    where: { positionId: p.id },
    order: [["period_end_at", "ASC"]],
  });
  check(
    "C14 interest events FIRST + PRORATA, all paid",
    evs.length === 2 &&
      evs.every((e) => D(e.accrualIdr).minus(e.paidIdr).abs().lte("0.01")),
  );
}

async function scenarioD() {
  console.log("\n[D] Rp39m repayment table — 4 x 5m (Q21, Q22, Q58)");
  await cleanup();
  await setPool("1000000000");
  await fundWallet("100000000");
  await at("2026-10-09T03:00:00Z");
  await price("XAUT", "60000000");
  const p = await open({
    collateral_asset: "XAUT",
    collateral_qty: "1",
    tenor_days: 90,
    gross_loan_idr: "39000000",
  });
  const expect = [
    ["0.055555", 6000],
    ["0.083333", 5613],
    ["0.083333", 5143],
    ["0.083333", 4560],
  ];
  for (let i = 0; i < 4; i += 1) {
    await at(addHours("2026-10-09T03:00:00Z", (i + 1) * 24));
    const r = await repay(p.id, 5000000);
    check(
      `D${i + 1} release ${expect[i][0]} / LTV ${expect[i][1] / 100}%`,
      r.release &&
        near(r.release.tokenQty, expect[i][0], 0.000002) &&
        near(r.release.ltvAfterBps, expect[i][1], 2),
      `${r.release?.tokenQty} / ${r.release?.ltvAfterBps}`,
    );
  }
  const r = await reload(p.id);
  check(
    "D5 PO 19m, locked ≈0.694446",
    D(r.principalOutstandingIdr).eq(19000000) &&
      near(r.lockedQty, "0.694446", 0.00001),
    D(r.lockedQty).toFixed(6),
  );
}

async function scenarioE() {
  console.log(
    "\n[E] Maturity -> 3-day cure -> PDP -> auto liquidation 5% haircut (Q12-Q15, Q27, Q28)",
  );
  await cleanup();
  await setPool("1000000000", "20000000");
  await fundWallet("100000000");
  await at("2026-10-09T03:00:00Z");
  await price("XAUT", "60000000");
  const p = await open({
    collateral_asset: "XAUT",
    collateral_qty: "1",
    tenor_days: 90,
    gross_loan_idr: "39000000",
  });
  // Maturity 7 Jan 2027 03:00Z. HF @60m sehat -> cure.
  await at("2027-01-07T03:00:01Z");
  await runTick();
  let r = await reload(p.id);
  check(
    "E1 PAST_DUE with cure",
    r.status === "PAST_DUE" && r.cureEligible === true,
    r.status,
  );
  check(
    "E2 cure ends maturity + 3d",
    r.cureEndsAt &&
      new Date(r.cureEndsAt).getTime() === addDays(r.maturityAt, 3).getTime(),
  );
  check(
    "E3 3 anniversaries posted (9 Nov, 9 Dec, 7 Jan prorata not yet)",
    Number(r.lastAnniversaryIndex) === 2,
    r.lastAnniversaryIndex,
  );
  check("E4 PO at maturity snapshot = 39m", D(r.poAtMaturityIdr).eq(39000000));
  check("E5 no PDP at instant maturity", Number(r.pdpDaysCharged) === 0);
  await at("2027-01-08T03:00:02Z");
  await runTick();
  r = await reload(p.id);
  check(
    "E6 PDP day1 = 19,500",
    Number(r.pdpDaysCharged) === 1 && near(r.pdpAccruedIdr, 19500, 0.01),
    D(r.pdpAccruedIdr).toFixed(2),
  );
  await at("2027-01-10T03:00:03Z");
  await runTick();
  r = await reload(p.id);
  check(
    "E7 cure expired -> AUTO_LIQUIDATED",
    r.status === "AUTO_LIQUIDATED",
    r.status,
  );
  check(
    "E8 PDP capped 3 days = 58,500",
    near(r.pdpAccruedIdr, 58500, 0.01),
    D(r.pdpAccruedIdr).toFixed(2),
  );
  const liq = await LoanLiquidation.findOne({ where: { positionId: p.id } });
  check(
    "E9 trigger CURE_EXPIRED, state EXECUTED",
    liq.triggerType === "CURE_EXPIRED" && liq.state === "EXECUTED",
    `${liq.triggerType}/${liq.state}`,
  );
  // TDD = 39m + interest(390k + 390k + prorata 29d/31d x 390k≈364,838.71 + cure days) + PDP 58.5k
  const tdd = D(liq.totalDebtDueIdr);
  check(
    "E10 TDD includes principal + interest + PDP",
    tdd.gt(39000000 + 780000 + 58500),
    tdd.toFixed(2),
  );
  check(
    "E11 haircut 5% -> conservative price 57m",
    D(liq.conservativePriceIdr).eq(57000000),
  );
  const expectAlloc = tdd.div(57000000).toDecimalPlaces(6);
  check(
    "E12 debt alloc = TDD / 57m",
    near(liq.debtAllocQty, expectAlloc, 0.000001),
    `${liq.debtAllocQty} vs ${expectAlloc}`,
  );
  check("E13 compensation 0.01", D(liq.compensationQty).eq("0.01"));
  check(
    "E14 invariant refund + treasury == locked",
    D(liq.refundQty).plus(liq.treasuryQty).eq(liq.lockedQty),
  );
  const lots = await LoanTreasuryLot.findAll({
    where: { liquidationId: liq.id },
  });
  check(
    "E15 treasury lots: DEBT_RECOVERY + COMPENSATION",
    lots.length === 2 &&
      lots.some((l) => l.lotType === "DEBT_RECOVERY") &&
      lots.some((l) => l.lotType === "COMPENSATION"),
  );
  const refund = await LoanCollateralRelease.findOne({
    where: { positionId: p.id, kind: "LIQUIDATION_REFUND" },
  });
  check(
    "E16 refund release CONFIRMED",
    refund &&
      refund.state === "CONFIRMED" &&
      D(refund.tokenQty).eq(liq.refundQty),
  );
  check(
    "E17 position closed: PO 0, locked 0, settledQty 1",
    D(r.principalOutstandingIdr).eq(0) &&
      D(r.lockedQty).eq(0) &&
      D(r.settledQty).eq(1),
  );
  const pool = await LoanPool.findByPk(1);
  check(
    "E18 pool advance recorded = TDD, onloan back to 0",
    near(pool.outstandingAdvanceIdr, tdd, 0.01) &&
      D(pool.onloanPrincipalIdr).eq(0),
  );
  const dash = await admin.treasuryDashboard(await now());
  check(
    "E19 treasury dashboard BEP = advance / debt qty",
    near(
      dash.per_asset.XAUT.portfolio_recovery_bep_idr,
      tdd.div(liq.debtAllocQty),
      1,
    ),
    dash.per_asset.XAUT.portfolio_recovery_bep_idr,
  );
  // Treasury sell at 60m -> proceeds menutup advance
  const lot = lots.find((l) => l.lotType === "DEBT_RECOVERY");
  const sale = await admin.recordTreasurySale(
    {
      lot_id: lot.id,
      qty: lot.qtyRemaining,
      net_proceeds_idr: D(lot.qtyRemaining).mul(60000000).toFixed(0),
    },
    "e2e",
    await now(),
  );
  const pool2 = await LoanPool.findByPk(1);
  check(
    "E20 sale closes advance; capital unchanged (not fresh lending capital)",
    D(pool2.outstandingAdvanceIdr).lte("0.01") &&
      D(pool2.eligibleLendingCapitalIdr).eq(1000000000),
    `${pool2.outstandingAdvanceIdr}`,
  );
  check("E21 realized pnl = (60m-60m)*q = 0", near(sale.pnl_idr, 0, 0.01));
}

async function scenarioF() {
  console.log(
    "\n[F] XAUT 4h observation: trigger 75%, rebound, consumed; second hit -> immediate (Q16, Q18, Q24)",
  );
  await cleanup();
  await setPool("1000000000");
  await fundWallet("100000000");
  await at("2026-10-09T03:00:00Z");
  await price("XAUT", "60000000");
  const p = await open({
    collateral_asset: "XAUT",
    collateral_qty: "1",
    tenor_days: 90,
    gross_loan_idr: "39000000",
  });
  // LTV 75% -> price 52m (39/52 = 75%)
  await at("2026-10-10T03:00:00Z");
  await price("XAUT", "52000000");
  await runTick();
  let r = await reload(p.id);
  check(
    "F1 LIQUIDATION_OBSERVATION, observation_used",
    r.status === "LIQUIDATION_OBSERVATION" && r.observationUsed === true,
    r.status,
  );
  const endsAt = new Date(r.observationEndsAt);
  check(
    "F2 window = 4h",
    endsAt.getTime() === addHours("2026-10-10T03:00:00Z", 4).getTime(),
  );
  // drawdown blocked during observation
  const e1 = await expectError(async () =>
    svc.drawdown({
      coreId: CORE_ID,
      positionId: p.id,
      body: { gross_loan_idr: "250000", idempotency_key: ik() },
      now: await now(),
    }),
  );
  check(
    "F3 additional borrowing blocked (RISK_LOCKED)",
    e1?.code === "RISK_LOCKED",
    e1?.code,
  );
  // rebound after 5 min
  await at("2026-10-10T03:05:00Z");
  await price("XAUT", "60000000");
  await runTick();
  r = await reload(p.id);
  check(
    "F4 RECOVERING, timer continues",
    r.status === "RECOVERING" &&
      new Date(r.observationEndsAt).getTime() === endsAt.getTime(),
    r.status,
  );
  // repayment allowed but release blocked in RECOVERING
  const rp = await repay(p.id, 1000000);
  check(
    "F5 repayment allowed, release blocked (risk locked)",
    D(rp.repayment.principalIdr).eq(1000000) && !rp.release,
  );
  await at("2026-10-10T07:00:01Z");
  await runTick();
  r = await reload(p.id);
  check(
    "F6 after 4h healthy -> ACTIVE, window consumed",
    r.status === "ACTIVE" && r.observationUsed === true && !r.observationEndsAt,
    r.status,
  );
  // second hit next week -> immediate liquidation
  await at("2026-10-17T03:00:00Z");
  await price("XAUT", "50000000");
  await runTick();
  r = await reload(p.id);
  const liq = await LoanLiquidation.findOne({ where: { positionId: p.id } });
  check(
    "F7 second hit -> liquidated immediately (REPEAT_HIT)",
    r.status === "AUTO_LIQUIDATED" && liq?.triggerType === "REPEAT_HIT",
    `${r.status}/${liq?.triggerType}`,
  );
}

async function scenarioG() {
  console.log(
    "\n[G] Observation expiry still breached -> liquidation; Emergency 78% -> immediate (Q17, Q26)",
  );
  await cleanup();
  await setPool("1000000000");
  await fundWallet("100000000");
  await at("2026-10-09T03:00:00Z");
  await price("XAUT", "60000000");
  const p = await open({
    collateral_asset: "XAUT",
    collateral_qty: "1",
    tenor_days: 90,
    gross_loan_idr: "39000000",
  });
  await at("2026-10-10T03:00:00Z");
  await price("XAUT", "51500000"); // 75.7%
  await runTick();
  check(
    "G1 observation started",
    (await reload(p.id)).status === "LIQUIDATION_OBSERVATION",
  );
  await at("2026-10-10T07:00:01Z");
  await runTick();
  let r = await reload(p.id);
  let liq = await LoanLiquidation.findOne({ where: { positionId: p.id } });
  check(
    "G2 after 4h still breached -> OBSERVATION_EXPIRED liquidation",
    r.status === "AUTO_LIQUIDATED" &&
      liq?.triggerType === "OBSERVATION_EXPIRED",
    `${r.status}/${liq?.triggerType}`,
  );

  // Emergency case
  await cleanup();
  await at("2026-10-09T03:00:00Z");
  await price("XAUT", "60000000");
  const p2 = await open({
    collateral_asset: "XAUT",
    collateral_qty: "1",
    tenor_days: 90,
    gross_loan_idr: "39000000",
  });
  await at("2026-10-10T03:00:00Z");
  await price("XAUT", "52000000");
  await runTick();
  check(
    "G3 observation started",
    (await reload(p2.id)).status === "LIQUIDATION_OBSERVATION",
  );
  await at("2026-10-10T03:09:00Z");
  await price("XAUT", "49000000"); // 79.6% >= 78%
  await runTick();
  r = await reload(p2.id);
  liq = await LoanLiquidation.findOne({ where: { positionId: p2.id } });
  check(
    "G4 78% in minute 9 -> EMERGENCY liquidation, window cut",
    r.status === "AUTO_LIQUIDATED" && liq?.triggerType === "EMERGENCY",
    `${r.status}/${liq?.triggerType}`,
  );
}

async function scenarioH() {
  console.log(
    "\n[H] VVLR Gold: 72% direct liquidation (no 4h), initial 60%, margin 69% (Q19, Q54)",
  );
  await cleanup();
  await setPool("1000000000");
  await fundWallet("100000000");
  await at("2026-10-12T03:00:00Z"); // Senin
  await price("GOLD", "2000000"); // per gram
  // 30 gram = 60m -> max 60% = 36m
  const e = await expectError(() =>
    open({
      collateral_asset: "VVLR",
      collateral_qty: "30",
      tenor_days: 90,
      gross_loan_idr: "36000001",
    }),
  );
  check(
    "H1 above 60% initial LTV rejected",
    e?.code === "EXCEEDS_LTV_CAPACITY",
    e?.code,
  );
  const p = await open({
    collateral_asset: "VVLR",
    collateral_qty: "30",
    tenor_days: 90,
    gross_loan_idr: "36000000",
  });
  check("H2 APR VVLR 90d = 13%", Number(p.aprBps) === 1300);
  await at("2026-10-13T03:00:00Z");
  await price("GOLD", "1720000"); // 36/51.6 = 69.8% -> margin call
  await runTick();
  check(
    "H3 MARGIN_CALL at 69.8%",
    (await reload(p.id)).status === "MARGIN_CALL",
  );
  await at("2026-10-14T03:00:00Z");
  await price("GOLD", "1660000"); // 36/49.8 = 72.3%
  await runTick();
  const r = await reload(p.id);
  const liq = await LoanLiquidation.findOne({ where: { positionId: p.id } });
  check(
    "H4 >=72% -> direct liquidation (VVLR_THRESHOLD), no observation",
    r.status === "AUTO_LIQUIDATED" &&
      liq?.triggerType === "VVLR_THRESHOLD" &&
      r.observationUsed === false,
    `${r.status}/${liq?.triggerType}`,
  );
}

async function scenarioI() {
  console.log(
    "\n[I] Caps: borrower 5% snapshot, max 2 positions, min gross, utilization (Q02-Q06, Q41-Q44, Q61)",
  );
  await cleanup();
  await setPool("100000000"); // cap 5m
  await fundWallet("100000000");
  await at("2026-10-09T03:00:00Z");
  await price("XAUT", "60000000");
  let e = await expectError(() =>
    open({
      collateral_asset: "XAUT",
      collateral_qty: "1",
      tenor_days: 90,
      gross_loan_idr: "400000",
    }),
  );
  check(
    "I1 below min 500k rejected",
    e?.code === "BELOW_MINIMUM_GROSS",
    e?.code,
  );
  e = await expectError(() =>
    open({
      collateral_asset: "XAUT",
      collateral_qty: "1",
      tenor_days: 90,
      gross_loan_idr: "5000001",
    }),
  );
  check(
    "I2 cap 5% = 5m: 5,000,001 rejected",
    e?.code === "EXCEEDS_BORROWER_CAP",
    e?.code,
  );
  const p1 = await open({
    collateral_asset: "XAUT",
    collateral_qty: "1",
    tenor_days: 90,
    gross_loan_idr: "3000000",
  });
  const cyc = await LoanBorrowerCycle.findOne({
    where: { coreId: CORE_ID, status: "OPEN" },
  });
  check("I3 cycle snapshot cap 5m", D(cyc.borrowerCapIdr).eq(5000000));
  // Pool capital naik -> snapshot user TIDAK berubah
  await setPool("1000000000");
  const q = await svc.quoteOpen({
    coreId: CORE_ID,
    body: { collateral_asset: "XAUT", collateral_qty: "1", tenor_days: 90 },
    now: await now(),
  });
  check(
    "I4 quote borrower cap remaining 2m (snapshot kept)",
    D(q.borrower_cap_remaining_idr).eq(2000000),
    q.borrower_cap_remaining_idr,
  );
  e = await expectError(() =>
    open({
      collateral_asset: "XAUT",
      collateral_qty: "1",
      tenor_days: 90,
      gross_loan_idr: "2000001",
    }),
  );
  check(
    "I5 second position aggregate cap enforced",
    e?.code === "EXCEEDS_BORROWER_CAP",
    e?.code,
  );
  const p2 = await open({
    collateral_asset: "XAUT",
    collateral_qty: "1",
    tenor_days: 180,
    gross_loan_idr: "2000000",
  });
  e = await expectError(() =>
    open({
      collateral_asset: "XAUT",
      collateral_qty: "1",
      tenor_days: 90,
      gross_loan_idr: "500000",
    }),
  );
  check(
    "I6 third position denied (MAX_POSITIONS)",
    e?.code === "MAX_POSITIONS",
    e?.code,
  );
  await settleFull(p1.id);
  const cyc2 = await LoanBorrowerCycle.findOne({
    where: { coreId: CORE_ID, status: "OPEN" },
  });
  check("I7 one of two closed -> cycle NOT reset", cyc2 && cyc2.id === cyc.id);
  // Additional drawdown on p2: price rises but cap exhausted? cap remaining = 5m - 2m = 3m
  await at("2026-10-10T03:00:00Z");
  await price("XAUT", "65000000");
  e = await expectError(async () =>
    svc.drawdown({
      coreId: CORE_ID,
      positionId: p2.id,
      body: { gross_loan_idr: "100000", idempotency_key: ik() },
      now: await now(),
    }),
  );
  check(
    "I8 additional below 250k rejected",
    e?.code === "BELOW_MINIMUM_GROSS",
    e?.code,
  );
  const dd = await svc.drawdown({
    coreId: CORE_ID,
    positionId: p2.id,
    body: { gross_loan_idr: "250000", idempotency_key: ik() },
    now: await now(),
  });
  check(
    "I9 additional 250k: fee 1,250, net 248,750, PO +250k",
    D(dd.drawdown.protocolFeeIdr).eq(1250) &&
      D(dd.drawdown.paidIdr).eq(248750) &&
      D(dd.position.principalOutstandingIdr).eq(2250000),
  );
  check(
    "I10 maturity/APR unchanged",
    Number(dd.position.tenorDays) === 180 &&
      Number(dd.position.aprBps) === 1300,
  );
  await settleFull(p2.id);
  const cyc3 = await LoanBorrowerCycle.findOne({
    where: { coreId: CORE_ID, status: "OPEN" },
  });
  check("I11 all closed -> cycle reset", !cyc3);
}

async function scenarioJ() {
  console.log(
    "\n[J] Cure terminated when HF enters margin zone; add collateral; idempotency (Q14, Q37)",
  );
  await cleanup();
  await setPool("1000000000");
  await fundWallet("100000000");
  await at("2026-10-09T03:00:00Z");
  await price("XAUT", "60000000");
  const p = await open({
    collateral_asset: "XAUT",
    collateral_qty: "1",
    tenor_days: 90,
    gross_loan_idr: "39000000",
  });
  // add collateral 0.2 -> LTV turun
  const tu = await svc.topUpCollateral({
    coreId: CORE_ID,
    positionId: p.id,
    body: { collateral_qty: "0.2", idempotency_key: "topup-1-" + p.id },
    now: await now(),
  });
  check("J1 top-up locked 1.2", D(tu.position.lockedQty).eq("1.2"));
  const tu2 = await svc.topUpCollateral({
    coreId: CORE_ID,
    positionId: p.id,
    body: { collateral_qty: "0.2", idempotency_key: "topup-1-" + p.id },
    now: await now(),
  });
  check("J2 top-up idempotent", tu2.duplicate === true);
  const k = ik();
  const r1 = await repay(p.id, 1000000, { idempotency_key: k });
  const r2 = await repay(p.id, 1000000, { idempotency_key: k });
  check(
    "J3 repayment idempotent (same key)",
    r2.duplicate === true && r1.repayment.id === r2.repayment.id,
  );
  // maturity healthy -> cure; then price drops to margin zone -> cure terminated
  await at("2027-01-07T03:00:01Z");
  await runTick();
  check("J4 cure started", (await reload(p.id)).status === "PAST_DUE");
  await at("2027-01-08T03:00:00Z");
  // PO 38m (stlh repay 1m di J3) + bunga ~1.15m -> TDD ~39.15m.
  // 45m x 1.2 = 54m -> LTV 72.5% masuk margin zone (>=72%) -> cure terminated
  await price("XAUT", "45000000");
  await runTick();
  const r = await reload(p.id);
  const liq = await LoanLiquidation.findOne({ where: { positionId: p.id } });
  check(
    "J5 cure terminated -> liquidation (CURE_TERMINATED)",
    r.status === "AUTO_LIQUIDATED" && liq?.triggerType === "CURE_TERMINATED",
    `${r.status}/${liq?.triggerType}`,
  );
}

// ============================================================

(async () => {
  try {
    await sequelize.authenticate();
    await sequelize.sync();
    console.log(`Loan E2E — core ${CORE_ID}`);
    const scenarios = {
      A: scenarioA,
      B: scenarioB,
      C: scenarioC,
      D: scenarioD,
      E: scenarioE,
      F: scenarioF,
      G: scenarioG,
      H: scenarioH,
      I: scenarioI,
      J: scenarioJ,
    };
    for (const [key, fn] of Object.entries(scenarios)) {
      if (!run(key)) continue;
      try {
        await fn();
      } catch (error) {
        results.push({ name: `scenario ${key} crashed`, ok: false });
        console.error(`  CRASH [${key}]`, error);
      }
    }
  } finally {
    await cleanup().catch(() => {});
    await businessClock
      .setClock({ mode: "REAL", updatedBy: "loan-e2e" })
      .catch(() => {});
    const failed = results.filter((r) => !r.ok);
    console.log(
      `\n==== ${results.length - failed.length}/${results.length} passed ====`,
    );
    failed.forEach((f) => console.log("  FAIL", f.name));
    await sequelize.close();
    process.exit(failed.length ? 1 : 0);
  }
})();
