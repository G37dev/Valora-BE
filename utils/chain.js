/*
 * Shared Sepolia chain config dengan multi-provider failover.
 *
 * `chain.rpc` dibaca ulang oleh getRpcClient di tiap call, jadi kita
 * pasang getter round-robin antar provider:
 *
 *   1. thirdweb edge gateway — ~10 RPS di plan saat ini
 *   2. publicnode — fallback
 *   3. 0xrpc — fallback
 *
 * Catatan: sepolia.gateway.tenderly.co TIDAK dipakai — anonymous
 * quota-nya per-IP dan IP egress Vercel di-share ribuan app, jadi
 * hampir selalu balas 401 ({"error":{"slug":"unauthorized"}}).
 * Kalau mau Tenderly, perlu access key (URL: .../<accessKey>).
 *
 * Burst yang kena 429 di satu provider otomatis lompat ke provider
 * berikutnya pada call/retry selanjutnya — tidak perlu ubah call site.
 * Failover hanya berlaku untuk read; transaksi tetap lewat bundler
 * thirdweb (account abstraction tidak tergantung chain.rpc).
 */
const { defineChain } = require("thirdweb/chains");

const THIRDWEB_GW = "https://11155111.rpc.thirdweb.com";
const PUBLICNODE = "https://ethereum-sepolia-rpc.publicnode.com";
const XRPC = "https://0xrpc.io/sep";

/*
 * thirdweb cuma ~10 RPS di plan saat ini — 2 fallback menanggung
 * 2/3 beban; retry withRpcRetry otomatis mendarat di provider lain.
 */
const rpcPool = [THIRDWEB_GW, PUBLICNODE, XRPC];

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
