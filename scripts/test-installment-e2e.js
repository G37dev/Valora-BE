/*
 * E2E test installment — semua case, Standard & Flexible.
 * Pakai service layer langsung (tanpa HTTP/JWT), plan is_test=true.
 * Clock di-set SIMULATED & dikembalikan ke REAL di akhir.
 *
 *   node scripts/test-installment-e2e.js
 */
require("dotenv").config();
const crypto = require("crypto");
const svc = require("../services/installment/installment.service");
const bc = require("../services/installment/installment.blockchain.service");
const businessClock = require("../services/businessClock");
const {
  sequelize,
  InstallmentPlan,
  InternalWallet,
  Price,
} = require("../models");

const CORE_ID = process.argv[2] || "RABv8pXT";
const ONLY = process.argv[3] || null; // "A" atau "H,I,J" buat subset
const ik = () => `e2e-${crypto.randomUUID()}`;
const results = [];

const S = {
  NONE: 0,
  ALLOCATED: 1,
  CLAIMED: 2,
  VOID: 3,
};

async function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond, extra });
  console.log(
    `${cond ? "  PASS" : "  FAIL"} ${name}${extra ? " — " + extra : ""}`,
  );
}

async function advanceTo(date) {
  await businessClock.setClock({
    mode: "SIMULATED",
    simulatedNow: date,
    updatedBy: "e2e-script",
  });
  console.log(`  >> clock -> ${new Date(date).toISOString()}`);
}

const addDays = (d, n) => new Date(new Date(d).getTime() + n * 864e5);
const addMonths = (d, n) => {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x;
};

async function touchPrices() {
  await Price.update({ updatedAt: new Date() }, { where: {} });
}

async function onchain(planId) {
  const p = await InstallmentPlan.findByPk(planId);
  return bc.readOnchainPlan(p);
}

async function plan(id) {
  return InstallmentPlan.findByPk(id);
}

async function idrBalance() {
  const w = await InternalWallet.findOne({ where: { coreId: CORE_ID } });
  return Number(w?.balanceIdr || 0);
}

async function create(body) {
  await touchPrices();
  const { plan } = await svc.createRequest({
    coreId: CORE_ID,
    body: { ...body, idempotency_key: ik() },
    now: await businessClock.current(),
    isTest: true,
  });
  console.log(
    `  plan ${plan.id} ${plan.planType} ${plan.assetCode} ${plan.goldAmount} -> ${plan.status}`,
  );
  return plan;
}

async function pay(planId, amountIdr, opts = {}) {
  const out = await svc.pay({
    coreId: opts.coreId || CORE_ID,
    planId,
    body: {
      amount_idr: String(amountIdr),
      idempotency_key: opts.key || ik(),
    },
    now: await businessClock.current(),
  });
  return out;
}

async function payExpectError(planId, amountIdr, opts = {}) {
  try {
    await pay(planId, amountIdr, opts);
    return null;
  } catch (e) {
    return e;
  }
}

async function settle(planId) {
  await svc.settlePlan(planId, await businessClock.current());
}

const { InstallmentSchedule } = require("../models");
async function scheduleDue(planId, seq) {
  const s = await InstallmentSchedule.findOne({
    where: { planId, sequence: seq },
  });
  return s ? new Date(s.dueAt) : null;
}

const run = (key) => !ONLY || ONLY.split(",").includes(key);

