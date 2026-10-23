/*
 * QA Loyalty & Referral Engine — brief V1.1 section 14 (LR-001..LR-036 subset)
 * Pakai engine langsung (synthetic event envelopes, tanpa HTTP/JWT).
 * Customer uji ber-prefix LQA_ dan dibersihkan di awal run.
 *
 *   node scripts/test-loyalty-qa.js
 */
require("dotenv").config();
process.env.LOYALTY_ONCHAIN_BALANCE = "0"; // TWAB uji pakai event sintetis

const crypto = require("crypto");
const { Op } = require("sequelize");
const {
  sequelize,
  Customer,
  User,
  KycProfile,
  InternalWallet,
  InternalTransaction,
  Price,
  LOYALTY_MODELS,
  LoyaltyCustomer,
  LoyaltyReferralLink,
  LoyaltyRewardGrant,
  LoyaltyVpJournal,
  LoyaltyReferralIdrJournal,
  LoyaltyRewardClaim,
  LoyaltyTwabEvent,
  LoyaltyConfigVersion,
  LoyaltyProcessedEvent,
  LoyaltyMonthlyProgress,
  LoyaltyRewardRedemption,
  LoyaltyTierHistory,
  LoyaltyBudgetLedger,
} = require("../models");
const engine = require("../services/loyalty/loyalty.engine");
const ledger = require("../services/loyalty/loyalty.ledger");
const referral = require("../services/loyalty/loyalty.referral");
const membership = require("../services/loyalty/loyalty.membership");
const redemption = require("../services/loyalty/loyalty.redemption");
const configSvc = require("../services/loyalty/loyalty.config");
const scheduler = require("../services/loyalty/loyalty.scheduler");
const { EVENT, FEATURE } = require("../services/loyalty/loyalty.constants");

const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  console.log(
    `${cond ? "  PASS" : "  FAIL"} ${name}${extra ? " — " + extra : ""}`,
  );
}
const H = 3600 * 1000;
const D = 24 * H;
const T0 = new Date("2026-10-01T00:00:00Z"); // account creation anchor
const addMs = (d, ms) => new Date(new Date(d).getTime() + ms);
const uid = () => crypto.randomUUID();

const IDS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K"].map(
  (s) => `LQA_${s}`,
);
const [A, B, C, Dd, E, F, G, Hh, I, J, K] = IDS;

async function cleanup() {
  const where = { coreId: { [Op.like]: "LQA_%" } };
  await LoyaltyProcessedEvent.destroy({ where });
  await LoyaltyVpJournal.destroy({ where });
  await LoyaltyReferralIdrJournal.destroy({ where });
  await LoyaltyRewardRedemption.destroy({ where });
  await LoyaltyRewardClaim.destroy({ where });
  await LoyaltyRewardGrant.destroy({ where });
  await LoyaltyMonthlyProgress.destroy({ where });
  await LoyaltyTwabEvent.destroy({ where });
  await LoyaltyTierHistory.destroy({ where });
  await LoyaltyReferralLink.destroy({
    where: {
      [Op.or]: [
        { refereeCoreId: { [Op.like]: "LQA_%" } },
        { referrerCoreId: { [Op.like]: "LQA_%" } },
      ],
    },
  });
  await LoyaltyCustomer.destroy({ where });
  await InternalTransaction.destroy({ where });
  await InternalWallet.destroy({ where });
  await KycProfile.destroy({ where: { core_id: { [Op.like]: "LQA_%" } } });
  await User.destroy({ where });
  await Customer.destroy({ where });
  await LoyaltyBudgetLedger.destroy({
    where: { campaignId: { [Op.like]: "%:2026-1%" } },
  });
  await LoyaltyConfigVersion.destroy({ where: { version: { [Op.gt]: 1 } } });
}

async function mkUser(coreId, createdAt = T0) {
  await Customer.create({ coreId });
  const u = await User.create({
    coreId,
    firstName: coreId.slice(4),
    lastName: "QA",
    email: `${coreId.toLowerCase()}@qa.vivalora.test`,
  });
  await u.update({ createdAt }, { silent: true });
  await sequelize.query(
    `UPDATE users SET created_at = :c WHERE core_id = :id`,
    { replacements: { c: createdAt, id: coreId } },
  );
  await KycProfile.create({
    core_id: coreId,
    status: "VERIFIED",
    verified_at: createdAt,
  });
  await ledger.ensureCustomer(coreId, { now: createdAt });
  return u;
}

const env = (over) => {
  const clean = Object.fromEntries(
    Object.entries(over).filter(([, v]) => v !== undefined),
  );
  return {
    source_system: "qa",
    source_event_id: `qa:${uid()}`,
    occurred_at: addMs(T0, 2 * D),
    ...clean,
  };
};
const deposit = (coreId, amount, at, asset = "IDR", id) =>
  engine.ingest(
    env({
      event_type: EVENT.DEPOSIT_CONFIRMED,
      core_id: coreId,
      asset,
      amount: String(amount),
      occurred_at: at,
      source_event_id: id,
    }),
  );
