/*
 * Shared Sepolia chain config.
 *
 * Default: `sepolia` bawaan thirdweb/chains — RPC di-route lewat
 * gateway thirdweb (*.rpc.thirdweb.com) memakai THIRDWEB_SECRET_KEY.
 * Gateway ini proper JSON-RPC (nggak ada HTML error page / malformed
 * response yang bikin thirdweb crash "reading 'buffer'") dan limit-nya
 * jauh lebih longgar dari Infura free tier / public RPC.
 *
 * Escape hatch: kalau SEPOLIA_RPC_URL di-set (mis. dedicated Alchemy),
 * pakai itu — berguna kalau gateway thirdweb lagi masalah.
 */
const { defineChain, sepolia: thirdwebSepolia } = require("thirdweb/chains");

const sepolia = process.env.SEPOLIA_RPC_URL
  ? defineChain({
      id: 11155111,
      name: "Sepolia",
      rpc: process.env.SEPOLIA_RPC_URL,
      nativeCurrency: {
        name: "Sepolia Ether",
        symbol: "ETH",
        decimals: 18,
      },
      blockExplorers: [
        { name: "Etherscan", url: "https://sepolia.etherscan.io" },
      ],
      testnet: true,
    })
  : thirdwebSepolia;

module.exports = { sepolia };
