/*
 * Deploy LoanCollateralEscrow (SATU codebase) TERPISAH per aset:
 *   - LOAN_ESCROW_XAUT_ADDRESS untuk XAUT
 *   - LOAN_ESCROW_GOLD_ADDRESS untuk VVLR Gold
 * Blast radius per-aset + pause independen (lihat kontrak).
 *
 * Usage:  node scripts/compileLoanEscrow.js && node scripts/deployLoanEscrow.js
 * Needs : .env ->
 *   VALORA_ADMIN_PRIVATE_KEY   (deployer = msg.sender awal)
 *   GOVERNMENT_SAFE_ADDRESS    (owner/governance: setOperator/signer/pause)
 *   VALORA_ADMIN_ADDRESS       (operator: submit lock/release/settle)
 *   LOAN_SETTLEMENT_SIGNER_ADDRESS (penandatangan settlement; fallback admin)
 *   LOAN_TREASURY_WALLET_ADDRESS   (tujuan debt+compensation; fallback STRATEGY_TREASURY_SAFE_ADDRESS)
 *   XAUT_DUMMY_CONTRACT_ADDRESS / GOLD_DUMMY_CONTRACT_ADDRESS
 *   SEPOLIA_RPC_URL (opsional)
 */
require("dotenv").config();
const {
  createPublicClient,
  createWalletClient,
  http,
} = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { sepolia } = require("viem/chains");
const artifact = require("../artifacts/LoanCollateralEscrow.sol/LoanCollateralEscrow.json");

const ABI = artifact.abi;
const BYTECODE = `0x${artifact.evm.bytecode.object}`;

const ASSETS = [
  { label: "XAUT", token: process.env.XAUT_DUMMY_CONTRACT_ADDRESS, env: "LOAN_ESCROW_XAUT_ADDRESS" },
  { label: "GOLD", token: process.env.GOLD_DUMMY_CONTRACT_ADDRESS, env: "LOAN_ESCROW_GOLD_ADDRESS" },
];

async function main() {
  const account = privateKeyToAccount(process.env.VALORA_ADMIN_PRIVATE_KEY);
  const transport = http(
    process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
  );
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ account, chain: sepolia, transport });

  const settlementSigner =
    process.env.LOAN_SETTLEMENT_SIGNER_ADDRESS || process.env.VALORA_ADMIN_ADDRESS;
  const treasury =
    process.env.LOAN_TREASURY_WALLET_ADDRESS || process.env.STRATEGY_TREASURY_SAFE_ADDRESS;

  for (const { label, token, env } of ASSETS) {
    if (!token) {
      console.log(`\n=== Skip ${label}: token address kosong ===`);
      continue;
    }
    console.log(`\n=== Deploy LoanCollateralEscrow [${label}] ===`);
    console.log("  assetToken       :", token);
    console.log("  governanceSafe   :", process.env.GOVERNMENT_SAFE_ADDRESS);
    console.log("  operator         :", process.env.VALORA_ADMIN_ADDRESS);
    console.log("  settlementSigner :", settlementSigner);
    console.log("  treasurySafe     :", treasury);

    const hash = await walletClient.deployContract({
      abi: ABI,
      bytecode: BYTECODE,
      args: [
        token,
        process.env.GOVERNMENT_SAFE_ADDRESS,
        process.env.VALORA_ADMIN_ADDRESS,
        settlementSigner,
        treasury,
      ],
    });
    console.log("  tx hash          :", hash);

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`Deploy ${label} gagal (status=${receipt.status})`);
    }
    console.log(`  contract         : ${receipt.contractAddress}`);
    console.log(`  -> set ${env}=${receipt.contractAddress}`);
    console.log("  block            :", receipt.blockNumber.toString());
  }
}

main().catch((err) => {
  console.error("\nDeploy gagal:", err.shortMessage || err.message || err);
  process.exit(1);
});