const opened = (coreId, feature, ref, amt, fee, at, extra = {}) =>
  engine.ingest(
    env({
      event_type: EVENT.POSITION_OPENED,
      core_id: coreId,
      feature,
      position_ref: ref,
      qualified_amount_idr: String(amt),
      platform_fee_idr: String(fee),
      occurred_at: at,
      ...extra,
    }),
  );
const settled = (coreId, feature, ref, at, extra = {}) =>
  engine.ingest(
    env({
      event_type: EVENT.POSITION_SETTLED,
      core_id: coreId,
      feature,
      position_ref: ref,
      occurred_at: at,
      ...extra,
    }),
  );
const failed = (coreId, feature, ref, at) =>
  engine.ingest(
    env({
      event_type: EVENT.POSITION_FAILED,
      core_id: coreId,
      feature,
      position_ref: ref,
      occurred_at: at,
      reason: "QA_FAIL",
    }),
  );
const swap = (coreId, txId, fee, cost, at) =>
  engine.ingest(
    env({
      event_type: EVENT.SWAP_SETTLED,
      core_id: coreId,
      source_transaction_id: txId,
      platform_fee_idr: String(fee),
      external_cost_idr: String(cost),
      occurred_at: at,
      source_event_id: `qa:swap:${txId}`,
    }),
  );

const grant = (coreId, category) =>
  LoyaltyRewardGrant.findOne({
    where: { coreId, category },
    order: [["created_at", "DESC"]],
  });
const vp = (coreId) => ledger.vpBalances(coreId);
const idr = (coreId) => ledger.idrBalances(coreId);
const cust = (coreId) => LoyaltyCustomer.findByPk(coreId);

