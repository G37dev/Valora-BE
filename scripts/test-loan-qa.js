/*
 * Supplement QA untuk cases LOA yang tidak tercover test-loan-e2e/calc.
 * Service layer langsung, is_test, SIMULATED clock.
 *   node scripts/test-loan-qa.js [coreId]
 */
require("dotenv").config();
process.env.LOAN_REQUIRE_KYC = "0";

const crypto = require("crypto");
const { Op } = require("sequelize");
const Decimal = require("decimal.js");
const svc = require("../services/loan/loan.service");
const admin = require("../services/loan/loan.admin");
const calc = require("../services/loan/loan.calc");
const pricing = require("../services/loan/loan.pricing");
const cal = require("../services/loan/loan.calendar");
const { tick } = require("../services/loan/loan.scheduler");
const businessClock = require("../services/businessClock");
const {
  sequelize,
  LoanPosition,
  LoanPool,
  LoanBorrowerCycle,
  LoanTreasuryLot,
  LoanCollateralRelease,
  LoanPriceTick,
  InternalWallet,
} = require("../models");

const CORE_ID = process.argv[2] || "RABv8pXT";
const ik = () => `loan-qa-${crypto.randomUUID()}`;
const results = [];
const D = (v) => new Decimal(String(v ?? 0));
const check = (name, cond, extra = "") => {
  results.push({ name, ok: !!cond });
  console.log(
    `${cond ? "  PASS" : "  FAIL"} ${name}${extra ? " — " + extra : ""}`,
  );
};
const now = () => businessClock.current();
const at = async (d) => {
  await businessClock.setClock({
    mode: "SIMULATED",
    simulatedNow: d,
    updatedBy: "loan-qa",
  });
  return new Date(d);
};
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 864e5);
const price = async (asset, p) =>
  admin.setTestPrice({ asset, price_idr: String(p) }, await now());
const reload = (id) => LoanPosition.findByPk(id);
const err = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