// ============================================================
async function main() {
  const t0 = await businessClock.current();
  console.log(
    `Core: ${CORE_ID} | clock now: ${t0.toISOString()} | IDR balance: ${await idrBalance()}`,
  );

  // ------------------------------------------------------------
  console.log(
    "\n=== A. STANDARD GOLD — full cycle: pay > overdue+penalty > finish > claim ===",
  );
  if (run("A")) {
    const p = await create({
      plan_type: "STANDARD",
      asset: "GOLD",
      gold_amount: "0.2",
      tenor_months: 3,
      installment_gap: "MONTHLY",
    });
    await check(
      "A1 activate + on-chain ALLOCATED",
      (await onchain(p.id)).status === S.ALLOCATED,
    );

    const per = Math.ceil(Number(p.standardTotalPaymentIdr) / 3);
    await pay(p.id, per);
    let c = await plan(p.id);
    await check(
      "A2 cicilan 1 dibayar",
      Number(c.grossCashPaidIdr) >= per,
      `gross=${c.grossCashPaidIdr}`,
    );

    // advance: cicilan 2 due -> +2 hari biar penalty ke-akru
    // (due schedule = 00:00 WIB day-of-month anchor, bukan activatedAt+1mo)
    await advanceTo(addDays(await scheduleDue(p.id, 2), 2));
    await settle(p.id);
    c = await plan(p.id);
    const lp = BigInt(c.latePenaltyIdr);
    await check("A3 cicilan 2 overdue + late penalty > 0", lp > 0n, `lp=${lp}`);

    // bayar cicilan 2 + penalty
    await pay(p.id, Number(BigInt(per) + lp));
    c = await plan(p.id);
    await check(
      "A4 cicilan 2 + penalty lunas",
      BigInt(c.latePenaltyIdr) === 0n && BigInt(c.latePenaltyPaidIdr) >= lp,
    );

    // bayar cicilan 3 -> fully settled
    await pay(p.id, per);
    c = await plan(p.id);
    await check(
      "A5 lunas -> COMPLETE_PENDING_CLAIM/CLAIMABLE",
      ["COMPLETE_PENDING_CLAIM", "CLAIMABLE"].includes(c.status),
      c.status,
    );

    await advanceTo(addDays(c.claimableAt, 1));
    await settle(p.id);
    c = await plan(p.id);
    await check("A6 CLAIMABLE setelah claimableAt", c.status === "CLAIMABLE");

    const claim = await svc.claim({
      coreId: CORE_ID,
      planId: p.id,
      now: await businessClock.current(),
    });
    c = await plan(p.id);
    const oc = await onchain(p.id);
    await check(
      "A7 claim -> CLOSED + releaseTxHash",
      c.status === "CLOSED" && !!c.releaseTxHash,
      claim.txHash,
    );
    await check("A8 on-chain CLAIMED", oc.status === S.CLAIMED);
    await check(
      "A9 protocol fee CHARGED",
      c.protocolFeeStatus === "CHARGED",
      `fee=${c.protocolFeeIdr}`,
    );
  }

  // ------------------------------------------------------------
  console.log(
    "\n=== B. STANDARD XAUT — cancel (0% paid) + on-chain reclaim ===",
  );
  if (run("B")) {
    const p = await create({
      plan_type: "STANDARD",
      asset: "XAUT",
      gold_amount: "0.05",
      tenor_months: 3,
      installment_gap: "MONTHLY",
    });
    await check("B1 ALLOCATED", (await onchain(p.id)).status === S.ALLOCATED);
    await svc.cancel({
      coreId: CORE_ID,
      planId: p.id,
      now: await businessClock.current(),
    });
    const c = await plan(p.id);
    await check("B2 CANCELLED", c.status === "CANCELLED");
    await check(
      "B3 on-chain VOID (reclaim)",
      (await onchain(p.id)).status === S.VOID,
    );
    await check(
      "B4 refund 0 (belum bayar)",
      BigInt(c.finalRefundIdr || 0) === 0n,
    );
  }

  // ------------------------------------------------------------
  console.log(
    "\n=== C. FLEXIBLE GOLD — DP > carrying accrue > pay > settle > claim ===",
  );
  if (run("C")) {
    const p = await create({
      plan_type: "FLEXIBLE",
      asset: "GOLD",
      gold_amount: "0.15",
      tenor_months: 3,
      dp_percent: 30,
    });
    await check(
      "C1 REQUEST_CREATED (belum bayar DP)",
      p.status === "REQUEST_CREATED",
    );

    const dp = Number(p.initialPaymentIdr);
    await pay(p.id, dp);
    let c = await plan(p.id);
    await check("C2 ACTIVE setelah DP", c.status === "ACTIVE");
    await check(
      "C3 on-chain ALLOCATED",
      (await onchain(p.id)).status === S.ALLOCATED,
    );

    // carrying bulan 1
    await advanceTo(addDays(addMonths(c.activatedAt, 1), 1));
    await settle(p.id);
    c = await plan(p.id);
    const ac = BigInt(c.accruedCarryingIdr);
    await check("C4 carrying ter-akru", ac > 0n, `ac=${ac}`);

    // lunas semua obligation -> settle
    const obligation = BigInt(c.principalOutstandingIdr) + ac;
    await pay(p.id, Number(obligation));
    c = await plan(p.id);
    await check(
      "C5 lunas -> pending claim",
      ["COMPLETE_PENDING_CLAIM", "CLAIMABLE"].includes(c.status),
      c.status,
    );

    await advanceTo(addDays(c.claimableAt, 1));
    await settle(p.id);
    const claim = await svc.claim({
      coreId: CORE_ID,
      planId: p.id,
      now: await businessClock.current(),
    });
    c = await plan(p.id);
    await check(
      "C6 claim -> CLOSED",
      c.status === "CLOSED" && !!claim.txHash,
      claim.txHash,
    );
  }

  // ------------------------------------------------------------
  console.log("\n=== D. FLEXIBLE — request expired (4 jam tanpa DP) ===");
  if (run("D")) {
    const p = await create({
      plan_type: "FLEXIBLE",
      asset: "XAUT",
      gold_amount: "0.03",
      tenor_months: 3,
      dp_percent: 30,
    });
    await advanceTo(addDays(p.requestExpiresAt, 1));
    await settle(p.id);
    const c = await plan(p.id);
    await check("D1 REQUEST_EXPIRED", c.status === "REQUEST_EXPIRED");
  }

  // ------------------------------------------------------------
  console.log(
    "\n=== E. FLEXIBLE — past due + restructure (PC>80%) + fee > settle > claim ===",
  );
  if (run("E")) {
    const p = await create({
      plan_type: "FLEXIBLE",
      asset: "GOLD",
      gold_amount: "0.2",
      tenor_months: 3,
      dp_percent: 50,
    });
    const dp = Number(p.initialPaymentIdr);
    await pay(p.id, dp);

    // bayar tambahan sampai >80% LPV (epp), sisakan outstanding kecil
    const lpv = BigInt(p.lockedPlanValueIdr);
    const target = (lpv * 85n) / 100n;
    const extra = target - BigInt(dp);
    if (extra > 0n) await pay(p.id, Number(extra));

    // lewat maturity -> PAST_DUE (outstanding masih ada)
    let c = await plan(p.id);
    await advanceTo(addDays(c.maturityAt, 1));
    await settle(p.id);
    c = await plan(p.id);
    const pdp = BigInt(c.pastDuePenaltyIdr);
    await check(
      "E1 PAST_DUE + penalty > 0",
      c.status === "PAST_DUE" && pdp > 0n,
      `pdp=${pdp}`,
    );

    // restructure
    const r = await svc.restructure({
      coreId: CORE_ID,
      planId: p.id,
      now: await businessClock.current(),
    });
    c = await plan(p.id);
    await check(
      "E2 RESTRUCTURED + fee",
      c.status === "RESTRUCTURED" && r.result.fee > 0n,
      `fee=${r.result.fee}, ext=${r.result.extension}mo`,
    );

    // lunas settlement penuh
    const obligation =
      BigInt(c.principalOutstandingIdr) +
      BigInt(c.accruedCarryingIdr) +
      pdp +
      BigInt(c.restructureFeeIdr);
    await pay(p.id, Number(obligation));
    c = await plan(p.id);
    await check(
      "E3 settlement -> pending claim",
      ["COMPLETE_PENDING_CLAIM", "CLAIMABLE"].includes(c.status),
      c.status,
    );

    await advanceTo(addDays(c.claimableAt, 1));
    await settle(p.id);
    const claim = await svc.claim({
      coreId: CORE_ID,
      planId: p.id,
      now: await businessClock.current(),
    });
    c = await plan(p.id);
    await check(
      "E4 claim -> CLOSED",
      c.status === "CLOSED" && !!claim.txHash,
      claim.txHash,
    );
  }

  // ------------------------------------------------------------
  console.log(
    "\n=== F. FLEXIBLE — auto liquidation (PAST_DUE > cure habis) + reclaim ===",
  );
  if (run("F")) {
    const p = await create({
      plan_type: "FLEXIBLE",
      asset: "GOLD",
      gold_amount: "0.15",
      tenor_months: 3,
      dp_percent: 30,
    });
    await pay(p.id, Number(p.initialPaymentIdr));
    let c = await plan(p.id);
    await advanceTo(addDays(c.maturityAt, 1));
    await settle(p.id);
    c = await plan(p.id);
    await check("F1 PAST_DUE", c.status === "PAST_DUE", `cure=${c.cureEndsAt}`);

    await advanceTo(addDays(c.cureEndsAt, 1));
    await settle(p.id);
    c = await plan(p.id);
    await check("F2 AUTO_LIQUIDATED", c.status === "AUTO_LIQUIDATED");
    await check(
      "F3 refund > 0 ke wallet",
      BigInt(c.finalRefundIdr || 0) > 0n,
      `refund=${c.finalRefundIdr}`,
    );
    await check("F4 on-chain VOID", (await onchain(p.id)).status === S.VOID);
  }

  // ------------------------------------------------------------
  console.log("\n=== G. Claim edge cases ===");
  if (run("G")) {
    // claim ulang -> idempotent
    const claimed = await InstallmentPlan.findOne({
      where: { status: "CLOSED" },
      order: [["updated_at", "DESC"]],
    });
    if (claimed?.releaseTxHash) {
      const dup = await svc.claim({
        coreId: CORE_ID,
        planId: claimed.id,
        now: await businessClock.current(),
      });
      await check("G1 re-claim idempotent", dup.duplicate === true);
    }
    // claim plan non-claimable -> 409
    const p = await create({
      plan_type: "STANDARD",
      asset: "GOLD",
      gold_amount: "0.15",
      tenor_months: 3,
      installment_gap: "MONTHLY",
    });
    try {
      await svc.claim({
        coreId: CORE_ID,
        planId: p.id,
        now: await businessClock.current(),
      });
      await check("G2 claim ACTIVE plan -> reject", false, "no error thrown");
    } catch (e) {
      await check("G2 claim ACTIVE plan -> reject", e.status === 409, e.code);
    }
  }

  // ------------------------------------------------------------
  console.log("\n=== H. Payment edge cases (Standard GOLD 0.15) ===");
  if (run("H")) {
    const p = await create({
      plan_type: "STANDARD",
      asset: "GOLD",
      gold_amount: "0.15",
      tenor_months: 3,
      installment_gap: "MONTHLY",
    });
    await check("H0 plan is_test=true", p.isTest === true);

    let e = await payExpectError(p.id, 50000);
    await check(
      "H1 bayar <100rb -> BELOW_MINIMUM",
      e?.code === "BELOW_MINIMUM_PAYMENT",
      e?.code,
    );

    const key = ik();
    const part = await pay(p.id, 100000, { key });
    await check(
      "H2 partial payment applied",
      Number(part.payment.amountIdr) === 100000,
    );
    const s1 = await InstallmentSchedule.findOne({
      where: { planId: p.id, sequence: 1 },
    });
    await check(
      "H3 schedule PARTIAL",
      s1.status === "PARTIAL",
      `paid=${s1.paidIdr}`,
    );

    e = await payExpectError(p.id, 100000, { coreId: "FAKE-USER-XXX" });
    await check(
      "H4 coreId salah -> PLAN_NOT_FOUND",
      e?.code === "PLAN_NOT_FOUND",
      e?.code,
    );

    const dup = await pay(p.id, 100000, { key });
    await check("H5 idempotency key -> duplicate", dup.duplicate === true);

    const expiredPlan = await InstallmentPlan.findOne({
      where: { coreId: CORE_ID, status: "REQUEST_EXPIRED" },
    });
    e = await payExpectError(expiredPlan.id, 100000);
    await check(
      "H6 bayar plan expired -> INVALID_STATE",
      e?.code === "INVALID_STATE",
      e?.code,
    );

    const c0 = await plan(p.id);
    const obligation =
      BigInt(c0.principalOutstandingIdr) +
      BigInt(c0.latePenaltyIdr) +
      BigInt(c0.accruedCarryingIdr);
    const over = await pay(p.id, Number(obligation + 1000000n));
    await check(
      "H7 overpay -> applied=obligation, excess dikembalikan",
      over.excess === 1000000n,
      `excess=${over.excess}`,
    );
    const c1 = await plan(p.id);
    await check(
      "H8 plan settled",
      ["COMPLETE_PENDING_CLAIM", "CLAIMABLE"].includes(c1.status),
      c1.status,
    );
  }

  // ------------------------------------------------------------
  console.log("\n=== I. Cancel setelah bayar (Standard) ===");
  if (run("I")) {
    const bal0 = await idrBalance();
    const p1 = await create({
      plan_type: "STANDARD",
      asset: "GOLD",
      gold_amount: "0.15",
      tenor_months: 3,
      installment_gap: "MONTHLY",
    });
    const per1 = Math.ceil(Number(p1.standardTotalPaymentIdr) / 3);
    await pay(p1.id, per1); // PC ~33% <= 50%
    const r = await svc.cancel({
      coreId: CORE_ID,
      planId: p1.id,
      now: await businessClock.current(),
    });
    const c = await plan(p1.id);
    const bal1 = await idrBalance();
    await check("I1 cancel PC<=50% -> CANCELLED", c.status === "CANCELLED");
    const rate = BigInt(r.result?.rateBps ?? r.rateBps ?? 0);
    await check(
      "I2 compensation 300-600bps",
      rate >= 300n && rate <= 600n,
      `rate=${rate}`,
    );
    await check(
      "I3 refund kredit ke wallet",
      BigInt(c.finalRefundIdr) > 0n &&
        bal1 === bal0 - per1 + Number(c.finalRefundIdr),
      `refund=${c.finalRefundIdr}`,
    );
    await check("I4 on-chain VOID", (await onchain(p1.id)).status === S.VOID);

    const p2 = await create({
      plan_type: "STANDARD",
      asset: "GOLD",
      gold_amount: "0.15",
      tenor_months: 3,
      installment_gap: "MONTHLY",
    });
    const per2 = Math.ceil(Number(p2.standardTotalPaymentIdr) / 3);
    await pay(p2.id, per2 * 2); // PC ~66% > 50%
    let e = null;
    try {
      await svc.cancel({
        coreId: CORE_ID,
        planId: p2.id,
        now: await businessClock.current(),
      });
    } catch (x) {
      e = x;
    }
    await check(
      "I5 cancel PC>50% -> reject",
      e?.code === "CANCELLATION_NOT_AVAILABLE",
      e?.code,
    );
  }

  // ------------------------------------------------------------
  console.log("\n=== J. Late penalty cap 200bps (Standard) ===");
  if (run("J")) {
    const p = await create({
      plan_type: "STANDARD",
      asset: "GOLD",
      gold_amount: "0.15",
      tenor_months: 3,
      installment_gap: "MONTHLY",
    });
    // maju 45 hari setelah due cicilan 1: daily 5bps mentok cap 200bps di hari 40
    await advanceTo(addDays(await scheduleDue(p.id, 1), 45));
    await settle(p.id);
    const c = await plan(p.id);
    const sch = await InstallmentSchedule.findOne({
      where: { planId: p.id, sequence: 1 },
    });
    // cap 200bps itu PER SCHEDULE — sched lain ikut overdue, jadi cek sched1
    // mentok cap. Engine pakai bpsOf round-half-up (sama kayak semua kalkulasi).
    const cap = (BigInt(sch.amountIdr) * 200n + 5000n) / 10000n;
    const charged = BigInt(sch.latePenaltyChargedIdr);
    await check(
      "J1 sched1 lp = cap 200bps",
      charged === cap,
      `charged=${charged} cap=${cap}`,
    );
  }

  // ------------------------------------------------------------
  console.log(
    "\n=== K. Standard -> PAST_DUE -> full settlement only -> AUTO_LIQUIDATED ===",
  );
  if (run("K")) {
    const p = await create({
      plan_type: "STANDARD",
      asset: "GOLD",
      gold_amount: "0.15",
      tenor_months: 3,
      installment_gap: "MONTHLY",
    });
    const per = Math.ceil(Number(p.standardTotalPaymentIdr) / 3);
    await pay(p.id, per); // bayar cicilan 1 aja, sisanya default

    let c = await plan(p.id);
    await advanceTo(addDays(c.maturityAt, 1));
    await settle(p.id);
    c = await plan(p.id);
    const pdp = BigInt(c.pastDuePenaltyIdr);
    await check(
      "K1 PAST_DUE + pdp>0",
      c.status === "PAST_DUE" && pdp > 0n,
      `pdp=${pdp}`,
    );

    const e = await payExpectError(p.id, 100000); // partial saat cure -> reject
    await check(
      "K2 partial saat PAST_DUE -> FULL_SETTLEMENT_REQUIRED",
      e?.code === "FULL_SETTLEMENT_REQUIRED",
      e?.code,
    );

    await advanceTo(addDays(c.cureEndsAt, 1));
    await settle(p.id);
    c = await plan(p.id);
    await check("K3 AUTO_LIQUIDATED", c.status === "AUTO_LIQUIDATED");
    await check(
      "K4 refund>0 (pernah bayar 1 cicilan)",
      BigInt(c.finalRefundIdr) > 0n,
      `refund=${c.finalRefundIdr}`,
    );
    await check("K5 on-chain VOID", (await onchain(p.id)).status === S.VOID);
  }

  // ------------------------------------------------------------
  console.log("\n=== L. Restructure rejects + H3 reminder (Flexible) ===");
  if (run("L")) {
    // L1-L3: reject cases
    const p1 = await create({
      plan_type: "FLEXIBLE",
      asset: "GOLD",
      gold_amount: "0.15",
      tenor_months: 3,
      dp_percent: 30,
    });
    await pay(p1.id, Number(p1.initialPaymentIdr)); // ACTIVE, PC~30%

    let e = null;
    try {
      await svc.restructure({
        coreId: CORE_ID,
        planId: p1.id,
        now: await businessClock.current(),
      });
    } catch (x) {
      e = x;
    }
    await check(
      "L1 restructure ACTIVE (bukan PAST_DUE) -> reject",
      e?.code === "RESTRUCTURE_NOT_AVAILABLE",
      e?.code,
    );

    const pStd = await plan(
      (
        await InstallmentPlan.findOne({
          where: { coreId: CORE_ID, planType: "STANDARD", status: "ACTIVE" },
        })
      )?.id || "x",
    );
    if (pStd) {
      e = null;
      try {
        await svc.restructure({
          coreId: CORE_ID,
          planId: pStd.id,
          now: await businessClock.current(),
        });
      } catch (x) {
        e = x;
      }
      await check(
        "L2 restructure plan STANDARD -> reject",
        e?.code === "RESTRUCTURE_NOT_AVAILABLE",
        e?.code,
      );
    }

    let c = await plan(p1.id);
    await advanceTo(addDays(c.maturityAt, 1));
    await settle(p1.id);
    c = await plan(p1.id);
    e = null;
    try {
      await svc.restructure({
        coreId: CORE_ID,
        planId: p1.id,
        now: await businessClock.current(),
      });
    } catch (x) {
      e = x;
    }
    await check(
      "L3 restructure PC<=80% -> NOT_ELIGIBLE",
      e?.code === "RESTRUCTURE_NOT_ELIGIBLE",
      e?.code,
    );

    // biar rapi: likuidasiin p1 juga
    await advanceTo(addDays(c.cureEndsAt, 1));
    await settle(p1.id);
    c = await plan(p1.id);
    await check(
      "L4 plan reject-restructure -> AUTO_LIQUIDATED",
      c.status === "AUTO_LIQUIDATED",
    );

    // L5: H3 reminder setelah restructure sukses
    const p2 = await create({
      plan_type: "FLEXIBLE",
      asset: "GOLD",
      gold_amount: "0.15",
      tenor_months: 3,
      dp_percent: 50,
    });
    await pay(p2.id, Number(p2.initialPaymentIdr));
    const lpv2 = BigInt(p2.lockedPlanValueIdr);
    const extra2 = (lpv2 * 85n) / 100n - BigInt(p2.initialPaymentIdr);
    await pay(p2.id, Number(extra2));
    c = await plan(p2.id);
    await advanceTo(addDays(c.maturityAt, 1));
    await settle(p2.id);
    await svc.restructure({
      coreId: CORE_ID,
      planId: p2.id,
      now: await businessClock.current(),
    });
    c = await plan(p2.id);
    const h3At = addDays(c.restructureMaturityAt, -3);
    await advanceTo(addDays(h3At, 1));
    await settle(p2.id);
    c = await plan(p2.id);
    await check(
      "L5 H3 reminder ke-record",
      !!c.h3NotifiedAt,
      `h3At=${c.h3NotifiedAt}`,
    );

    // lunasin + claim biar token balik
    const obl =
      BigInt(c.principalOutstandingIdr) +
      BigInt(c.accruedCarryingIdr) +
      BigInt(c.pastDuePenaltyIdr) +
      BigInt(c.restructureFeeIdr);
    await pay(p2.id, Number(obl));
    c = await plan(p2.id);
    await advanceTo(addDays(c.claimableAt, 1));
    await settle(p2.id);
    const cl = await svc.claim({
      coreId: CORE_ID,
      planId: p2.id,
      now: await businessClock.current(),
    });
    await check(
      "L6 restructured plan settle+claim -> CLOSED",
      !!cl.txHash,
      cl.txHash,
    );
  }

  // ------------------------------------------------------------
  console.log("\n=== M. Flexible DP edge: partial reject + overpay ===");
  if (run("M")) {
    const p = await create({
      plan_type: "FLEXIBLE",
      asset: "GOLD",
      gold_amount: "0.15",
      tenor_months: 3,
      dp_percent: 30,
    });
    await check(
      "M0 REQUEST_CREATED -> on-chain NONE",
      (await onchain(p.id)).status === S.NONE,
    );

    const dp = Number(p.initialPaymentIdr);
    const e = await payExpectError(p.id, dp - 1000);
    await check(
      "M1 DP kurang -> INITIAL_PAYMENT_MISMATCH",
      e?.code === "INITIAL_PAYMENT_MISMATCH",
      e?.code,
    );

    const bal0 = await idrBalance();
    const out = await pay(p.id, dp + 100000); // overpay DP
    const bal1 = await idrBalance();
    await check(
      "M2 overpay DP -> applied=DP saja",
      Number(out.payment.amountIdr) === dp && bal0 - bal1 === dp,
      `applied=${out.payment.amountIdr}`,
    );
    const c = await plan(p.id);
    await check("M3 ACTIVE setelah DP", c.status === "ACTIVE");
  }

  // ------------------------------------------------------------
  console.log("\n=== N. Claim/cancel rejects + insufficient balance ===");
  if (run("N")) {
    const cancelled = await InstallmentPlan.findOne({
      where: { coreId: CORE_ID, status: "CANCELLED" },
    });
    let e = null;
    try {
      await svc.claim({
        coreId: CORE_ID,
        planId: cancelled.id,
        now: await businessClock.current(),
      });
    } catch (x) {
      e = x;
    }
    await check(
      "N1 claim plan CANCELLED -> NOT_CLAIMABLE",
      e?.code === "NOT_CLAIMABLE",
      e?.code,
    );

    e = null;
    try {
      await svc.cancel({
        coreId: CORE_ID,
        planId: cancelled.id,
        now: await businessClock.current(),
      });
    } catch (x) {
      e = x;
    }
    await check(
      "N2 cancel plan CANCELLED -> reject",
      e?.code === "CANCELLATION_NOT_AVAILABLE",
      e?.code,
    );

    e = null;
    try {
      await svc.claim({
        coreId: "FAKE-USER-XXX",
        planId: cancelled.id,
        now: await businessClock.current(),
      });
    } catch (x) {
      e = x;
    }
    await check(
      "N3 claim plan orang lain -> PLAN_NOT_FOUND",
      e?.code === "PLAN_NOT_FOUND",
      e?.code,
    );

    // plan 3 GOLD -> cicilan ~2.6jt > saldo ~2jt -> debit gagal, plan nggak berubah
    const p = await create({
      plan_type: "STANDARD",
      asset: "GOLD",
      gold_amount: "3",
      tenor_months: 3,
      installment_gap: "MONTHLY",
    });
    const per = Math.ceil(Number(p.standardTotalPaymentIdr) / 3);
    const before = await idrBalance();
    e = await payExpectError(p.id, per);
    await check(
      "N4 bayar > saldo -> INSUFFICIENT_BALANCE",
      e?.code === "INSUFFICIENT_BALANCE",
      e?.code,
    );
    const c = await plan(p.id);
    await check(
      "N5 plan tetap ACTIVE + saldo utuh",
      c.status === "ACTIVE" &&
        (await idrBalance()) === before &&
        BigInt(c.grossCashPaidIdr) === 0n,
    );
  }

  // ------------------------------------------------------------
  await businessClock.setClock({ mode: "REAL", updatedBy: "e2e-script" });
  console.log("\n>> clock kembali REAL");

  const fails = results.filter((r) => !r.ok);
  console.log(
    `\n================ ${results.length - fails.length}/${results.length} PASS ================`,
  );
  if (fails.length) {
    for (const f of fails) console.log(`  FAIL: ${f.name} ${f.extra}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch(async (e) => {
  console.error("FATAL:", e);
  try {
    await businessClock.setClock({ mode: "REAL", updatedBy: "e2e-script" });
  } catch {}
  process.exit(1);
});
