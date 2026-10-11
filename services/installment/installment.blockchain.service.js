/*
 * Blockchain adapter untuk InstallmentAssetPool (custody claim).
 *
 * Backend DB tetap sumber kebenaran; kontrak hanya custody + event.
 * - allocate   : plan aktif -> earmark token untuk plan (best-effort)
 * - releaseClaim : user claim -> transfer alokasi ke beneficiary
 * - reclaimPlan  : plan AUTO_LIQUIDATED/CANCELLED -> balik ke treasury
 *
 * planId on-chain = keccak256(uuid plan) — deterministik dari plan.id.
 * Operator = VALORA_ADMIN_* (EOA yang sama dengan Earn/Swap operator).
 */

const Decimal = require("decimal.js");
const { keccak256, toBytes } = require("viem");
const {
  getContract,
  readContract,
  prepareContractCall,
  sendTransaction,
  waitForReceipt,
} = require("thirdweb");

const { sepolia } = require("../../utils/chain");
const {
  client,
  adminAccount,
  getTokenContract,
} = require("../earn/earn.blockchain.service");
const { InstallmentError } = require("./installment.errors");
const { ASSET, ASSET_ALIASES } = require("./installment.constants");
const { Wallet } = require("../../models");

const ONCHAIN_STATUS = Object.freeze({
  NONE: 0,
  ALLOCATED: 1,
  CLAIMED: 2,
  VOID: 3,
});

const normalizeAsset = (assetCode) =>
  ASSET_ALIASES[String(assetCode || "").toUpperCase()] || null;

function planIdToBytes32(planId) {
  return keccak256(toBytes(String(planId)));
}

function getPoolAddress(assetCode) {
  const asset = normalizeAsset(assetCode);
  const map = {
    [ASSET.GOLD]: process.env.INSTALLMENT_GOLD_POOL_ADDRESS,
    [ASSET.XAUT]: process.env.INSTALLMENT_XAUT_POOL_ADDRESS,
  };
  const address = map[asset];
  if (!address) {
    throw new Error(
      `Installment pool untuk ${assetCode} belum dikonfigurasi (env).`,
    );
  }
  return address;
}

function getPoolContract(assetCode) {
  return getContract({
    client,
    chain: sepolia,
    address: getPoolAddress(assetCode),
  });
}

function getTokenDecimals(assetCode) {
  const asset = normalizeAsset(assetCode);
  const map = {
    [ASSET.GOLD]: Number(process.env.GOLD_DECIMALS || 6),
    [ASSET.XAUT]: Number(process.env.XAUT_DECIMALS || 6),
  };
  return map[asset] ?? 6;
}

/** gold_amount (unit token, desimal) -> raw uint256 sesuai decimals. */
function tokenAmountRaw(plan) {
  const decimals = getTokenDecimals(plan.assetCode);
  const raw = new Decimal(String(plan.goldAmount)).mul(
    new Decimal(10).pow(decimals),
  );
  return BigInt(raw.toFixed(0));
}

function getTokenAddress(assetCode) {
  const asset = normalizeAsset(assetCode);
  const map = {
    [ASSET.GOLD]: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
    [ASSET.XAUT]: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
  };
  return map[asset] || null;
}

/** Alamat on-chain user (AA smart wallet) untuk beneficiary claim. */
async function getBeneficiaryAddress(coreId) {
  const wallet = await Wallet.findOne({ where: { core_id: coreId } });
  return wallet?.address || null;
}

async function readOnchainPlan(plan) {
  const contract = getPoolContract(plan.assetCode);
  const [amount, beneficiary, allocatedAt, status] = await readContract({
    contract,
    method:
      "function getPlan(bytes32 planId) view returns (uint256 amount, address beneficiary, uint64 allocatedAt, uint8 status)",
    params: [planIdToBytes32(plan.id)],
  });
  return {
    amount,
    beneficiary,
    allocatedAt: Number(allocatedAt),
    status: Number(status),
  };
}

async function sendPoolTx(plan, method, params, label) {
  const contract = getPoolContract(plan.assetCode);
  const transaction = prepareContractCall({ contract, method, params });
  const result = await sendTransaction({ transaction, account: adminAccount });
  const txHash = result?.transactionHash;
  if (!txHash) throw new Error(`${label}: transaction hash tidak ditemukan.`);
  const receipt = await waitForReceipt({
    client,
    chain: sepolia,
    transactionHash: txHash,
  });
  if (!receipt || receipt.status !== "success") {
    throw new Error(`${label}: tx reverted (${txHash})`);
  }
  return txHash;
}

/** Earmark token pool untuk plan. Revert on-chain jika likuiditas kurang. */
async function allocatePlanOnChain(plan, beneficiary) {
  return sendPoolTx(
    plan,
    "function allocate(bytes32 planId, address beneficiary, uint256 amount)",
    [planIdToBytes32(plan.id), beneficiary, tokenAmountRaw(plan)],
    "allocate",
  );
}

async function releaseClaimOnChain(plan) {
  return sendPoolTx(
    plan,
    "function releaseClaim(bytes32 planId)",
    [planIdToBytes32(plan.id)],
    "releaseClaim",
  );
}

async function reclaimPlanOnChain(plan) {
  return sendPoolTx(
    plan,
    "function reclaimPlan(bytes32 planId)",
    [planIdToBytes32(plan.id)],
    "reclaimPlan",
  );
}

/**
 * Isi inventaris pool: operator approve + fundPool.
 * Dipakai script ops (top-up backing token), bukan request path.
 */
async function fundPoolOnChain(assetCode, rawAmount) {
  const poolAddress = getPoolAddress(assetCode);
  const tokenAddress = getTokenAddress(assetCode);
  const tokenContract = getTokenContract(tokenAddress);

  const allowance = await readContract({
    contract: tokenContract,
    method:
      "function allowance(address owner,address spender) view returns (uint256)",
    params: [adminAccount.address, poolAddress],
  });

  if (BigInt(allowance) < BigInt(rawAmount)) {
    const approveTx = prepareContractCall({
      contract: tokenContract,
      method: "function approve(address spender,uint256 amount) returns (bool)",
      params: [poolAddress, rawAmount],
    });
    const res = await sendTransaction({
      transaction: approveTx,
      account: adminAccount,
    });
    const receipt = await waitForReceipt({
      client,
      chain: sepolia,
      transactionHash: res.transactionHash,
    });
    if (!receipt || receipt.status !== "success") {
      throw new Error(`approve reverted (${res.transactionHash})`);
    }
  }

  const contract = getPoolContract(assetCode);
  const tx = prepareContractCall({
    contract,
    method: "function fundPool(uint256 amount)",
    params: [rawAmount],
  });
  const result = await sendTransaction({
    transaction: tx,
    account: adminAccount,
  });
  const receipt = await waitForReceipt({
    client,
    chain: sepolia,
    transactionHash: result.transactionHash,
  });
  if (!receipt || receipt.status !== "success") {
    throw new Error(`fundPool reverted (${result.transactionHash})`);
  }
  return result.transactionHash;
}

module.exports = {
  ONCHAIN_STATUS,
  planIdToBytes32,
  tokenAmountRaw,
  getPoolAddress,
  getPoolContract,
  getBeneficiaryAddress,
  readOnchainPlan,
  allocatePlanOnChain,
  releaseClaimOnChain,
  reclaimPlanOnChain,
  fundPoolOnChain,
};
