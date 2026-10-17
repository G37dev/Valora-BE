/*
 * LIVE liquidation smoke — open posisi kecil -> admin force-liquidate ->
 * settle() on-chain (signed split: refund->user, debt+comp->treasury).
 *
 *   LOAN_CHAIN_MODE=live node index.js &
 *   node scripts/test-loan-live-liquidate.js
 */
require("dotenv").config();
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const BASE = "http://localhost:5000";
const CORE_ID = "RABv8pXT";
const ADMIN_KEY = crypto.createHash("sha256").update(process.env.JWT_SECRET).digest("hex").slice(0, 24);
const token = jwt.sign({ coreId: CORE_ID, sub: CORE_ID, aud: "valora-core" }, process.env.JWT_SECRET, { expiresIn: "1h" });
const api = async (m, p, o = {}) => {
  const h = { "content-type": "application/json", authorization: `Bearer ${token}` };
  if (o.admin) h["x-clock-key"] = ADMIN_KEY;
  const r = await fetch(`${BASE}${p}`, { method: m, headers: h, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null), text: "" };
};
(async () => {
  await api("POST", "/api/admin/clock", { admin: true, body: { mode: "SIMULATED", simulated_now: "2026-10-20T03:00:00.000Z" } });
  await api("POST", "/api/loans/admin/test/price", { admin: true, body: { asset: "XAUT", price_idr: 60000000 } });
  const open = await api("POST", "/api/loans", { body: { collateral_asset: "XAUT", collateral_qty: "0.05", tenor_days: 90, gross_loan_idr: "1950000", idempotency_key: `liq-${Date.now()}` } });
  console.log("open:", open.status, open.json?.data?.id, "| lockTx:", open.json?.data?.onchain?.lock_tx_hash);
  const pid = open.json?.data?.id;
  if (!pid) process.exit(1);
  // force liquidate
  const liq = await api("POST", `/api/loans/admin/positions/${pid}/liquidate`, { admin: true });
  console.log("liquidate:", liq.status, JSON.stringify(liq.json).slice(0, 200));
  process.exit(0);
})();