async function main() {
  console.log("== setup");
  for (const m of LOYALTY_MODELS) await m.sync();
  await cleanup();
  await configSvc.ensureSeed();
  configSvc.invalidate();
  const { version, config } = await configSvc.resolve(new Date());
  check(
    "config v1 seeded ACTIVE (approved baseline)",
    version >= 1 && config.referral.deposit_cap_idr === 20000,
  );
  for (const id of IDS) await mkUser(id);

  // ---------------------------------------------------------------- referral binding
  console.log("\n== referral binding (LR-004)");
  const codeA = await referral.getOrCreateCode(A);
  check(
    "A referral code generated",
    /^[A-Z2-9]{8}$/.test(codeA.code),
    codeA.code,
  );
  const bindB = await referral.bind({
    refereeCoreId: B,
    code: codeA.code,
    now: T0,
  });
  check(
    "B bound to A via code",
    bindB.created && bindB.link.referrerCoreId === A,
  );
  await referral
    .bind({ refereeCoreId: A, code: codeA.code, now: T0 })
    .then(() => check("self-referral rejected", false))
    .catch((e) => check("self-referral rejected", e.code === "REFERRAL_SELF"));
  const codeB = await referral.getOrCreateCode(B);
  await referral
    .bind({ refereeCoreId: A, code: codeB.code, now: T0 })
    .then(() => check("circular A<-B rejected", false))
    .catch((e) =>
      check("circular A<-B rejected", e.code === "REFERRAL_CIRCULAR"),
    );
  const codeC = await referral.getOrCreateCode(C);
  await referral
    .bind({ refereeCoreId: B, code: codeC.code, now: T0 })
    .then(() => check("second referrer rejected", false))
    .catch((e) =>
      check("second referrer rejected", e.code === "REFERRAL_ALREADY_BOUND"),
    );
  await referral
    .bind({ refereeCoreId: Dd, code: "NOPE1234", now: T0 })
    .then(() => check("invalid code rejected", false))
    .catch((e) =>
      check("invalid code rejected", e.code === "REFERRAL_CODE_INVALID"),
    );
  // B -> C (multi-hop): C invited by B, C deposit tidak boleh bayar A
  await referral.bind({ refereeCoreId: C, code: codeB.code, now: T0 });

  // ---------------------------------------------------------------- first deposit
  console.log("\n== first deposit & referral deposit (LR-001/002/003/034)");
  const depB = `qa:dep:B`;
  let r = await deposit(B, 20000000, addMs(T0, 2 * D), "IDR", depB);
  check(
    "B first deposit processed",
    r.status === "PROCESSED" && r.result.qualified === true,
    JSON.stringify(r.result?.reason || r.error),
  );
  let gB = await grant(B, "FIRST_DEPOSIT");
  check(
    "B First Deposit VP = 10,000 (cap) PENDING 7d",
    gB &&
      gB.vpAmount === "10000" &&
      gB.state === "PENDING" &&
      new Date(gB.availableAt).getTime() === addMs(T0, 9 * D).getTime(),
  );
  let gA = await grant(A, "REFERRAL_DEPOSIT");
  check(
    "A Referral Deposit IDR = 20,000 (cap) PENDING_VALIDATION",
    gA &&
      gA.idrAmount === "20000" &&
      gA.state === "PENDING" &&
      gA.counterpartyCoreId === B,
  );
  for (let i = 0; i < 100; i++)
    r = await deposit(B, 20000000, addMs(T0, 2 * D), "IDR", depB);
  check(
    "replay 100x same source_event_id -> DUPLICATE, 1 grant",
    r.status === "DUPLICATE" &&
      (await LoyaltyRewardGrant.count({
        where: { coreId: B, category: "FIRST_DEPOSIT" },
      })) === 1,
  );
  r = await deposit(B, 50000000, addMs(T0, 3 * D));
  check(
    "B second deposit -> no new grant (one-time)",
    r.result.reason === "NOT_FIRST_DEPOSIT" &&
      (await LoyaltyRewardGrant.count({
        where: { coreId: B, category: "FIRST_DEPOSIT" },
      })) === 1,
  );
  // C (referee of B): deposit Rp150.000 -> consumed, no VP; later 10jt no rescue; A must not get anything (no multi-hop)
  r = await deposit(C, 150000, addMs(T0, 1 * D));
  check(
    "C Rp150k first deposit -> consumed, BELOW_MINIMUM, 0 VP",
    r.result.first_deposit &&
      !r.result.qualified &&
      r.result.reason === "BELOW_MINIMUM" &&
      !(await grant(C, "FIRST_DEPOSIT")),
  );
  r = await deposit(C, 10000000, addMs(T0, 2 * D));
  check(
    "C later Rp10jt does not rescue",
    r.result.reason === "NOT_FIRST_DEPOSIT" &&
      !(await grant(C, "FIRST_DEPOSIT")),
  );
  check(
    "B (referrer of C) gets no deposit cashback from C (not qualified); A gets nothing (no multi-hop)",
    !(await grant(B, "REFERRAL_DEPOSIT")) &&
      (await LoyaltyRewardGrant.count({
        where: { coreId: A, category: "REFERRAL_DEPOSIT" },
      })) === 1,
  );
  // D: window boundary — exactly 7x24h valid, +1s invalid
  r = await deposit(Dd, 1000000, addMs(T0, 7 * D));
  check(
    "D deposit at exactly 7x24h -> valid (<=), 500 VP",
    r.result.qualified === true &&
      (await grant(Dd, "FIRST_DEPOSIT"))?.vpAmount === "500",
  );
  r = await deposit(E, 1000000, addMs(T0, 7 * D + 1000));
  check(
    "E deposit at 7x24h + 1s -> WINDOW_EXPIRED, consumed",
    !r.result.qualified &&
      r.result.reason === "WINDOW_EXPIRED" &&
      (await cust(E)).firstDepositConsumedAt,
  );
  // minor-unit precision: Rp19.999.999
  await referral.bind({ refereeCoreId: F, code: codeA.code, now: T0 });
  r = await deposit(F, 19999999, addMs(T0, 1 * D));
  const gAF = await LoyaltyRewardGrant.findOne({
    where: { coreId: A, category: "REFERRAL_DEPOSIT", counterpartyCoreId: F },
  });
  check(
    "Rp19.999.999 -> A cashback 19.999 (floor, under cap), F VP 9.999",
    gAF?.idrAmount === "19999" &&
      (await grant(F, "FIRST_DEPOSIT"))?.vpAmount === "9999",
  );
  // crypto deposit valuation
  const usdt = await Price.findOne({ where: { asset: "USDT" } });
  if (usdt) {
    // occurred_at dekat sekarang: harga harus fresh (<= price_max_age_ms) — stale -> retryable FAILED
    const gc = await LoyaltyCustomer.findByPk(G);
    await gc.update({
      accountCreatedAt: new Date(Date.now() - D),
      enrolledAt: new Date(Date.now() - D),
    });
    r = await deposit(G, "100", new Date(), "USDT");
    const expected =
      (BigInt(Math.floor(Number(usdt.priceIdr) * 100)) * 5n) / 10000n;
    check(
      `G crypto deposit 100 USDT valued via price (${usdt.priceIdr}) -> ${expected} VP`,
      r.status === "PROCESSED" &&
        (r.status !== "PROCESSED" ||
          (await grant(G, "FIRST_DEPOSIT"))?.vpAmount === expected.toString()),
      r.error || "",
    );
  } else {
    console.log("  SKIP crypto deposit valuation (no USDT price row)");
  }

  // ---------------------------------------------------------------- holds
  console.log("\n== time-based holds (LR-005 / 5.1)");
  let released = await scheduler.releaseHolds(addMs(T0, 9 * D - 1000));
  check(
    "before 7d hold: nothing released",
    (await grant(B, "FIRST_DEPOSIT")).state === "PENDING",
  );
  released = await scheduler.releaseHolds(addMs(T0, 9 * D));
  gB = await grant(B, "FIRST_DEPOSIT");
  gA = await LoyaltyRewardGrant.findOne({
    where: { coreId: A, category: "REFERRAL_DEPOSIT", counterpartyCoreId: B },
  });
  check(
    "after 7d: B VP AVAILABLE, A IDR CLAIMABLE",
    gB.state === "AVAILABLE" && gA.state === "CLAIMABLE",
    `released=${released}`,
  );
  let bal = await vp(B);
  check(
    "B VP projection available=10000 pending=0",
    bal.available === 10000n && bal.pending === 0n,
  );

  // ---------------------------------------------------------------- FQT
  console.log("\n== First Qualified Transaction (LR-006/007/008/009)");
  r = await opened(
    B,
    FEATURE.LOAN,
    "loan:qa-b1",
    10000000,
    50000,
    addMs(T0, 10 * D),
    { initial_ltv_bps: 1667, collateral_asset: "XAUT" },
  );
  check(
    "Loan 10jt LTV 16.67% -> NOT FQT eligible, slot stays UNUSED, Regular VP pending",
    r.result.fqt.eligible === false &&
      r.result.fqt.reason === "LOAN_LTV_BELOW_LOYALTY_MIN" &&
      (await cust(B)).fqtSlotState === "UNUSED" &&
      r.result.regular?.vp === "1000",
  );
  r = await opened(
    B,
    FEATURE.LOAN,
    "loan:qa-b2",
    19500000,
    97500,
    addMs(T0, 10 * D + H),
    { initial_ltv_bps: 3250, collateral_asset: "XAUT" },
  );
  const fqtB = await grant(B, "FQT");
  check(
    "Loan 19.5jt LTV 32.5% -> FQT 15,000 (cap) PENDING, slot CONSUMED_PENDING",
    fqtB?.vpAmount === "15000" &&
      fqtB.state === "PENDING" &&
      (await cust(B)).fqtSlotState === "CONSUMED_PENDING",
  );
  const actA = await grant(A, "REFERRAL_ACTIVATION");
  check(
    "A Referral Activation 0.05% x 19.5jt = 9,750 PENDING",
    actA?.idrAmount === "9750" && actA.state === "PENDING",
  );
  r = await opened(
    B,
    FEATURE.EARN,
    "earn:qa-b3",
    10000000,
    35000,
    addMs(T0, 10 * D + 2 * H),
  );
  check(
    "second qualifying Earn -> SLOT_ALREADY_CONSUMED, no second FQT",
    r.result.fqt.reason === "SLOT_ALREADY_CONSUMED" &&
      (await LoyaltyRewardGrant.count({
        where: { coreId: B, category: "FQT" },
      })) === 1,
  );
  // liquidation of first loan (non-FQT): only its regular VP void
  r = await failed(B, FEATURE.LOAN, "loan:qa-b1", addMs(T0, 20 * D));
  check(
    "loan b1 liquidated -> its Regular VP VOID",
    r.result.voided.length === 1,
  );
  // settle FQT loan
  r = await settled(B, FEATURE.LOAN, "loan:qa-b2", addMs(T0, 40 * D));
  check(
    "loan b2 settled -> FQT AVAILABLE, Regular 1,950 AVAILABLE, slot CONSUMED_AVAILABLE",
    (await grant(B, "FQT")).state === "AVAILABLE" &&
      (await cust(B)).fqtSlotState === "CONSUMED_AVAILABLE" &&
      r.result.vested.some((v) => v.category === "REGULAR" && v.vp === "1950"),
  );
  check(
    "A activation -> CLAIMABLE, link GRANTED",
    (await grant(A, "REFERRAL_ACTIVATION")).state === "CLAIMABLE" &&
      (await LoyaltyReferralLink.findOne({ where: { refereeCoreId: B } }))
        .activationState === "GRANTED",
  );
  bal = await vp(B);
  check(
    "B VP available = 10000 + 15000 + 1950 = 26,950",
    bal.available === 26950n,
    bal.available.toString(),
  );

  // F: FQT consumed then failed -> void, slot consumed, no replacement
  r = await opened(
    F,
    FEATURE.EARN,
    "earn:qa-f1",
    10000000,
    35000,
    addMs(T0, 3 * D),
  );
  check(
    "F Earn 10jt -> FQT 10,000 PENDING",
    r.result.fqt.granted_vp === "10000",
  );
  r = await failed(F, FEATURE.EARN, "earn:qa-f1", addMs(T0, 5 * D));
  check(
    "F Earn failed -> FQT VOID, slot CONSUMED_VOID, A activation VOID",
    (await grant(F, "FQT")).state === "VOID" &&
      (await cust(F)).fqtSlotState === "CONSUMED_VOID" &&
      (
        await LoyaltyRewardGrant.findOne({
          where: {
            coreId: A,
            category: "REFERRAL_ACTIVATION",
            counterpartyCoreId: F,
          },
        })
      ).state === "VOID",
  );
  r = await opened(
    F,
    FEATURE.LOAN,
    "loan:qa-f2",
    19500000,
    97500,
    addMs(T0, 6 * D),
    { initial_ltv_bps: 3250, collateral_asset: "XAUT" },
  );
  check(
    "F next qualifying Loan -> no replacement FQT",
    r.result.fqt.reason === "SLOT_ALREADY_CONSUMED",
  );

  // G: tier snapshot immutable
  r = await opened(
    G,
    FEATURE.EARN,
    "earn:qa-g1",
    5000000,
    17500,
    addMs(T0, 3 * D),
  );
  check(
    "G Cadet Earn 5jt -> FQT 5,000 PENDING (1.0x)",
    r.result.fqt.granted_vp === "5000",
  );
  await (await cust(G)).update({ currentTier: "COMMANDER" });
  r = await settled(G, FEATURE.EARN, "earn:qa-g1", addMs(T0, 33 * D));
  check(
    "G becomes Commander before maturity -> FQT still 5,000 (snapshot), Regular 350 (Cadet snapshot)",
    (await grant(G, "FQT")).vpAmount === "5000" &&
      r.result.vested.some((v) => v.category === "REGULAR" && v.vp === "350"),
  );

  // Installment: final basis below minimum -> VOID
  r = await opened(
    Hh,
    FEATURE.INSTALLMENT,
    "installment:qa-h1",
    3000000,
    0,
    addMs(T0, 3 * D),
  );
  check(
    "H Installment 3jt -> FQT 3,000 PENDING, no Regular at open (fee at claim)",
    r.result.fqt.granted_vp === "3000" && !r.result.regular,
  );
  r = await settled(
    Hh,
    FEATURE.INSTALLMENT,
    "installment:qa-h1",
    addMs(T0, 60 * D),
    { final_qualified_amount_idr: "1500000", platform_fee_idr: "7500" },
  );
  check(
    "H claim w/ realized paid 1.5jt < 2jt -> FQT VOID, slot CONSUMED_VOID, Regular 150 AVAILABLE at claim",
    (await grant(Hh, "FQT")).state === "VOID" &&
      (await cust(Hh)).fqtSlotState === "CONSUMED_VOID" &&
      r.result.regular?.vp === "150",
  );

  // ---------------------------------------------------------------- Regular VP + Monthly
  console.log("\n== Regular fee-back & Monthly milestone (LR-010/011/017/018)");
  r = await swap(I, "swap-i1", 100000, 10000, addMs(T0, 5 * D));
  check(
    "Swap fee 100k, cost 10k -> Cadet Regular 1,800 VP AVAILABLE (brief 7.3 case)",
    r.result.regular?.vp === "1800" && (await vp(I)).available === 1800n,
  );
  r = await swap(I, "swap-i1", 100000, 10000, addMs(T0, 5 * D));
  check("swap replay -> DUPLICATE", r.status === "DUPLICATE");
  for (const n of [2, 3])
    r = await swap(I, `swap-i${n}`, 15000, 2000, addMs(T0, (5 + n) * D));
  let mp = await LoyaltyMonthlyProgress.findOne({
    where: { coreId: I, monthKey: "2026-10" },
  });
  check(
    "I: 3 swaps, net fee 90k+13k+13k -> milestone ACHIEVED 3,000 VP; Cadet no booster",
    mp.milestoneState === "ACHIEVED" &&
      mp.txCount === 3 &&
      (await grant(I, "MONTHLY"))?.vpAmount === "3000" &&
      !(await grant(I, "MONTHLY_BOOSTER")),
  );
  r = await swap(I, "swap-i4", 15000, 2000, addMs(T0, 9 * D));
  check(
    "4th swap same month -> no second milestone",
    (await LoyaltyRewardGrant.count({
      where: { coreId: I, category: "MONTHLY" },
    })) === 1,
  );
  // J Junior: 3 swaps of 15k/2k each -> 39k >= 30k; Junior regular 1.25x: floor(13000*0.02*1.25)=325
  await (await cust(J)).update({ currentTier: "JUNIOR" });
  for (const n of [1, 2, 3])
    r = await swap(J, `swap-j${n}`, 15000, 2000, addMs(T0, (10 + n) * D));
  check(
    "J Junior: Regular 325/swap (1.25x), milestone 3,000 + booster 500 (no multiplier)",
    r.result.regular?.vp === "325" &&
      (await grant(J, "MONTHLY"))?.vpAmount === "3000" &&
      (await grant(J, "MONTHLY_BOOSTER"))?.vpAmount === "500",
  );
  // below fee threshold: 3 tx but fee 10k each -> net 30k... use 9k -> 27k < 30k
  for (const n of [1, 2, 3])
    r = await swap(K, `swap-k${n}`, 9000, 0, addMs(T0, (10 + n) * D));
  check(
    "K: 3 tx but net fee 27k < 30k -> no milestone",
    !(await grant(K, "MONTHLY")),
  );
  // VP discount reduces basis: gross 100k, discount 40k, cost 10k -> net 50k -> 1000 VP
  r = await engine.ingest(
    env({
      event_type: EVENT.SWAP_SETTLED,
      core_id: K,
      source_transaction_id: "swap-k9",
      platform_fee_idr: "100000",
      vp_discount_idr: "40000",
      external_cost_idr: "10000",
      occurred_at: addMs(T0, 15 * D),
    }),
  );
  check(
    "fee paid partly via VP: basis = 100k - 40k - 10k = 50k -> 1,000 VP",
    r.result.regular?.vp === "1000" &&
      r.result.regular?.net_fee_idr === "50000",
  );

  // ---------------------------------------------------------------- Claim All
  console.log("\n== Referral Claim All — atomic & idempotent (LR-005 / 14.3)");
  let aIdr = await idr(A);
  check(
    "A claimable = 20,000 + 19,999 + 9,750 = 49,749",
    aIdr.claimable === 49749n,
    aIdr.claimable.toString(),
  );
  const key = `claim-${uid()}`;
  const outs = await Promise.allSettled(
    Array.from({ length: 20 }, () =>
      referral.claimAll({
        coreId: A,
        idempotencyKey: key,
        now: addMs(T0, 41 * D),
      }),
    ),
  );
  const ok = outs.filter((o) => o.status === "fulfilled");
  const postings = await InternalTransaction.count({
    where: { coreId: A, reference: { [Op.like]: "LOYALTY-REFERRAL-CLAIM-%" } },
  });
  const claims = await LoyaltyRewardClaim.count({ where: { coreId: A } });
  const wallet = await InternalWallet.findOne({ where: { coreId: A } });
  check(
    "20 concurrent Claim All (same key) -> 1 claim, 1 wallet posting, wallet +49,749",
    postings === 1 && claims === 1 && Number(wallet.balanceIdr) === 49749,
    `fulfilled=${ok.length} postings=${postings} claims=${claims} wallet=${wallet.balanceIdr}`,
  );
  check(
    "all fulfilled responses consistent (same claim id)",
    ok.every((o) => o.value.claim.id === ok[0].value.claim.id),
  );
  aIdr = await idr(A);
  check(
    "A ledger: claimable 0, claimed 49,749",
    aIdr.claimable === 0n && aIdr.claimed === 49749n,
  );
  await referral
    .claimAll({
      coreId: A,
      idempotencyKey: `claim-${uid()}`,
      now: addMs(T0, 41 * D),
    })
    .then(() => check("second claim (new key) -> NOTHING_TO_CLAIM", false))
    .catch((e) =>
      check(
        "second claim (new key) -> NOTHING_TO_CLAIM",
        e.code === "NOTHING_TO_CLAIM",
      ),
    );
  await KycProfile.update({ status: "PENDING" }, { where: { core_id: B } });
  await LoyaltyRewardGrant.update(
    { state: "CLAIMABLE" },
    { where: { coreId: B, category: "REFERRAL_DEPOSIT" } },
  ); // none exist; sanity
  await referral
    .claimAll({ coreId: C, idempotencyKey: `claim-${uid()}` })
    .then(() => check("claim without claimable -> rejected", false))
    .catch((e) =>
      check(
        "claim without claimable -> rejected",
        ["NOTHING_TO_CLAIM", "KYC_REQUIRED"].includes(e.code),
      ),
    );
  const sum = await referral.summary(A, { now: addMs(T0, 41 * D) });
  check(
    "referral summary masks invitee names & shows claim history",
    sum.invitees.length === 2 &&
      sum.invitees.every((i) => /\*/.test(i.display_name)) &&
      sum.claims.length === 1 &&
      sum.totals.claimed_idr === "49749",
  );

  // ---------------------------------------------------------------- Redemption
  console.log("\n== Redemption (LR-012/013)");
  let q = await redemption.feeQuote({
    coreId: B,
    feeCode: "SWAP_PLATFORM",
    grossFeeIdr: 100000,
  });
  check(
    "fee-quote gross 100k -> max 40,000; redeem = min(available 26,950, 40,000) = 26,950; payable 73,050",
    q.max_discount_idr === "40000" &&
      q.redeem_vp === "26950" &&
      q.fee_payable_idr === "73050",
  );
  await (await cust(B)).update({ currentTier: "COMMANDER" });
  q = await redemption.feeQuote({
    coreId: B,
    feeCode: "SWAP_PLATFORM",
    grossFeeIdr: 100000,
  });
  check(
    "Commander cap identical 40% (no tier relaxation)",
    q.cap_bps === 4000 && q.max_discount_idr === "40000",
  );
  await redemption
    .feeQuote({ coreId: B, feeCode: "LOAN_INTEREST", grossFeeIdr: 100000 })
    .then(() => check("non-eligible fee code rejected", false))
    .catch((e) =>
      check("non-eligible fee code rejected", e.code === "FEE_NOT_ELIGIBLE"),
    );
  const rk = `red-${uid()}`;
  let res1 = await redemption.reserve({
    coreId: B,
    amountVp: 20000,
    targetType: "FEE_DISCOUNT",
    feeCode: "SWAP_PLATFORM",
    quoteSnapshot: { gross_fee_idr: 100000 },
    idempotencyKey: rk,
  });
  let res2 = await redemption.reserve({
    coreId: B,
    amountVp: 20000,
    targetType: "FEE_DISCOUNT",
    feeCode: "SWAP_PLATFORM",
    quoteSnapshot: { gross_fee_idr: 100000 },
    idempotencyKey: rk,
  });
  bal = await vp(B);
  check(
    "reserve 20,000 (idempotent replay) -> available 6,950 reserved 20,000",
    res2.replay && bal.available === 6950n && bal.reserved === 20000n,
  );
  await redemption.release({
    redemptionId: res1.redemption.id,
    coreId: B,
    reason: "PRODUCT_FAILED",
  });
  bal = await vp(B);
  check(
    "release -> available back to 26,950, reserved 0",
    bal.available === 26950n && bal.reserved === 0n,
  );
  res1 = await redemption.reserve({
    coreId: B,
    amountVp: 20000,
    targetType: "FEE_DISCOUNT",
    feeCode: "SWAP_PLATFORM",
    quoteSnapshot: { gross_fee_idr: 100000 },
    idempotencyKey: `red-${uid()}`,
  });
  await redemption.commit({ redemptionId: res1.redemption.id, coreId: B });
  await redemption.commit({ redemptionId: res1.redemption.id, coreId: B });
  bal = await vp(B);
  check(
    "commit (idempotent) -> redeemed 20,000, available 6,950",
    bal.redeemed === 20000n && bal.available === 6950n && bal.reserved === 0n,
  );
  await redemption
    .reserve({
      coreId: B,
      amountVp: 50000,
      targetType: "FEE_DISCOUNT",
      feeCode: "SWAP_PLATFORM",
      quoteSnapshot: { gross_fee_idr: 100000 },
      idempotencyKey: `red-${uid()}`,
    })
    .then(() => check("over-cap reserve rejected", false))
    .catch((e) =>
      check(
        "over-cap / insufficient reserve rejected",
        ["DISCOUNT_CAP_EXCEEDED", "INSUFFICIENT_VP"].includes(e.code),
      ),
    );

  // ---------------------------------------------------------------- TWAB
  console.log("\n== Membership TWAB (LR-015/016/029)");
  const nowT = addMs(T0, 60 * D);
  const mk = (coreId, at, qb) =>
    LoyaltyTwabEvent.create({
      coreId,
      eventAt: at,
      eligibleAssetsIdr: qb,
      liabilitiesIdr: 0,
      qualifiedBalanceIdr: qb,
      sourceEventId: `qa:twab:${coreId}:${at.toISOString()}`,
    });
  // H: 20 hari 130jt lalu 10 hari 40jt (brief 3.3)
  await (await cust(Hh)).update({ historyStartAt: addMs(nowT, -45 * D) });
  await mk(Hh, addMs(nowT, -45 * D), 0);
  await mk(Hh, addMs(nowT, -30 * D), 130000000);
  await mk(Hh, addMs(nowT, -10 * D), 40000000);
  let tw = await membership.computeTwab30(Hh, { now: nowT });
  check(
    "TWAB 20d@130jt + 10d@40jt = 100jt -> COMMANDER",
    tw.twab === 100000000n &&
      tw.fullHistory &&
      membership.resolveTier(config, tw.twab, tw.fullHistory).tier ===
        "COMMANDER",
    tw.twab.toString(),
  );
  let rt = await membership.refreshTier(Hh, { now: nowT });
  check(
    "refreshTier writes tier history (CADET -> COMMANDER)",
    rt.tier === "COMMANDER" &&
      (await LoyaltyTierHistory.count({ where: { coreId: Hh } })) === 1,
  );
  // withdrawal: saldo turun ke 0 hari ini -> masih Commander selama TWAB >= 100jt? 20d@130 + 10d@40 = tepat 100jt; turun 1 hari -> downgrade by TWAB only
  await mk(Hh, nowT, 0);
  tw = await membership.computeTwab30(Hh, { now: addMs(nowT, 1 * D) });
  check(
    "1 day after withdrawal to 0: TWAB falls below 100jt -> SENIOR (rolling window, no forced reset)",
    tw.twab < 100000000n &&
      membership.resolveTier(config, tw.twab, true).tier === "SENIOR",
    tw.twab.toString(),
  );
  // I: partial history (10 hari @ 200jt) -> CADET
  await (await cust(I)).update({ historyStartAt: addMs(nowT, -10 * D) });
  await mk(I, addMs(nowT, -10 * D), 200000000);
  tw = await membership.computeTwab30(I, { now: nowT });
  check(
    "new user 10 days @200jt -> history incomplete -> CADET",
    !tw.fullHistory &&
      membership.resolveTier(config, tw.twab, tw.fullHistory).tier === "CADET",
  );
  // qualified balance from product tables (no double count): wallet IDR only here
  const qb = await membership.computeQualifiedBalance(A, { now: nowT });
  check(
    "A qualified balance includes claimed referral IDR in wallet (49,749)",
    qb.qualified === 49749n && qb.breakdown.wallet_idr === "49749",
  );

  // ---------------------------------------------------------------- Config versioning
  console.log("\n== Versioned config (LR-022)");
  const draft = await configSvc.createDraft({
    patch: { referral: { deposit_cap_idr: 25000 } },
    note: "QA raise cap",
    createdBy: "ops-qa",
  });
  await configSvc.transition({
    version: draft.version,
    action: "submit",
    actor: "ops-qa",
  });
  await configSvc
    .transition({ version: draft.version, action: "approve", actor: "ops-qa" })
    .then(() => check("self-approve blocked (SoD)", false))
    .catch((e) => check("self-approve blocked (SoD)", e.code === "CONFIG_SOD"));
  await configSvc.transition({
    version: draft.version,
    action: "approve",
    actor: "finance-qa",
  });
  await configSvc
    .transition({
      version: draft.version,
      action: "schedule",
      actor: "finance-qa",
      effectiveAt: addMs(T0, -1 * D),
    })
    .then(() => check("retroactive effective_at blocked", false))
    .catch((e) =>
      check(
        "retroactive effective_at blocked",
        e.code === "CONFIG_RETROACTIVE",
      ),
    );
  const future = new Date(Date.now() + 365 * D);
  await configSvc.transition({
    version: draft.version,
    action: "schedule",
    actor: "finance-qa",
    effectiveAt: future,
  });
  configSvc.invalidate();
  const nowCfg = await configSvc.resolve(new Date());
  const futCfg = await configSvc.resolve(addMs(future, 1000));
  check(
    "v2 scheduled in future: now still v1 (cap 20k), after effective_at v2 (cap 25k)",
    nowCfg.config.referral.deposit_cap_idr === 20000 &&
      futCfg.config.referral.deposit_cap_idr === 25000 &&
      futCfg.version === draft.version,
  );
  await configSvc
    .createDraft({
      patch: {
        membership: {
          tiers: [
            { code: "X", threshold_idr: 5, multiplier_bps: 1 },
            { code: "Y", threshold_idr: 1, multiplier_bps: 1 },
          ],
        },
      },
      createdBy: "ops",
    })
    .then(() => check("invalid tier order rejected", false))
    .catch((e) =>
      check("invalid tier order rejected", e.code === "CONFIG_INVALID"),
    );
  check(
    "pending grants keep original config_version",
    (await grant(B, "FQT")).configVersion === 1,
  );

  // ---------------------------------------------------------------- Ledger reconciliation
  console.log("\n== Ledger reconciliation (14.3)");
  let mismatch = 0;
  for (const id of IDS) {
    const b = await vp(id);
    const gs = await LoyaltyRewardGrant.findAll({
      where: { coreId: id, unit: "VP" },
    });
    const expPending = gs
      .filter((g) => g.state === "PENDING")
      .reduce((s, g) => s + BigInt(g.vpAmount), 0n);
    const expAvailable =
      gs
        .filter((g) => g.state === "AVAILABLE")
        .reduce((s, g) => s + BigInt(g.vpAmount), 0n) -
      b.reserved -
      b.redeemed;
    if (b.pending !== expPending || b.available !== expAvailable) {
      mismatch++;
      console.log(
        `    mismatch ${id}: journal ${b.pending}/${b.available} vs grants ${expPending}/${expAvailable}`,
      );
    }
  }
  check(
    "VP journal reconciles to grant states for all QA customers",
    mismatch === 0,
  );
  const budgets = await LoyaltyBudgetLedger.findAll({
    where: { campaignId: { [Op.like]: "%:2026-1%" } },
  });
  check(
    "budget ledger separates ACQUISITION vs TRANSACTION",
    budgets.some((b) => b.campaignId.startsWith("ACQUISITION:")) &&
      budgets.some((b) => b.campaignId.startsWith("TRANSACTION:")),
  );

  // ---------------------------------------------------------------- summary
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n== RESULT: ${pass}/${results.length} PASS`);
  for (const r of results.filter((x) => !x.ok))
    console.log(`   FAIL: ${r.name}`);
  await LoyaltyConfigVersion.destroy({ where: { version: { [Op.gt]: 1 } } });
  configSvc.invalidate();
  await sequelize.close();
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(async (e) => {
  console.error("FATAL", e);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
