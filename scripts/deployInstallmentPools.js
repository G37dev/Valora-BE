/*
 * Deploy InstallmentAssetPool pools (GOLD + XAUT) ke Sepolia.
 *
 * Usage:  node scripts/deployInstallmentPools.js
 * Needs : .env -> VALORA_ADMIN_PRIVATE_KEY, VALORA_ADMIN_ADDRESS,
 *         GOVERNMENT_SAFE_ADDRESS, STRATEGY_TREASURY_SAFE_ADDRESS,
 *         GOLD_DUMMY_CONTRACT_ADDRESS, XAUT_DUMMY_CONTRACT_ADDRESS,
 *         SEPOLIA_RPC_URL (opsional)
 */
require("dotenv").config();
const {
  createPublicClient,
  createWalletClient,
  http,
} = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { sepolia } = require("viem/chains");
const artifact = require("../artifacts/InstallmentAssetPool.sol/InstallmentAssetPool.json");

const ABI = artifact.abi;
const BYTECODE = `0x${artifact.evm.bytecode.object}`;

const ASSETS = [
  {
    label: "GOLD",
    token: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
  },
  {
    label: "XAUT",
    token: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
  },
];

async function main() {
  const account = privateKeyToAccount(process.env.VALORA_ADMIN_PRIVATE_KEY);
  const transport = http(
    process.env.SEPOLIA_RPC_URL ||
      "https://ethereum-sepolia-rpc.publicnode.com"
  );
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport,
  });

  const args = (token) => [
    token,
    process.env.GOVERNMENT_SAFE_ADDRESS,
    process.env.VALORA_ADMIN_ADDRESS,
    process.env.STRATEGY_TREASURY_SAFE_ADDRESS,
  ];

  for (const { label, token } of ASSETS) {
    console.log(`\n=== Deploy InstallmentAssetPool [${label}] ===`);
    console.log("  assetToken     :", token);
    console.log("  governanceSafe :", process.env.GOVERNMENT_SAFE_ADDRESS);
    console.log("  operator       :", process.env.VALORA_ADMIN_ADDRESS);
    console.log("  treasurySafe   :", process.env.STRATEGY_TREASURY_SAFE_ADDRESS);

    const hash = await walletClient.deployContract({
      abi: ABI,
      bytecode: BYTECODE,
      args: args(token),
    });
    console.log("  tx hash        :", hash);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Deploy ${label} gagal (status=${receipt.status})`);
    }
    console.log("  contract       :", receipt.contractAddress);
    console.log("  block          :", receipt.blockNumber.toString());
  }
}

main().catch((err) => {
  console.error("\nDeploy gagal:", err.shortMessage || err.message || err);
  process.exit(1);
});
