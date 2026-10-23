/*
 * QA supplement Installment — matrix verification (INS cases) via calc.
 *   node scripts/test-installment-qa.js
 */
const c = require("../services/installment/installment.calc");
const { RULES } = require("../services/installment/installment.constants");

let fails = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  PASS" : "  FAIL"} ${name}${extra ? " — " + extra : ""}`);
};

console.log("== Standard markup matrix (INS-001..006)");
check("GOLD 3M=2.5%", c.standardMarkupBps("GOLD", 3) === 250);
check("GOLD 6M=5%", c.standardMarkupBps("GOLD", 6) === 500);
check("GOLD 12M=9.5%", c.standardMarkupBps("GOLD", 12) === 950);
check("XAUT 3M=3%", c.standardMarkupBps("XAUT", 3) === 300);
check("XAUT 6M=5.5%", c.standardMarkupBps("XAUT", 6) === 550);
check("XAUT 12M=10%", c.standardMarkupBps("XAUT", 12) === 1000);

console.log("== DP bounds (INS-007..015, 088/089)");
check("DP min 30%", RULES.DP_MIN_BPS === 3000);
check("DP max 50%", RULES.DP_MAX_BPS === 5000);

console.log("== Cancellation rate curve (INS-016..027, 081)");
const cancelExpect = [
  [3000, 300], [3100, 306], [3200, 312], [4000, 360],
  [4625, 397], [4999, 419], [5000, 420], [6000, 480],
  [7000, 540], [8000, 600], [8500, 600], [9000, 600],
];
for (const [pc, exp] of cancelExpect) {
  check(`cancelRate PC=${pc / 100}% -> ${exp}bps`, c.cancellationRateBps(pc) === exp, String(c.cancellationRateBps(pc)));
}
check("cancel allowed PC<=50% (inclusive)", RULES.CANCEL_MAX_PC_BPS === 5000);

console.log("== ALC rate curve (INS-028..039)");
const alcExpect = [
  [3000, 5000], [3100, 4920], [4000, 4200], [4625, 3700],
  [5000, 3400], [6000, 2600], [7000, 1800], [7999, 1001],
  [8000, null], [8100, null], [9000, null], [9990, null],
];
for (const [pc, exp] of alcExpect) {
  check(`alcRate PC=${pc / 100}% -> ${exp === null ? "LPV 8%" : exp + "bps"}`, c.alcRateBps(pc) === exp, String(c.alcRateBps(pc)));
}
const alc = c.autoLiquidCompensation({ pcBps: 8500, eligiblePaid: 1e6, planValue: 1e7 });
check("PC>=80% -> 8% x LPV", alc.rateBps === null && String(alc.amount) === "800000", alc.amount);

console.log("== Carrying / penalty / fee constants (INS-040,043,068,049,086,087,090)");
check("carrying 1%/mo", RULES.CARRYING_BPS === 100);
check("late penalty 5bps/day", RULES.LATE_PENALTY_DAILY_BPS === 5);
check("late cap 200bps", RULES.LATE_PENALTY_CAP_BPS === 200);
check("past-due penalty 250bps", RULES.PAST_DUE_PENALTY_BPS === 250);
check("cure 7 days", RULES.CURE_DAYS === 7);
check("restructure fee 1% PO", RULES.RESTRUCTURE_FEE_BPS === 100);
check("restructure strictly >80% PC", RULES.RESTRUCTURE_MIN_PC_BPS === 8000);
check("protocol fee 25bps claim-only", RULES.PROTOCOL_FEE_BPS === 25);
check("min payment 100k", RULES.MIN_PAYMENT_IDR === 100000n);
check("min installment 100k", RULES.MIN_INSTALLMENT_IDR === 100000n);
check("request window 4h", RULES.REQUEST_WINDOW_HOURS === 4);
const { RESTRUCTURE_EXTENSION_MONTHS } = require("../services/installment/installment.constants");
check("ext 3M->1mo", RESTRUCTURE_EXTENSION_MONTHS[3] === 1);
check("ext 6M->2mo", RESTRUCTURE_EXTENSION_MONTHS[6] === 2);
check("ext 12M->3mo", RESTRUCTURE_EXTENSION_MONTHS[12] === 3);

console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
process.exit(fails ? 1 : 0);
