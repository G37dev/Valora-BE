/*
 * Shared Sepolia chain config dengan multi-provider failover.
 *
 * `chain.rpc` dibaca ulang oleh getRpcClient di tiap call, jadi kita
 * pasang getter round-robin antar provider:
 *
 *   1. thirdweb edge gateway (11155111.rpc.thirdweb.com) — default,
 *      proper JSON-RPC, pakai THIRDWEB_SECRET_KEY
 *   2. Infura (SEPOLIA_RPC_URL) — fallback
 *   3. publicnode — fallback terakhir, gratis tanpa key
 *
 * Burst yang kena 429 di satu provider otomatis lompat ke provider
 * berikutnya pada call/retry selanjutnya — tidak perlu ubah call site.
 * Failover hanya berlaku untuk read; transaksi tetap lewat bundler
 * thirdweb (account abstraction tidak tergantung chain.rpc).
 */
const { defineChain } = require("thirdweb/chains");

const THIRDWEB_GW = "https://11155111.rpc.thirdweb.com";
const PUBLICNODE = "https://ethereum-sepolia-rpc.publicnode.com";
const TENDERLY = "https://sepolia.gateway.tenderly.co";

/*
 * Pool berbobot — thirdweb 2 slot (primary), sisanya fallback.
 * ~50% traffic ke thirdweb, sisanya tersebar ke provider cadangan;
 * retry withRpcRetry otomatis mendarat di provider berbeda.
 *
 * SEPOLIA_RPC_URL opsional: key Infura yang lama kena "Payment
 * Required" (kuota habis) — provider error non-standar itu bikin
 * thirdweb crash `reading 'buffer'`, jadi hanya masuk pool kalau
 * env-nya memang di-set ke endpoint yang sehat.
 */
const rpcPool = [
  THIRDWEB_GW,
  THIRDWEB_GW,
  TENDERLY,
  PUBLICNODE,
  process.env.SEPOLIA_RPC_URL,
].filter(Boolean);

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
