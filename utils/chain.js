/*
 * Shared Sepolia chain config.
 *
 * Default `sepolia` dari thirdweb/chains me-route RPC lewat gateway
 * thirdweb (*.rpc.thirdweb.com) yang butuh secret key valid — kalau
 * key expired/revoked semua call kena 401. Pakai chain custom ini:
 * RPC langsung ke SEPOLIA_RPC_URL (atau publicnode sebagai fallback
 * gratis), tanpa dependency ke gateway thirdweb.
 *
 * Untuk produksi: set SEPOLIA_RPC_URL ke provider dedicated
 * (Alchemy/Infura/QuickNode/dRPC) — lebih stabil dari public RPC.
 */
const { defineChain } = require("thirdweb/chains");

const sepolia = defineChain({
  id: 11155111,
  name: "Sepolia",
  rpc:
    process.env.SEPOLIA_RPC_URL ||
    "https://ethereum-sepolia-rpc.publicnode.com",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  blockExplorers: [
    { name: "Etherscan", url: "https://sepolia.etherscan.io" },
  ],
  testnet: true,
});

module.exports = { sepolia };
