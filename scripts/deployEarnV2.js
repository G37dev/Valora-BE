/*
 * Deploy Earn v2: EarnRouter + 4 EarnAssetPool (uint16 termCode,
 * reward /360, minFeeRaw) + konfigurasi penuh via Governance key.
 *
 *   node scripts/deployEarnV2.js
 */
require("dotenv").config();
const {
  createPublicClient, createWalletClient, http, encodeFunctionData,
} = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { sepolia } = require("viem/chains");

const poolArtifact = require("../artifacts/EarnAssetPool.sol/EarnAssetPool.json");
const routerArtifact = require("../artifacts/EarnRouter.sol/EarnRouter.json");

const transport = http(process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org");

// Deployer bayar gas; owner contract = Governance Safe (dikonfigurasi via ctor)
const deployer = privateKeyToAccount(process.env.VALORA_ADMIN_PRIVATE_KEY);
const gov = privateKeyToAccount("0x" + process.env.GOVERNANCE_PRIVATE_KEY.replace(/^0x/i, ""));

const GOV_SAFE = process.env.GOVERNMENT_SAFE_ADDRESS;
const STRATEGY_SAFE = process.env.STRATEGY_TREASURY_SAFE_ADDRESS;
const REWARD_RESERVE = process.env.REWARD_RESERVE_ADDRESS;
const FEE_TREASURY = process.env.FEE_TREASURY_SAFE_ADDRESS;

// APR matrix brief (bps): 90D / 180D / 360D + term test 1D=650
const ASSETS = [
  { label: "USDT", token: process.env.USDT_DUMMY_CONTRACT_ADDRESS, aprs: [[1, 650], [90, 350], [180, 425], [360, 500]], minFee: 50_000n },   // $0.05
  { label: "USDC", token: process.env.USDC_DUMMY_CONTRACT_ADDRESS, aprs: [[1, 650], [90, 350], [180, 425], [360, 500]], minFee: 50_000n },   // $0.05
  { label: "XAUT", token: process.env.XAUT_DUMMY_CONTRACT_ADDRESS, aprs: [[1, 650], [90, 300], [180, 375], [360, 450]], minFee: 13n },         // ~$0.05 @ $4000/oz
  { label: "GOLD", token: process.env.GOLD_DUMMY_CONTRACT_ADDRESS, aprs: [[1, 650], [90, 325], [180, 400], [360, 475]], minFee: 385n },        // ~$0.05 @ $130/g
];

async function main() {
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const deployerWallet = createWalletClient({ account: deployer, chain: sepolia, transport });
  const govWallet = createWalletClient({ account: gov, chain: sepolia, transport });

  console.log("deployer:", deployer.address);
  console.log("gov     :", gov.address, "(expect", GOV_SAFE + ")");

  // ---- 1. Deploy Router ----
  console.log("\n=== Deploy EarnRouter ===");
  const routerHash = await deployerWallet.deployContract({
    abi: routerArtifact.abi,
    bytecode: `0x${routerArtifact.evm.bytecode.object}`,
    args: [GOV_SAFE],
  });
  const routerReceipt = await publicClient.waitForTransactionReceipt({ hash: routerHash });
  const router = routerReceipt.contractAddress;
  console.log("router:", router, routerReceipt.status);

  // ---- 2. Deploy pools + config ----
  const pools = {};
  for (const a of ASSETS) {
    console.log(`\n=== Deploy EarnAssetPool [${a.label}] ===`);
    const hash = await deployerWallet.deployContract({
      abi: poolArtifact.abi,
      bytecode: `0x${poolArtifact.evm.bytecode.object}`,
      args: [a.token, GOV_SAFE, STRATEGY_SAFE, REWARD_RESERVE, FEE_TREASURY],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const pool = receipt.contractAddress;
    pools[a.label] = pool;
    console.log("pool:", pool, receipt.status);

    // Config via gov key (owner)
    const calls = [
      ["setRouter", [router]],
      ["setPlatformFeeBps", [35]],
      ["setMinFeeRaw", [a.minFee]],
      // hardMax 1M token, bufferMin 0, minDeposit = 2x minFee
      ["setLimits", [1_000_000_000_000n, 0n, a.minFee * 2n]],
      ...a.aprs.map(([t, apr]) => ["setAPR", [t, apr]]),
    ];
    for (const [fn, args] of calls) {
      const data = encodeFunctionData({ abi: poolArtifact.abi, functionName: fn, args });
      const h = await govWallet.sendTransaction({ to: pool, data });
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") throw new Error(`${a.label}.${fn} failed: ${h}`);
      process.stdout.write(`${fn}(${args}) ok  `);
    }
    console.log("");
  }

  // ---- 3. Router: map token -> pool ----
  console.log("\n=== Router setAssetPool ===");
  for (const a of ASSETS) {
    const data = encodeFunctionData({ abi: routerArtifact.abi, functionName: "setAssetPool", args: [a.token, pools[a.label]] });
    const h = await govWallet.sendTransaction({ to: router, data });
    const r = await publicClient.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`setAssetPool ${a.label} failed`);
    console.log(`${a.label}: ${a.token} -> ${pools[a.label]}`);
  }

  console.log("\n========================================");
  console.log("EARN_ROUTER_CONTRACT_ADDRESS=" + router);
  for (const a of ASSETS) {
    console.log(`EARN_${a.label}_POOL_CONTRACT_ADDRESS=${pools[a.label]}`);
  }
  console.log("========================================");
}

main().catch((e) => { console.error("\nDeploy gagal:", e.shortMessage || e.message || e); process.exit(1); });
