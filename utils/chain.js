/*
 * Shared Sepolia chain config dengan multi-provider failover.
 *
 * `chain.rpc` dibaca ulang oleh getRpcClient di tiap call, jadi kita
 * pasang getter round-robin antar provider:
 *
 *   1. thirdweb edge gateway — ~10 RPS di plan saat ini
 *   2. Tenderly public gateway — fallback
 *   3. publicnode — fallback
 *
 * Burst yang kena 429 di satu provider otomatis lompat ke provider
 * berikutnya pada call/retry selanjutnya — tidak perlu ubah call site.
 * Failover hanya berlaku untuk read; transaksi tetap lewat bundler
 * thirdweb (account abstraction tidak tergantung chain.rpc).
 */
const { defineChain } = require("thirdweb/chains");

const THIRDWEB_GW = "https://11155111.rpc.thirdweb.com";
const TENDERLY = "https://sepolia.gateway.tenderly.co";
const PUBLICNODE = "https://ethereum-sepolia-rpc.publicnode.com";

/*
 * Pool berat merata — thirdweb cuma 10 RPS di plan free, jadi jangan
 * didominin; tenderly & publicnode terbukti stabil tanpa key.
 * Retry withRpcRetry otomatis mendarat di provider berbeda.
 */
const rpcPool = [THIRDWEB_GW, TENDERLY, PUBLICNODE];

let rpcIdx = 0;
const nextRpc = () => rpcPool[rpcIdx++ % rpcPool.length];

const sepolia = defineChain({
  id: 11155111,
  name: "Sepolia",
  rpc: nextRpc(), // nilai awal — getter di bawah yang dipakai per-call
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  blockExplorers: [
    { name: "Etherscan", url: "https://sepolia.etherscan.io" },
  ],
  testnet: true,
});

/*
 * Override properti `rpc` menjadi getter berputar. defineChain meng-
 * freeze object-nya di beberapa versi — kalau redefinisi gagal, chain
 * tetap jalan dengan rpc tunggal (fallback aman).
 */
try {
  Object.defineProperty(sepolia, "rpc", {
    get: nextRpc,
    configurable: true,
    enumerable: true,
  });
} catch {
  /* biarkan rpc statis kalau object frozen */
}

module.exports = { sepolia };
