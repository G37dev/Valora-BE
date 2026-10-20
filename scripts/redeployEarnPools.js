/* Redeploy EarnAssetPool v2.1 (fix uint24 overflow maturity) + remap router. */
require("dotenv").config();
const { createPublicClient, createWalletClient, http, encodeFunctionData } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const { sepolia } = require("viem/chains");
const poolArtifact = require("../artifacts/EarnAssetPool.sol/EarnAssetPool.json");
const routerArtifact = require("../artifacts/EarnRouter.sol/EarnRouter.json");

const transport = http(process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com");
const deployer = privateKeyToAccount(process.env.VALORA_ADMIN_PRIVATE_KEY);
const gov = privateKeyToAccount("0x" + process.env.GOVERNANCE_PRIVATE_KEY.replace(/^0x/i, ""));
const ROUTER = process.env.EARN_ROUTER_CONTRACT_ADDRESS;

const ASSETS = [
  { label: "USDT", token: process.env.USDT_DUMMY_CONTRACT_ADDRESS, aprs: [[1,650],[90,350],[180,425],[360,500]], minFee: 50_000n },
  { label: "USDC", token: process.env.USDC_DUMMY_CONTRACT_ADDRESS, aprs: [[1,650],[90,350],[180,425],[360,500]], minFee: 50_000n },
  { label: "XAUT", token: process.env.XAUT_DUMMY_CONTRACT_ADDRESS, aprs: [[1,650],[90,300],[180,375],[360,450]], minFee: 13n },
  { label: "GOLD", token: process.env.GOLD_DUMMY_CONTRACT_ADDRESS, aprs: [[1,650],[90,325],[180,400],[360,475]], minFee: 385n },
];

async function main() {
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const deployerWallet = createWalletClient({ account: deployer, chain: sepolia, transport });
  const govWallet = createWalletClient({ account: gov, chain: sepolia, transport });
  const pools = {};

  for (const a of ASSETS) {
    console.log(`\n=== Deploy ${a.label} ===`);
    const hash = await deployerWallet.deployContract({
      abi: poolArtifact.abi,
      bytecode: `0x${poolArtifact.evm.bytecode.object}`,
      args: [a.token, process.env.GOVERNMENT_SAFE_ADDRESS, process.env.STRATEGY_TREASURY_SAFE_ADDRESS, process.env.REWARD_RESERVE_ADDRESS, process.env.FEE_TREASURY_SAFE_ADDRESS],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    pools[a.label] = receipt.contractAddress;
    console.log("pool:", receipt.contractAddress, receipt.status);

    const calls = [
      ["setRouter", [ROUTER]],
      ["setPlatformFeeBps", [35]],
      ["setMinFeeRaw", [a.minFee]],
      ["setLimits", [1_000_000_000_000n, 0n, a.minFee * 2n]],
      ...a.aprs.map(([t, apr]) => ["setAPR", [t, apr]]),
    ];
    for (const [fn, args] of calls) {
      const data = encodeFunctionData({ abi: poolArtifact.abi, functionName: fn, args });
      const h = await govWallet.sendTransaction({ to: receipt.contractAddress, data });
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      if (r.status !== "success") throw new Error(`${a.label}.${fn} failed ${h}`);
      process.stdout.write(`${fn} ok  `);
    }
    console.log("");

    // Remap router -> pool baru
    const data = encodeFunctionData({ abi: routerArtifact.abi, functionName: "setAssetPool", args: [a.token, receipt.contractAddress] });
    const h = await govWallet.sendTransaction({ to: ROUTER, data });
    await publicClient.waitForTransactionReceipt({ hash: h });
    console.log(`${a.label} router remapped -> ${receipt.contractAddress}`);
  }

  console.log("\n===== NEW POOLS =====");
  for (const a of ASSETS) console.log(`EARN_${a.label}_POOL_CONTRACT_ADDRESS=${pools[a.label]}`);
}
main().catch((e) => { console.error("gagal:", e.shortMessage || e.message); process.exit(1); });
