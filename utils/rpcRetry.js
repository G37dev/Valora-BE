/**
 * Retry helper untuk RPC read yang flaky.
 *
 * Provider free tier sering balas 429 / response malformed di bawah
 * burst — thirdweb lalu crash dengan TypeError macam
 * "Cannot read properties of undefined (reading 'buffer')" alih-alih
 * error yang jelas. Retry singkat dengan backoff menutup mayoritas
 * kasus itu. Error non-transient (revert kontrak, data invalid) langsung
 * dilempar apa adanya.
 */

const TRANSIENT_PATTERNS = [
  /too many requests/i,
  /rate.?limit/i,
  /-32005/,
  /timeout|timed out|ETIMEDOUT/i,
  /ECONNRESET|ECONNREFUSED|ENETUNREACH|fetch failed|network error/i,
  /block not found/i,
  /reading 'buffer'/i,
  /cannot convert undefined to a bigint/i, // RPC balas 429/error body
  /unexpected token/i, // response HTML/non-JSON
  /\b(429|502|503|504)\b/,
  /internal json-rpc error/i,
];

function isTransientRpcError(err) {
  const msg = String(err?.message || err);
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Jalankan fn() dengan retry bila error-nya transient.
 * @param {() => Promise<any>} fn
 * @param {{ retries?: number, baseDelayMs?: number, label?: string }} opts
 */
async function withRpcRetry(fn, opts = {}) {
  const { retries = 3, baseDelayMs = 400, label = "rpc" } = opts;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries || !isTransientRpcError(e)) throw e;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 150;
      console.log(
        `[rpcRetry] ${label} attempt ${attempt + 1} gagal (${String(
          e?.message || e,
        ).slice(0, 140)}) — retry dalam ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

module.exports = { withRpcRetry, isTransientRpcError };
