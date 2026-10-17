/*
 * Unit test kalkulator Loan vs angka Developer Brief (tanpa DB).
 *   node scripts/test-loan-calc.js
 */
const c = require("../services/loan/loan.calc");
const { Decimal } = c;

let fails = 0;
function eq(name, actual, expected, tol = 0) {
  const a = new Decimal(String(actual));
  const e = new Decimal(String(expected));
  const ok = a.minus(e).abs().lte(tol);
  if (!ok) fails += 1;
  console.log(`${ok ? "  PASS" : "  FAIL"} ${name}: ${a.toFixed()} ${ok ? "" : `!= ${e.toFixed()}`}`);
}

console.log("05 Protocol fee");
eq("fee 500k", c.protocolFee("500000"), "2500");
eq("fee 5m", c.protocolFee("5000000"), "25000");
eq("fee 39m", c.protocolFee("39000000"), "195000");
eq("fee 250k", c.protocolFee("250000"), "1250");
eq("net 39m", c.disbursement("39000000").net, "38805000");

console.log("06 Interest — Example A");
eq("first anniv 10m @12%", c.firstAnniversaryInterest("10000000", 1200), "100000");
eq("first anniv 6m @12%", c.firstAnniversaryInterest("6000000", 1200), "60000");

console.log("06 Interest — Example B (26m, 11/30 days)");
const segB = c.segmentInterest("26000000", 1200, 11 * 86400, 30 * 86400);
eq("segment prorata", segB.toFixed(0), "95333", 1);
eq("payoff", new Decimal("26000000").plus("260000").plus(segB).toFixed(0), "26355333", 1);

console.log("06 Interest — Example C");
eq("first anniv 34m", c.firstAnniversaryInterest("34000000", 1200), "340000");
const segC = c.segmentInterest("34000000", 1200, 11 * 86400, 30 * 86400);
eq("prorata 34m 11/30", segC.toFixed(2), "124666.67", 0.01);
const wfC = c.waterfall("5000000", {
  pdpDue: 0,
  interestDue: new Decimal("340000").plus(segC),
  principal: "34000000",
});
eq("interest paid", wfC.interest.toFixed(2), "464666.67", 0.01);
eq("principal paid", wfC.principal.toFixed(2), "4535333.33", 0.01);
const poAfterC = new Decimal("34000000").minus(wfC.principal);
eq("PO after", poAfterC.toFixed(2), "29464666.67", 0.01);
const relC = c.doubleLimitRelease({
  debtAfter: poAfterC,
  qLocked: "0.944444",
  price: "60000000",
  postReleaseMaxBps: 6000,
  principalPaid: wfC.principal,
});
eq("Q_payment", relC.qPayment.toFixed(6), "0.075589", 0.000001);
eq("release", relC.qRelease, "0.075588", 0.000002);
eq("post LTV ~56.52%", relC.postReleaseLtvBps, 5652, 2);

console.log("07 Waterfall 5m with interest 260k");
const wf = c.waterfall("5000000", { pdpDue: 0, interestDue: "260000", principal: "39000000" });
eq("interest", wf.interest, "260000");
eq("principal", wf.principal, "4740000");

console.log("08 Double-Limit — Rp39m / 1 XAUT @60m");
let q = new Decimal(1);
let po = new Decimal("39000000");
const expectRelease = ["0.055555", "0.083333", "0.083333", "0.083333"];
const expectLtv = [6000, 5613, 5143, 4560];
for (let i = 0; i < 4; i += 1) {
  po = po.minus(5000000);
  const r = c.doubleLimitRelease({
    debtAfter: po,
    qLocked: q,
    price: "60000000",
    postReleaseMaxBps: 6000,
    principalPaid: "5000000",
  });
  eq(`rep#${i + 1} release`, r.qRelease, expectRelease[i], 0.000002);
  eq(`rep#${i + 1} post LTV`, r.postReleaseLtvBps, expectLtv[i], 2);
  q = r.qRemaining;
}
console.log("08 opening LTV 39/60");
eq("opening LTV", c.ltvBps("39000000", "60000000"), 6500);

console.log("11 HF boundaries");
const hfX = c.hfBoundaries(c.riskParams("XAUT"));
eq("XAUT initial", hfX.initial, "1.1538");
eq("XAUT margin", hfX.marginCall, "1.0417");
eq("XAUT emergency", hfX.emergency, "0.9615");
const hfG = c.hfBoundaries(c.riskParams("GOLD"));
eq("VVLR initial", hfG.initial, "1.2");
eq("VVLR margin", hfG.marginCall, "1.0435");

console.log("13 PDP");
const pdp3 = c.applyPdpCap(c.pdpForDay("39000000").mul(3), c.pdpCap("39000000"));
eq("3 days PO 39m", pdp3, "58500");

console.log("14 Liquidation split — haircut matrix");
const tdd = "40228500";
const matrix = [
  [0, "0.804570", "0.185430"],
  [300, "0.829454", "0.160546"],
  [500, "0.846916", "0.143084"],
  [700, "0.865129", "0.124871"],
];
for (const [h, alloc, refund] of matrix) {
  const s = c.liquidationSplit({ qLocked: 1, totalDebtDue: tdd, referencePrice: "50000000", haircutBps: h });
  eq(`haircut ${h / 100}% alloc`, s.qDebtAlloc, alloc);
  eq(`haircut ${h / 100}% comp`, s.qComp, "0.01");
  eq(`haircut ${h / 100}% refund`, s.qRefund, refund);
  eq(`haircut ${h / 100}% invariant`, s.qRefund.plus(s.qTreasury), 1);
}
const s57 = c.liquidationSplit({ qLocked: 1, totalDebtDue: tdd, referencePrice: "60000000", haircutBps: 500 });
eq("cure case @60m alloc", s57.qDebtAlloc, "0.705763");
eq("cure case refund", s57.qRefund, "0.284237");
eq("cure case LTV 67.05%", c.ltvBps(tdd, "60000000"), 6705, 1);
eq("5% refund IDR", c.liquidationSplit({ qLocked: 1, totalDebtDue: tdd, referencePrice: "50000000", haircutBps: 500 }).refundSpotIdr, "7154200", 100);

console.log("09 Capacity");
const cap = c.availableCapacity({
  initialLtvBps: 6500,
  lockedQty: 1,
  eligiblePrice: "65000000",
  tdd: "39000000",
  borrowerCapIdr: c.borrowerCap("780000000"),
  aggregatePoIdr: "39000000",
  utilizationHeadroomIdr: "100000000",
  availableCashIdr: "100000000",
});
eq("LTV headroom 3.25m", cap.ltvCap, "3250000");
eq("customer cap exhausted", cap.customerCap, "0");
eq("available 0", cap.available, "0");
eq("borrower cap 100m pool", c.borrowerCap("100000000"), "5000000");
eq("utilization cap 100m", c.utilizationCap("100000000"), "85000000");

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
