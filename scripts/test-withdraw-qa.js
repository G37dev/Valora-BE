/*
 * QA Withdraw — live API tests (WIT cases) vs deployed backend.
 * Aman: invalid input ditolak sebelum chain. Real transfer pakai amount kecil
 * ke alamat user sendiri sebagai bukti end-to-end.
 *   node scripts/test-withdraw-qa.js <coreId> <userEoa>
 */
const API = process.env.API_BASE || "https://valora-be.vercel.app/api";
const CORE_ID = process.argv[2] || "RABv8pXT";
const EOA = process.argv[3] || "0xD3944B2E30e1C3a9Bd0f31d95c0D0A56f5f4c0C0";

let fails = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  PASS" : "  FAIL"} ${name}${extra ? " — " + extra : ""}`);
};

const post = async (body) => {
  const r = await fetch(`${API}/transactions/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
};

(async () => {
  console.log(`API: ${API}  coreId: ${CORE_ID}`);

  console.log("== Validation rejects BEFORE any chain/db side-effect");
  {
    const r = await post({});
    check("missing fields → 400", r.status === 400, `${r.status} ${r.body.message || ""}`);
  }
  {
    const r = await post({ coreId: CORE_ID, asset: "IDR", amount: "1000", destinationAddress: EOA });
    check("asset IDR → 400 (WIT-009 IDR disabled)", r.status === 400, `${r.status} ${r.body.message || ""}`);
  }
  {
    const r = await post({ coreId: CORE_ID, asset: "BTC", amount: "1", destinationAddress: EOA });
    check("unsupported asset → 400", r.status === 400, `${r.status} ${r.body.message || ""}`);
  }
  {
    const r = await post({ coreId: "nonexistent-user-xyz", asset: "USDT", amount: "1", destinationAddress: EOA });
    check("unknown coreId → 404 (no wallet)", r.status === 404, `${r.status} ${r.body.message || ""}`);
  }

  console.log("== WIT-002/010 auth check — endpoint tanpa token/challenge");
  {
    // Tidak ada header Authorization sama sekali — request lolos ke wallet lookup.
    // 404/400 artinya request diproses (bukan 401/403) → no auth layer.
    const r = await post({ coreId: "nonexistent-user-xyz", asset: "USDT", amount: "1", destinationAddress: EOA });
    check("no-auth request diproses s/d wallet lookup (bukan 401/403)", r.status === 404, `${r.status}`);
  }

  console.log("== Amount validation (real coreId — baris FAILED mungkin tercatat, itu evidence)");
  {
    const r = await post({ coreId: CORE_ID, asset: "USDT", amount: "abc", destinationAddress: EOA });
    check("amount 'abc' → rejected", r.status >= 400, `${r.status} ${r.body.message || r.body.error || ""}`);
  }
  {
    const r = await post({ coreId: CORE_ID, asset: "USDT", amount: "-5", destinationAddress: EOA });
    check("amount '-5' → rejected", r.status >= 400, `${r.status} ${r.body.message || r.body.error || ""}`);
  }
  {
    const r = await post({ coreId: CORE_ID, asset: "USDT", amount: "1e40", destinationAddress: EOA });
    check("amount '1e40' → rejected (insolvent)", r.status >= 400, `${r.status} ${r.body.message || r.body.error || ""}`);
  }

  console.log("== WIT-005 destination validation");
  {
    const r = await post({ coreId: CORE_ID, asset: "USDT", amount: "1", destinationAddress: "not-an-address" });
    check("bad address string → rejected", r.status >= 400, `${r.status} ${String(r.body.error || r.body.message || "").slice(0, 80)}`);
  }

  console.log("== WIT-008 real e2e: 0.01 USDT → alamat user sendiri");
  {
    const r = await post({ coreId: CORE_ID, asset: "USDT", amount: "0.01", destinationAddress: EOA });
    if (r.status === 200 && r.body.data && r.body.data.txHash) {
      check("withdraw SUCCESS + real txHash", true, r.body.data.txHash);
      console.log("   txHash:", r.body.data.txHash);
    } else {
      check("withdraw SUCCESS + real txHash", false, `${r.status} ${String(r.body.error || r.body.message || "").slice(0, 120)}`);
    }
  }

  console.log("== WIT-006 idempotency — kirim request identik 2x");
  {
    const p1 = post({ coreId: CORE_ID, asset: "USDT", amount: "0.01", destinationAddress: EOA });
    const p2 = post({ coreId: CORE_ID, asset: "USDT", amount: "0.01", destinationAddress: EOA });
    const [r1, r2] = await Promise.all([p1, p2]);
    const h1 = r1.body.data && r1.body.data.txHash;
    const h2 = r2.body.data && r2.body.data.txHash;
    console.log(`   req1: ${r1.status} ${h1 || r1.body.message}  req2: ${r2.status} ${h2 || r2.body.message}`);
    const bothSucceeded = r1.status === 200 && r2.status === 200 && h1 && h2 && h1 !== h2;
    check(
      "double-submit → duplikat ditolak (EXPECTED tapi kemungkinan GAP)",
      !bothSucceeded,
      bothSucceeded ? `CONFIRMED BUG: dua transfer on-chain ${h1.slice(0, 14)}… ${h2.slice(0, 14)}…` : "dedup ok / one failed",
    );
  }

  console.log(fails ? `\n${fails} check(s) failed/flagged` : "\nALL PASS");
})().catch((e) => { console.error("ERR:", e.message); process.exit(1); });
