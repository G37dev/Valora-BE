/*
 * QA Deposit — listener blockchainListener.handleTransferEvent pakai
 * synthetic Transfer events (DEP cases). Tidak perlu tx on-chain.
 *   node scripts/test-deposit-qa.js
 */
require("dotenv").config();
const { handleTransferEvent } = require("../services/blockchainListener");
const { sequelize, Transaction, Wallet } = require("../models");
const crypto = require("crypto");

let fails = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  PASS" : "  FAIL"} ${name}${extra ? " — " + extra : ""}`);
};
const hx = () => "0xqa" + crypto.randomBytes(30).toString("hex");
const count = async (h) => Transaction.count({ where: { tx_hash: h } });
const ev = (from, to, value, hash, block = 12000000) => ({
  args: { from, to, value: BigInt(value) },
  transactionHash: hash,
  blockNumber: BigInt(block),
});

const USDT = {
  name: "USDT",
  address: process.env.USDT_DUMMY_CONTRACT_ADDRESS,
  earnPoolAddress: process.env.EARN_USDT_POOL_CONTRACT_ADDRESS,
  swapPoolAddress: process.env.SWAP_USDT_POOL_ADDRESS,
  installmentPoolAddress: null,
};

(async () => {
  await sequelize.authenticate();
  const u1 = await Wallet.findOne({ where: { core_id: "RABv8pXT" } });
  const u2 = await Wallet.findOne({ where: { core_id: "G7NVQ7EH" } });
  const W1 = u1.address, W2 = u2.address;
  const RAND = "0x" + crypto.randomBytes(20).toString("hex");
  const created = [];
  const track = async (h) => {
    const t = await Transaction.findOne({ where: { tx_hash: h } });
    if (t) created.push(t.id);
    return t;
  };

  console.log("== DEP basic: transfer masuk ke wallet user → DEPOSIT PENDING");
  {
    const h = hx();
    await handleTransferEvent({ event: ev(RAND, W1, 5_000_000n, h), token: USDT });
    const t = await track(h);
    check("row created", !!t);
    if (t) {
      check("type=DEPOSIT", t.type === "DEPOSIT", t.type);
      check("status=PENDING", t.status === "PENDING", t.status);
      check("amount=5 (6 dec)", String(t.amount) === "5", String(t.amount));
      check("core_id=RABv8pXT", t.core_id === "RABv8pXT", t.core_id);
      check("block number tercatat", Number(t.tx_block_number) === 12000000);
    }
  }

  console.log("== DEP dedup: replay event yang sama → skip");
  {
    const h = hx();
    await handleTransferEvent({ event: ev(RAND, W1, 1_000_000n, h), token: USDT });
    await track(h);
    await handleTransferEvent({ event: ev(RAND, W1, 1_000_000n, h), token: USDT });
    check("replay → tetap 1 row", (await count(h)) === 1, `count=${await count(h)}`);
  }

  console.log("== DEP logIndex: 2 Transfer berbeda dalam SATU txHash");
  {
    const h = hx();
    await handleTransferEvent({ event: ev(RAND, W1, 1_000_000n, h), token: USDT });
    await track(h);
    // event kedua: tx sama, logIndex beda, penerima user LAIN
    await handleTransferEvent({ event: ev(RAND, W2, 2_000_000n, h), token: USDT });
    const c = await count(h);
    check(
      "2 user menerima di 1 tx → 2 row (EXPECTED; txHash-only dedup = GAP)",
      c === 2,
      `count=${c} — ${c === 1 ? "CONFIRMED BUG: deposit kedua hilang" : "ok"}`,
    );
  }

  console.log("== DEP exclusion: from pool → skip");
  for (const [label, from] of [
    ["earnPool", USDT.earnPoolAddress],
    ["swapPool", USDT.swapPoolAddress],
  ]) {
    const h = hx();
    await handleTransferEvent({ event: ev(from, W1, 1_000_000n, h), token: USDT });
    check(`from ${label} → no row`, (await count(h)) === 0);
  }

  console.log("== DEP exclusion: to non-user → skip");
  {
    const h = hx();
    await handleTransferEvent({ event: ev(RAND, RAND, 1_000_000n, h), token: USDT });
    check("receiver non-user → no row", (await count(h)) === 0);
  }

  console.log("== DEP malformed event → no crash/no row");
  {
    await handleTransferEvent({ event: { args: { from: RAND, to: W1 }, transactionHash: null }, token: USDT });
    check("missing txHash/value → handled", true);
  }

  console.log("== DEP escrow → loan-aware type (regression fix)");
  {
    const h = hx();
    const escrow = process.env.LOAN_ESCROW_XAUT_ADDRESS;
    await handleTransferEvent({ event: ev(escrow, W1, 1_000_000n, h), token: USDT });
    const t = await track(h);
    check("escrow payout → COLLATERAL_RELEASE (no release row → default)", t && t.type === "COLLATERAL_RELEASE", t && t.type);
  }

  console.log("== cleanup");
  for (const id of created) await Transaction.destroy({ where: { id } });
  console.log(`   removed ${created.length} test rows`);

  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  await sequelize.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
