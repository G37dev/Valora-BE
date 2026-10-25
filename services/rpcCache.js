/**
 * Cache TTL kecil untuk RPC read yang sering dihit dari HTTP path.
 *
 * - Block number: Sepolia nambang ~12s/blok, jadi TTL 12s praktis
 *   real-time untuk counter confirmations dan menghemat 1 roundtrip
 *   RPC (~200-500ms) per request.
 * - decimals(): nilai immutable on-chain -> cache permanen per alamat.
 *
 * Di serverless cache ini per-instance (masih memangkas mayoritas
 * call karena instance di-reuse); di server persistent jadi shared.
 */
const { eth_blockNumber } = require("thirdweb/rpc");

const BLOCK_TTL_MS = Number(process.env.RPC_BLOCK_CACHE_TTL_MS || 12000);
let blockCache = { value: 0, expiresAt: 0, inflight: null };

async function cachedBlockNumber(rpcRequest, ttlMs = BLOCK_TTL_MS) {
  const now = Date.now();
  if (blockCache.expiresAt > now) return blockCache.value;
  if (blockCache.inflight) return blockCache.inflight;
  blockCache.inflight = eth_blockNumber(rpcRequest)
    .then((n) => {
      blockCache.value = Number(n);
      blockCache.expiresAt = Date.now() + ttlMs;
      return blockCache.value;
    })
    .catch((err) => {
      // gagal -> pakai nilai stale bila ada, jangan cache error
      if (blockCache.value) return blockCache.value;
      throw err;
    })
    .finally(() => {
      blockCache.inflight = null;
    });
  return blockCache.inflight;
}

const decimalsCache = new Map();
async function cachedDecimals(contract, readContract) {
  const key = contract.address.toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  if (!decimalsCache.has(`${key}:inflight`)) {
    const p = readContract({
      contract,
      method: "function decimals() view returns (uint8)",
      params: [],
    })
      .then((d) => {
        decimalsCache.set(key, Number(d));
        return Number(d);
      })
      .finally(() => decimalsCache.delete(`${key}:inflight`));
    decimalsCache.set(`${key}:inflight`, p);
  }
  return decimalsCache.get(`${key}:inflight`);
}

module.exports = { cachedBlockNumber, cachedDecimals };
