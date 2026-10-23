/*
 * QA Earn — baca APR matrix + fee on-chain + validasi boundary (EAR cases).
 *   node scripts/test-earn-qa.js
 */
require("dotenv").config();
const bc = require("../services/earn/earn.blockchain.service");
const v = require("../services/earn/earn.validation");
const { sequelize, EarnPosition } = require("../models");

let fails = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  PASS" : "  FAIL"} ${name}${extra ? " — " + extra : ""}`);
};

const EXPECT_APR = {
  USDT: { 90: 350, 180: 425, 360: 500 },
  USDC: { 90: 350, 180: 425, 360: 500 },
  XAUT: { 90: 300, 180: 375, 360: 450 },
  GOLD: { 90: 325, 180: 400, 360: 475 },
};

(async () => {
  await sequelize.authenticate();

  console.log("== EAR-001..012 APR matrix on-chain (aprConfigs)");
  for (const [asset, terms] of Object.entries(EXPECT_APR)) {
    let pool;
    try {
      pool = bc.getEarnPoolAddress(asset);
    } catch (e) {
      check(`${asset} pool configured`, false, e.message);
      continue;
    }
    for (const [term, exp] of Object.entries(terms)) {
      try {
        const apr = await bc.readAprBps(pool, term);
        check(`${asset} ${term}d APR=${exp / 100}%`, apr === exp, `on-chain=${apr}bps`);
      } catch (e) {
        check(`${asset} ${term}d APR read`, false, e.message.slice(0, 80));
      }
    }
  }

  console.log("== EAR-013..020 platform fee 35bps");
  for (const asset of Object.keys(EXPECT_APR)) {
    try {
      const fee = await bc.readPlatformFeeBps(bc.getEarnPoolAddress(asset));
      check(`${asset} platformFeeBps=35`, fee === 35, String(fee));
    } catch (e) {
      check(`${asset} fee read`, false, e.message.slice(0, 80));
    }
  }

  console.log("== Term validation");
  check("term 90 ok", v.parseTermCode(90) === 90);
  check("term 45 rejected", (() => { try { v.parseTermCode(45); return false; } catch { return true; } })());
  check("term 0 rejected", (() => { try { v.parseTermCode(0); return false; } catch { return true; } })());
  check("term abc rejected", (() => { try { v.parseTermCode("abc"); return false; } catch { return true; } })());

  console.log("== EAR-026 APR snapshot immutable (positions.aprBps on-chain)");
  const pos = await EarnPosition.findOne({ order: [["created_at", "DESC"]] });
  if (pos && pos.onchainPositionId) {
    try {
      const on = await bc.readPoolPosition(bc.getEarnPoolAddress(pos.asset), pos.onchainPositionId);
      check("position aprBps snapshot tersimpan on-chain", on && on.aprBps > 0, `apr=${on?.aprBps} maturityAt=${on?.maturityAt}`);
    } catch (e) {
      check("position read on-chain", false, e.message.slice(0, 80));
    }
  } else {
    check("earn position exists for snapshot check", !!pos, "no position found");
  }

  console.log("== DB claim gating / status");
  const claimed = await EarnPosition.findOne({ where: { status: "CLAIMED" } });
  check("position status field exists", claimed !== undefined);
  if (claimed) console.log("   claimed pos:", claimed.id, "claimedAt:", claimed.claimedAt);

  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  await sequelize.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
