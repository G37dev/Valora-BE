/*
 * Deploy LoanCollateralEscrow (SATU codebase) TERPISAH per aset:
 *   - LOAN_ESCROW_XAUT_ADDRESS untuk XAUT
 *   - LOAN_ESCROW_GOLD_ADDRESS untuk VVLR Gold
 * Blast radius per-aset + pause independen (lihat kontrak).
 *
 * Usage:  node scripts/compileLoanEscrow.js && node scripts/deployLoanEscrow.js
 * Needs : .env ->
 *   THIRDWEB_SECRET_KEY, VALORA_ADMIN_PRIVATE_KEY (deployer = msg.sender)
 *   GOVERNMENT_SAFE_ADDRESS    (owner/governance: setOperator/signer/pause)
 *   VALORA_ADMIN_ADDRESS       (operator: submit lock/release/settle)
 *   LOAN_SETTLEMENT_SIGNER_ADDRESS (penandatangan settlement; fallback admin)
 *   LOAN_TREASURY_WALLET_ADDRESS   (tujuan debt+compensation; fallback STRATEGY_TREASURY_SAFE_ADDRESS)
 *   XAUT_DUMMY_CONTRACT_ADDRESS / GOLD_DUMMY_CONTRACT_ADDRESS
 *   SEPOLIA_RPC_URL (opsional)
 */
require("dotenv").config();
const { createThirdwebClient } = require("thirdweb");
const { privateKeyAccount } = require("thirdweb/wallets");
const { deployContract } = require("thirdweb/deploys");
const { sepolia } = require("../utils/chain");
const artifact = require("../artifacts/LoanCollateralEscrow.sol/LoanCollateralEscrow.json");

const ASSETS = [
  {
    label: "XAUT",
    token: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
    env: "LOAN_ESCROW_XAUT_ADDRESS",
  },
  {
    label: "GOLD",
    token: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
    env: "LOAN_ESCROW_GOLD_ADDRESS",
  },
];

async function main() {
  const client = createThirdwebClient({
    secretKey: process.env.THIRDWEB_SECRET_KEY,
  });
  const account = privateKeyAccount({
    client,
    privateKey: process.env.VALORA_ADMIN_PRIVATE_KEY,
  });

  const settlementSigner =
    process.env.LOAN_SETTLEMENT_SIGNER_ADDRESS ||
    process.env.VALORA_ADMIN_ADDRESS;
  const treasury =
    process.env.LOAN_TREASURY_WALLET_ADDRESS ||
    process.env.STRATEGY_TREASURY_SAFE_ADDRESS;

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

    const address = await deployContract({
      client,
      chain: sepolia,
      account,
      bytecode: `0x${artifact.evm.bytecode.object}`,
      abi: artifact.abi,
      constructorParams: {
        _assetToken: token,
        _governanceSafe: process.env.GOVERNMENT_SAFE_ADDRESS,
        _operator: process.env.VALORA_ADMIN_ADDRESS,
        _settlementSigner: settlementSigner,
        _treasurySafe: treasury,
      },
    });
    console.log(`  contract         : ${address}`);
    console.log(`  -> set ${env}=${address}`);
  }
}

main().catch((err) => {
  console.error("\nDeploy gagal:", err.shortMessage || err.message || err);
  process.exit(1);
});
