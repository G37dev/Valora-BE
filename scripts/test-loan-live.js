/*
 * LIVE CHAIN smoke test — Sepolia end-to-end.
 *
 * Prasyarat: server jalan dengan LOAN_CHAIN_MODE=live di BASE_URL.
 * Pakai user test E2E (RABv8pXT) — wallet-nya punya XAUT dummy di
 * Sepolia dan smart account-nya dikontrol admin backend (AA).
 *
 *   LOAN_CHAIN_MODE=live node index.js &
 *   node scripts/test-loan-live.js
 */
require("dotenv").config();
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const BASE = (process.env.BASE_URL || "http://localhost:5000").replace(
  /\/$/,
  "",
);
const CORE_ID = process.env.LIVE_CORE_ID || "RABv8pXT";
const ADMIN_KEY =
  process.env.BUSINESS_CLOCK_KEY ||
  process.env.LOAN_ADMIN_KEY ||
  crypto
    .createHash("sha256")
    .update(process.env.JWT_SECRET || "Valoracore77!")
    .digest("hex")
    .slice(0, 24);

const token = jwt.sign(
  { coreId: CORE_ID, sub: CORE_ID, aud: "valora-core" },
  process.env.JWT_SECRET,
  { expiresIn: "1h" },
);

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

async function api(method, path, { body, admin } = {}) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
  if (admin) headers["x-clock-key"] = ADMIN_KEY;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text: text.slice(0, 400) };
}

async function main() {
  console.log(`LIVE smoke ${BASE} user=${CORE_ID}\n`);

  // clock + price override (sim)
  await api("POST", "/api/admin/clock", {
    admin: true,
    body: { mode: "SIMULATED", simulated_now: "2026-10-20T03:00:00.000Z" },
  });
  const price = await api("POST", "/api/loans/admin/test/price", {
    admin: true,
    body: { asset: "XAUT", price_idr: 60000000 },
  });
  check("test price", price.status === 200, price.text.slice(0, 120));

  // topup internal IDR buat repay (DB langsung)
  const { InternalWallet } = require("../models");
  const [w] = await InternalWallet.findOrCreate({
    where: { coreId: CORE_ID },
    defaults: { balanceIdr: "0" },
  });
  w.balanceIdr = String(Math.round(Number(w.balanceIdr || 0)) + 5000000);
  await w.save();

  // open: 0.05 XAUT @60m -> coll 3m, gross 1.95m (65%)
  const open = await api("POST", "/api/loans", {
    body: {
      collateral_asset: "XAUT",
      collateral_qty: "0.05",
      tenor_days: 90,
      gross_loan_idr: "1950000",
      idempotency_key: `live-${Date.now()}-open`,
    },
  });
  check(
    "open live (approve+lock on-chain)",
    (open.status === 200 || open.status === 201) && open.json?.success,
    `${open.status} ${open.text}`,
  );
  const positionId = open.json?.data?.id;
  const lockTx = open.json?.data?.onchain?.lock_tx_hash;
  console.log("  lockTx:", lockTx);
  check(
    "lock tx real (bukan 0xmock)",
    !!lockTx && !String(lockTx).startsWith("0xmock"),
  );

  if (!positionId) process.exit(1);

  const bc = require("../services/loan/loan.blockchain.service");
  const { LoanPosition } = require("../models");
  const pos = await LoanPosition.findByPk(positionId);

  // ---- verify lock on-chain ----
  const onchain = await bc.readOnchainPosition(pos);
  console.log("  onchain:", {
    owner: onchain.owner,
    locked: onchain.locked.toString(),
    status: onchain.status,
  });
  check(
    "on-chain locked 0.05 XAUT",
    onchain.locked === 50000n,
    `locked=${onchain.locked}`,
  );
  check(
    "on-chain owner = smart account",
    onchain.owner?.toLowerCase() === pos.ownerAddress.toLowerCase(),
  );

  // ---- partial repay -> release on-chain (async chain op -> poll) ----
  const repay = await api("POST", `/api/loans/${positionId}/repay`, {
    body: { amount_idr: "500000", idempotency_key: `live-${Date.now()}-repay` },
  });
  check(
    "repay partial",
    repay.status === 200 && repay.json?.success,
    `${repay.status} ${repay.text}`,
  );

  let onchain2 = null;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    const cur = await bc.readOnchainPosition(pos);
    console.log(`  ...poll ${i + 1}: locked=${cur.locked}`);
    if (cur.locked < 50000n) {
      onchain2 = cur;
      break;
    }
  }
  check(
    "on-chain locked turun setelah repay",
    !!onchain2 && onchain2.locked < 50000n,
    `locked=${onchain2?.locked}`,
  );

  // ---- full settle -> release semua ----
  const settle = await api("POST", `/api/loans/${positionId}/repay`, {
    body: {
      full_settlement: true,
      idempotency_key: `live-${Date.now()}-settle`,
    },
  });
  check(
    "full settle",
    settle.status === 200 && settle.json?.success,
    `${settle.status} ${settle.text}`,
  );

  let onchain3 = null;
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    const cur = await bc.readOnchainPosition(pos);
    console.log(`  ...poll settle ${i + 1}: locked=${cur.locked}`);
    if (cur.locked === 0n) {
      onchain3 = cur;
      break;
    }
  }
  check(
    "on-chain locked 0 setelah settle",
    !!onchain3 && onchain3.locked === 0n,
    `locked=${onchain3?.locked}`,
  );

  await api("POST", "/api/admin/clock", {
    admin: true,
    body: { mode: "REAL" },
  });
  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
