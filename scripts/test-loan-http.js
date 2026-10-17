/*
 * HTTP smoke test Loan — jalur request asli (Express + JWT middleware),
 * bukan service layer. Melengkapi E2E service-level.
 *
 * Prasyarat: server jalan di BASE_URL (default localhost:5000) dengan
 * DB yang sama. Business clock simulation aktif (default lokal).
 *
 *   node scripts/test-loan-http.js
 *
 * BASE_URL=https://valoracore.vercel.app node scripts/test-loan-http.js
 */
require("dotenv").config();
const crypto = require("crypto");

const BASE = (process.env.BASE_URL || "http://localhost:5000").replace(
  /\/$/,
  "",
);
const ADMIN_KEY =
  process.env.BUSINESS_CLOCK_KEY ||
  process.env.LOAN_ADMIN_KEY ||
  crypto
    .createHash("sha256")
    .update(process.env.JWT_SECRET || "Valoracore77!")
    .digest("hex")
    .slice(0, 24);

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

async function api(method, path, { body, token, admin } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
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
  return { status: res.status, json, text: text.slice(0, 300) };
}

async function main() {
  console.log(`HTTP smoke ${BASE}\n`);

  // ---- auth ----
  const email = `loansmoke${Date.now()}@test.dev`;
  const password = "SmokeTest123!";
  const reg = await api("POST", "/api/auth/register", {
    body: { firstName: "Smoke", lastName: "Loan", email, password },
  });
  check(
    "register",
    reg.status === 200 || reg.status === 201,
    `${reg.status} ${reg.text}`,
  );

  const login = await api("POST", "/api/auth/login/password", {
    body: { email, password },
  });
  const token = login.json?.data?.token || login.json?.token;
  const coreId = login.json?.data?.user?.coreId || login.json?.user?.coreId;
  check(
    "login -> JWT",
    login.status === 200 && !!token && !!coreId,
    `${login.status}`,
  );

  if (!token || !coreId) {
    console.log("tidak bisa lanjut tanpa token");
    process.exit(1);
  }

  // ---- KYC seed langsung ke DB (bukan loan concern; provider flow di luar scope) ----
  const { KycProfile } = require("../models");
  await KycProfile.upsert({
    core_id: coreId,
    status: "VERIFIED",
    verified_at: new Date(),
  });
  console.log(`  kyc VERIFIED seeded for ${coreId}`);

  // ---- sim clock + test price ----
  const t0 = new Date("2026-10-20T03:00:00.000Z");
  const clockSet = await api("POST", "/api/admin/clock", {
    admin: true,
    body: { mode: "SIMULATED", simulated_now: t0.toISOString() },
  });
  check(
    "clock set SIMULATED",
    clockSet.status === 200 && clockSet.json?.success,
    `${clockSet.status} ${clockSet.text}`,
  );

  const price = await api("POST", "/api/loans/admin/test/price", {
    admin: true,
    body: { asset: "XAUT", price_idr: 60000000 },
  });
  check(
    "test price XAUT=60m",
    price.status === 200 && price.json?.success,
    `${price.status} ${price.text}`,
  );

  // ---- config + quote ----
  const cfg = await api("GET", "/api/loans/config", {});
  check(
    "GET /config",
    cfg.status === 200 && cfg.json?.data?.rules_version === "LOAN-1.0",
  );

  const quote = await api("POST", "/api/loans/quote", {
    body: { collateral_asset: "XAUT", collateral_qty: "1", tenor_days: 90 },
  });
  check(
    "POST /quote",
    quote.status === 200 && quote.json?.success,
    `${quote.status} ${quote.text}`,
  );

  // ---- open position (JWT) ----
  const openBody = {
    collateral_asset: "XAUT",
    collateral_qty: "1",
    tenor_days: 90,
    gross_loan_idr: "39000000",
    idempotency_key: `smoke-${Date.now()}-open`,
  };
  const open = await api("POST", "/api/loans", { token, body: openBody });
  check(
    "POST /loans open",
    (open.status === 200 || open.status === 201) && open.json?.success,
    `${open.status} ${open.text}`,
  );
  const positionId = open.json?.data?.position?.id || open.json?.data?.id;
  check("position id returned", !!positionId, positionId || "");

  // idempotency replay — key sama harus return posisi sama, bukan duplikat
  const replay = await api("POST", "/api/loans", { token, body: openBody });
  check(
    "open idempotent",
    replay.status === 200 &&
      (replay.json?.data?.position?.id || replay.json?.data?.id) === positionId,
    `${replay.status}`,
  );

  if (!positionId) {
    console.log("tidak ada positionId — stop di sini");
    process.exit(1);
  }

  // ---- auth negative ----
  const noAuth = await api("GET", `/api/loans/${positionId}`, {});
  check(
    "no token -> 401/403",
    noAuth.status === 401 || noAuth.status === 403,
    `${noAuth.status}`,
  );

  const adminNoKey = await api("GET", "/api/loans/admin/pool", {});
  check(
    "admin no key -> 403",
    adminNoKey.status === 403,
    `${adminNoKey.status}`,
  );

  // ---- detail ----
  const detail = await api("GET", `/api/loans/${positionId}`, { token });
  check(
    "GET /loans/:id ACTIVE",
    detail.status === 200 && detail.json?.data?.status === "ACTIVE",
    `${detail.status} ${detail.text}`,
  );

  // ---- repay quote + partial repay ----
  const rq = await api("POST", `/api/loans/${positionId}/repayment/quote`, {
    token,
    body: { amount_idr: "5000000" },
  });
  check(
    "repay quote",
    rq.status === 200 && rq.json?.success,
    `${rq.status} ${rq.text}`,
  );

  // user IDR balance: seed langsung — internal wallet topup sim
  const { InternalWallet } = require("../models");
  const [wallet] = await InternalWallet.findOrCreate({
    where: { coreId },
    defaults: { balanceIdr: "0" },
  });
  wallet.balanceIdr = String(
    Math.round(Number(wallet.balanceIdr || 0)) + 45000000,
  );
  await wallet.save();

  const repay = await api("POST", `/api/loans/${positionId}/repay`, {
    token,
    body: {
      amount_idr: "5000000",
      idempotency_key: `smoke-${Date.now()}-repay`,
    },
  });
  check(
    "POST /repay 5m",
    repay.status === 200 && repay.json?.success,
    `${repay.status} ${repay.text}`,
  );

  // ---- full settlement ----
  const settle = await api("POST", `/api/loans/${positionId}/repay`, {
    token,
    body: {
      full_settlement: true,
      idempotency_key: `smoke-${Date.now()}-settle`,
    },
  });
  check(
    "full settlement",
    settle.status === 200 && settle.json?.success,
    `${settle.status} ${settle.text}`,
  );
  check(
    "status COMPLETED",
    settle.json?.data?.position?.status === "COMPLETED" ||
      settle.json?.data?.status === "COMPLETED",
    JSON.stringify(settle.json?.data).slice(0, 200),
  );

  // list user lain tidak boleh lihat posisi ini
  const email2 = `loansmokeb${Date.now()}@test.dev`;
  await api("POST", "/api/auth/register", {
    body: { firstName: "Smoke", lastName: "Other", email: email2, password },
  });
  const login2 = await api("POST", "/api/auth/login/password", {
    body: { email: email2, password },
  });
  const token2 = login2.json?.token || login2.json?.data?.token;
  const foreign = await api("GET", `/api/loans/${positionId}`, {
    token: token2,
  });
  check(
    "other user cannot read position",
    foreign.status === 404 || foreign.status === 403,
    `${foreign.status}`,
  );

  // ---- admin tick + pool ----
  const tickRes = await api("POST", "/api/loans/admin/tick", { admin: true });
  check(
    "POST /admin/tick",
    tickRes.status === 200 && tickRes.json?.success,
    `${tickRes.status} ${tickRes.text}`,
  );

  const pool = await api("GET", "/api/loans/admin/pool", { admin: true });
  check(
    "GET /admin/pool",
    pool.status === 200 && pool.json?.success,
    `${pool.status}`,
  );

  const list = await api("GET", "/api/loans", { token });
  check(
    "GET /loans list",
    list.status === 200 && list.json?.success,
    `${list.status}`,
  );

  // reset clock ke REAL
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