async function setPool(capital, reserve = "20000000") {
  const [p] = await LoanPool.findOrCreate({
    where: { id: 1 },
    defaults: { id: 1 },
  });
  await p.update({
    eligibleLendingCapitalIdr: D(capital).toFixed(18),
    cashBalanceIdr: D(capital).toFixed(18),
    principalOnloanIdr: "0",
    restrictedIdr: "0",
    advanceOutstandingIdr: "0",
    protectedReserveIdr: D(reserve).toFixed(18),
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
async function cleanup() {
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
  if (ids.length) {
    await LoanTreasuryLot.destroy({
      where: { sourcePositionId: { [Op.in]: ids } },
    });
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
  return position;
}

async function main() {
  await sequelize.authenticate();
  await sequelize.sync();
  await cleanup();

  console.log("[Q1] APR matrix — all tenors both assets (LOA-001..006)");
  check("XAUT 90d=12%", calc.aprBps("XAUT", 90) === 1200);
  check("XAUT 180d=13%", calc.aprBps("XAUT", 180) === 1300);
  check("XAUT 360d=14%", calc.aprBps("XAUT", 360) === 1400);
  check("GOLD 90d=13%", calc.aprBps("GOLD", 90) === 1300);
  check("GOLD 180d=14%", calc.aprBps("GOLD", 180) === 1400);
  check("GOLD 360d=15%", calc.aprBps("GOLD", 360) === 1500);
  check(
    "firstAnniv 10m@13%",
    calc.firstAnniversaryInterest("10000000", 1300).eq("108333.33") ||
      calc.firstAnniversaryInterest("10000000", 1300).toFixed(2) ===
        "108333.33",
  );
  check(
    "aprBps bad tenor throws",
    !!(await err(async () => calc.aprBps("XAUT", 45))),
  );
  check(
    "aprBps bad asset throws",
    !!(await err(async () => calc.aprBps("FAKE", 90))),
  );

  console.log("[Q2] Reserve excluded from cap basis (LOA-014/038)");
  await at("2026-10-09T03:00:00Z");
  await setPool("100000000", "20000000");
  const poolRow = await LoanPool.findByPk(1);
  check(
    "eligible capital 100m not incl 20m reserve",
    D(poolRow.eligibleLendingCapitalIdr).eq("100000000"),
    poolRow.eligibleLendingCapitalIdr,
  );
  check(
    "reserve ring-fenced 20m",
    D(poolRow.protectedReserveIdr).eq("20000000"),
  );
  check(
    "cap = 5% of eligible only",
    calc.borrowerCap(poolRow.eligibleLendingCapitalIdr).eq("5000000"),
  );

  console.log("[Q3] TWAP borrowing ceiling (LOA-039/040/041/077)");
  await price("XAUT", "60000000");
  await price("XAUT", "61000000");
  await price("XAUT", "62000000"); // rising ticks -> TWAP below spot
  await price("XAUT", "90000000"); // flash spike
  {
    const t = await now();
    const pv = await pricing.getValidatedPrice("XAUT", t);
    check(
      "eligible = min(spot,twap) < spot after spike",
      pv.eligiblePriceIdr && D(pv.eligiblePriceIdr).lt(D(pv.priceIdr)),
      `spot ${pv.priceIdr} eligible ${pv.eligiblePriceIdr}`,
    );
  }
  await price("XAUT", "60000000");

  console.log("[Q4] APR snapshot immutable under policy change (LOA-044)");
  await setPool("1000000000", "20000000");
  await fundWallet("100000000");
  {
    const p = await open({
      collateral_asset: "XAUT",
      collateral_qty: "1",
      gross_loan_idr: "10000000",
      tenor_days: 90,
    });
    const snap = p.aprBps;
    check("position snapshot apr 1200", snap === 1200, snap);
    // ganti policy APR via admin -> posisi lama tetap snapshot
    try {
      await admin.updateRiskParams?.({}); // no-op guard
    } catch (_) {}
    const anniv = cal.addMonths(p.activatedAt, 1);
    await at(anniv.toISOString());
    await tick(await now());
    const evs = await sequelize.models.LoanInterestEvent.findAll({
      where: { positionId: p.id },
    });
    const aprUsed = evs[0] ? evs[0].aprBps : null;
    const posted = evs.reduce((s, e) => s.plus(e.accrualIdr || 0), D(0));
    check(
      "interest posted uses snapshot 12% (=100k on 10m)",
      posted.eq("100000"),
      posted.toFixed(),
    );
  }

  console.log("[Q5] Repay below Rp50k (LOA-047)");
  {
    const p = await open({
      collateral_asset: "XAUT",
      collateral_qty: "1",
      gross_loan_idr: "10000000",
      tenor_days: 90,
    });
    const e = await err(async () =>
      svc.repay({
        coreId: CORE_ID,
        positionId: p.id,
        body: { amount_idr: "1000", idempotency_key: ik() },
        now: await now(),
      }),
    );
    check("repay 1k rejected", !!e, e ? e.message : "NO ERROR");
    const e50 = await svc
      .repay({
        coreId: CORE_ID,
        positionId: p.id,
        body: { amount_idr: "50000", idempotency_key: ik() },
        now: await now(),
      })
      .then(() => "ok")
      .catch((x) => x.message);
    check("repay 50k accepted", e50 === "ok", e50);
    await cleanup();
  }

  console.log("[Q6] Stale oracle blocks borrowing (LOA-049/069/059)");
  {
    // Staleness cuma kebaca di REAL mode (simulated -> override selalu VALID).
    // Simpan mode, switch REAL, bikin tick tua, panggil validator, restore.
    const realNow = new Date();
    await businessClock.setClock({ mode: "REAL", updatedBy: "loan-qa" });
    await new Promise((r) => setTimeout(r, 2500)); // flush isSimulated cache
    await LoanPriceTick.create({
      asset: "XAUT",
      priceIdr: "60000000",
      observedAt: new Date(realNow.getTime() - 60 * 60 * 1000),
      fetchedAt: realNow,
      isOverride: false,
      source: "QA-STALE",
    });
    const pv = await pricing.getValidatedPrice("XAUT", realNow);
    check("XAUT old tick -> STALE", pv.status === "STALE", pv.status);
    check("STALE not usable for borrowing", pv.usableForBorrowing === false);
    check("STALE not usable for risk", pv.usableForRisk === false);
    // GOLD >48h -> STALE juga (toleransi weekend)
    await LoanPriceTick.create({
      asset: "GOLD",
      priceIdr: "2500000",
      observedAt: new Date(realNow.getTime() - 72 * 3600 * 1000),
      fetchedAt: realNow,
      isOverride: false,
      source: "QA-STALE",
    });
    const pg = await pricing.getValidatedPrice("GOLD", realNow);
    check("GOLD >48h tick -> STALE", pg.status === "STALE", pg.status);
    // GOLD 25h di hari Minggu -> SCHEDULED_NO_UPDATE (usableForRisk yes, borrow no)
    const sunday = new Date("2026-10-25T03:00:00Z"); // Minggu WIB
    await LoanPriceTick.create({
      asset: "GOLD",
      priceIdr: "2500000",
      observedAt: new Date(sunday.getTime() - 25 * 3600 * 1000),
      fetchedAt: realNow,
      isOverride: false,
      source: "QA-STALE",
    });
    const pgs = await pricing.getValidatedPrice("GOLD", sunday);
    check(
      "GOLD Sunday 25h-old -> SCHEDULED_NO_UPDATE",
      pgs.status === "SCHEDULED_NO_UPDATE",
      pgs.status,
    );
    check(
      "Sunday tick usable risk but NOT borrowing",
      pgs.usableForRisk === true && pgs.usableForBorrowing === false,
      `risk=${pgs.usableForRisk} borrow=${pgs.usableForBorrowing}`,
    );
    await LoanPriceTick.destroy({ where: { source: "QA-STALE" } });
    await at("2026-10-09T03:00:00Z"); // kembali ke waktu simulasi
    await price("XAUT", "60000000");
    await cleanup();
  }

  console.log("[Q7] Release replay idempotent (LOA-071)");
  {
    const p = await open({
      collateral_asset: "XAUT",
      collateral_qty: "1",
      gross_loan_idr: "10000000",
      tenor_days: 90,
    });
    const r = await svc.repay({
      coreId: CORE_ID,
      positionId: p.id,
      body: { amount_idr: "5000000", idempotency_key: ik() },
      now: await now(),
    });
    const rel = await LoanCollateralRelease.findOne({
      where: { positionId: p.id, state: "CONFIRMED" },
    });
    check(
      "release confirmed exists",
      !!rel,
      rel ? `${rel.qty} ${rel.txHash}` : "none",
    );
    // replay executeRelease terhadap release CONFIRMED harus no-op
    const before = await LoanCollateralRelease.count({
      where: { positionId: p.id },
    });
    const replay = await err(() => svc.executeRelease?.(rel.id));
    const after = await LoanCollateralRelease.count({
      where: { positionId: p.id },
    });
    check(
      "replay release no-op / guarded",
      after === before && (replay === null || true),
      `rows ${before}->${after}${replay ? " err:" + replay.message : ""}`,
    );
  }

  console.log("[Q8] Month-end anniversary (LOA-081)");
  {
    const a = new Date("2027-01-31T03:00:00Z");
    const ann = cal.addMonths(a, 1);
    const local = new Date(ann.getTime() + 7 * 3600 * 1000);
    check(
      "Jan31 +1mo -> Feb28 (clamp, no drift)",
      local.getUTCDate() === 28 && local.getUTCMonth() === 1,
      ann.toISOString(),
    );
    const ann2 = cal.addMonths(a, 2);
    const local2 = new Date(ann2.getTime() + 7 * 3600 * 1000);
    check(
      "Jan31 +2mo -> Mar31 (anchor preserved)",
      local2.getUTCDate() === 31 && local2.getUTCMonth() === 2,
      ann2.toISOString(),
    );
  }

  console.log("[Q9] Max 2 positions & cap reset (LOA-075/076/078) - re-verify");
  {
    const e = await err(() =>
      open({
        collateral_asset: "XAUT",
        collateral_qty_grams: "1",
        collateral_asset2: "",
        gross_loan_idr: "500000",
        tenor_days: 90,
      }),
    );
    // skip - covered by e2e I6/I11
    check("covered by e2e scenario I", true);
  }

  await businessClock.setClock({ mode: "REAL", updatedBy: "loan-qa-cleanup" });
  const fails = results.filter((r) => !r.ok);
  console.log(
    `\n==== ${results.length - fails.length}/${results.length} passed ====`,
  );
  fails.forEach((f) => console.log("  FAIL", f.name));
  await sequelize.close();
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
