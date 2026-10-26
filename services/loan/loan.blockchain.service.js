/*
 * Blockchain adapter LoanCollateralEscrow (brief 17 / D.3).
 *
 * Desain kontrak (disepakati): SATU codebase escrow, di-deploy TERPISAH per
 * aset (XAUT & VVLR) -> blast radius terisolasi, pause per aset.
 * Kontrak = "dumb escrow": custody + eksekusi instruksi bertanda tangan.
 * Tidak ada business logic / oracle / IDR di on-chain.
 *
 *   lock(bytes32 positionId, address owner, uint256 amount)
 *       operator pull transferFrom(owner) — allowance escrow dipastikan
 *       backend via UserOp approve() dari smart account user (AA
 *       backend-custodial: admin signer + sponsored gas — sama dengan
 *       pola earn ensureApproval). User tidak perlu approve manual.
 *   release(bytes32 positionId, address to, uint256 amount, uint256 nonce)
 *       kontrak memaksa to == owner posisi — hot key tak bisa redirect dana
 *   settle(bytes32 positionId, address user, uint256 refundAmount,
 *          address treasury, uint256 treasuryAmount, uint256 nonce,
 *          uint256 expiresAt, bytes signature)      -- atomic split
 *       signature = EIP-191 settlementSigner atas digest
 *       keccak256(abi.encode(chainId, contract, positionId, user, refund,
 *                            treasury, treasuryAmount, nonce, expiresAt))
 *   getPosition(bytes32) view returns (address owner, uint256 locked, uint8 status)
 *
 * Mode:
 *   LOAN_CHAIN_MODE=mock (default bila alamat escrow belum di-set) ->
 *     tidak menyentuh chain; tx hash deterministik "0xmock…". Semua flow
 *     finansial tetap bisa di-QA end-to-end.
 *   LOAN_CHAIN_MODE=live -> thirdweb + operator VALORA_ADMIN_* (sama dengan
 *     installment/earn). Env: LOAN_ESCROW_XAUT_ADDRESS, LOAN_ESCROW_GOLD_ADDRESS,
 *     LOAN_TREASURY_WALLET_ADDRESS.
 *
 * positionId on-chain = keccak256(uuid) deterministik.
 */

const crypto = require("crypto");
const Decimal = require("decimal.js");
const { ASSET } = require("./loan.constants");
const { tokenRaw } = require("./loan.calc");
const { Wallet } = require("../../models");

const ESCROW_ADDRESS = {
  [ASSET.XAUT]: process.env.LOAN_ESCROW_XAUT_ADDRESS,
  [ASSET.GOLD]: process.env.LOAN_ESCROW_GOLD_ADDRESS,
};
const TOKEN_ADDRESS = {
  [ASSET.XAUT]: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
  [ASSET.GOLD]: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
};
const TREASURY_WALLET =
  process.env.LOAN_TREASURY_WALLET_ADDRESS ||
  "0x000000000000000000000000000000000000dEaD";

const MODE =
  String(process.env.LOAN_CHAIN_MODE || "").toLowerCase() === "live" &&
  ESCROW_ADDRESS[ASSET.XAUT] &&
  ESCROW_ADDRESS[ASSET.GOLD]
    ? "live"
    : "mock";

const CHAIN_ID = Number(process.env.LOAN_CHAIN_ID || 11155111);

// Lazy-load thirdweb hanya pada mode live (hemat cold start serverless).
let tw = null;
function thirdweb() {
  if (tw) return tw;
  const {
    keccak256,
    stringToHex,
    encodeAbiParameters,
  } = require("thirdweb/utils");
  const {
    getContract,
    readContract,
    prepareContractCall,
    sendTransaction,
    waitForReceipt,
  } = require("thirdweb");
  const { sepolia } = require("../../utils/chain");
  const { client, adminAccount } = require("../earn/earn.blockchain.service");
  tw = {
    keccak256,
    stringToHex,
    encodeAbiParameters,
    getContract,
    readContract,
    prepareContractCall,
    sendTransaction,
    waitForReceipt,
    sepolia,
    client,
    adminAccount,
  };
  return tw;
}

function positionIdBytes32(positionId) {
  if (MODE === "live") {
    const { keccak256, stringToHex } = thirdweb();
    return keccak256(stringToHex(String(positionId)));
  }
  return `0x${crypto.createHash("sha256").update(String(positionId)).digest("hex")}`;
}

function mockHash(...parts) {
  return `0xmock${crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 58)}`;
}

async function getBeneficiaryAddress(coreId) {
  const wallet = await Wallet.findOne({ where: { core_id: coreId } });
  return wallet?.address || null;
}

function escrowContract(asset) {
  const { getContract, sepolia, client } = thirdweb();
  return getContract({
    client,
    chain: sepolia,
    address: ESCROW_ADDRESS[asset],
  });
}

async function sendEscrowTx(asset, method, params, label) {
  const {
    prepareContractCall,
    sendTransaction,
    waitForReceipt,
    adminAccount,
    client,
    sepolia,
  } = thirdweb();
  const transaction = prepareContractCall({
    contract: escrowContract(asset),
    method,
    params,
  });
  const result = await sendTransaction({ transaction, account: adminAccount });
  const txHash = result?.transactionHash;
  if (!txHash) throw new Error(`${label}: transaction hash missing`);
  const receipt = await waitForReceipt({
    client,
    chain: sepolia,
    transactionHash: txHash,
  });
  if (!receipt || receipt.status !== "success")
    throw new Error(`${label}: tx reverted (${txHash})`);
  return txHash;
}

/**
 * Pastikan allowance escrow >= amount yang mau di-lock.
 * AA backend-custodial: approve dieksekusi sebagai UserOp dari smart
 * account user — admin backend sebagai signer, gas di-sponsor paymaster.
 * Mengikuti pola earn.ensureApproval. Return approve txHash atau null
 * bila allowance sudah cukup.
 */
async function ensureEscrowAllowance(position, ownerAddress, raw) {
  const earn = require("../earn/earn.blockchain.service");
  const {
    prepareContractCall,
    sendTransaction,
    waitForReceipt,
    client,
    sepolia,
  } = thirdweb();

  const tokenAddress = TOKEN_ADDRESS[position.collateralAsset];
  const escrow = ESCROW_ADDRESS[position.collateralAsset];
  if (!tokenAddress)
    throw new Error(
      `token address untuk ${position.collateralAsset} belum di-set`,
    );

  const allowance = await earn.getTokenAllowance({
    tokenAddress,
    owner: ownerAddress,
    spender: escrow,
  });
  if (BigInt(allowance) >= raw) return null;

  if (!position.coreId)
    throw new Error("position.coreId dibutuhkan untuk AA approve");

  const smartAccount = await earn.getUserSmartAccount(
    { address: ownerAddress },
    position.coreId,
  );

  const transaction = prepareContractCall({
    contract: earn.getTokenContract(tokenAddress),
    method: "function approve(address spender,uint256 amount) returns (bool)",
    params: [escrow, raw],
  });
  const result = await sendTransaction({ transaction, account: smartAccount });
  const txHash = result?.transactionHash;
  if (!txHash) throw new Error("approve: transaction hash missing");

  const receipt = await waitForReceipt({
    client,
    chain: sepolia,
    transactionHash: txHash,
  });
  if (!receipt || receipt.status !== "success")
    throw new Error(`approve: tx reverted (${txHash})`);

  const after = await earn.getTokenAllowance({
    tokenAddress,
    owner: ownerAddress,
    spender: escrow,
  });
  if (BigInt(after) < raw)
    throw new Error(
      `approve: allowance masih kurang (${after} < ${raw}) setelah ${txHash}`,
    );
  return txHash;
}

/** Lock collateral user ke escrow. */
async function lockCollateral(position, ownerAddress, qty) {
  const raw = tokenRaw(qty, position.tokenDecimals);
  if (MODE === "mock")
    return mockHash("lock", position.id, ownerAddress, raw.toString());
  await ensureEscrowAllowance(position, ownerAddress, raw);
  return sendEscrowTx(
    position.collateralAsset,
    "function lock(bytes32 positionId, address owner, uint256 amount)",
    [positionIdBytes32(position.id), ownerAddress, raw],
    "lock",
  );
}

/** Partial/full release ke user. */
async function releaseCollateral(position, recipient, qty, nonce) {
  const raw = tokenRaw(qty, position.tokenDecimals);
  if (raw <= 0n) throw new Error("release amount rounds to zero raw units");
  if (MODE === "mock")
    return mockHash("release", position.id, recipient, raw.toString(), nonce);
  return sendEscrowTx(
    position.collateralAsset,
    "function release(bytes32 positionId, address to, uint256 amount, uint256 nonce)",
    [positionIdBytes32(position.id), recipient, raw, BigInt(nonce)],
    "release",
  );
}

/**
 * Signed settlement instruction (D.3). Backend menandatangani payload
 * kanonik; kontrak memverifikasi signer/roles, qty, recipient, nonce, expiry.
 * Mock: HMAC-SHA256 (JWT_SECRET) agar deterministik & bisa diverifikasi di QA.
 */
function buildSettlementInstruction(
  position,
  liq,
  { now, expiresInSeconds = 900, policyVersion },
) {
  return {
    position_id: position.id,
    settlement_id: liq.id,
    chain_id: CHAIN_ID,
    contract_address: ESCROW_ADDRESS[position.collateralAsset] || "mock",
    collateral_token:
      TOKEN_ADDRESS[position.collateralAsset] || position.collateralAsset,
    locked_qty_raw: tokenRaw(liq.lockedQty, position.tokenDecimals).toString(),
    debt_alloc_qty_raw: tokenRaw(
      liq.debtAllocQty,
      position.tokenDecimals,
    ).toString(),
    compensation_qty_raw: tokenRaw(
      liq.compensationQty,
      position.tokenDecimals,
    ).toString(),
    refund_qty_raw: tokenRaw(liq.refundQty, position.tokenDecimals).toString(),
    user_recipient: liq.userRecipient,
    treasury_recipient: liq.treasuryRecipient,
    total_debt_due_idr: new Decimal(liq.totalDebtDueIdr).toFixed(0),
    validated_price_idr: new Decimal(liq.referencePriceIdr).toFixed(0),
    haircut_bps: liq.haircutBps,
    price_source: liq.priceSource,
    price_timestamp: liq.priceObservedAt
      ? new Date(liq.priceObservedAt).toISOString()
      : null,
    risk_state: position.status,
    config_version: policyVersion || null,
    authorized_signer:
      MODE === "live" ? thirdweb().adminAccount.address : "mock-operator",
    nonce: liq.nonce,
    expires_at: new Date(now.getTime() + expiresInSeconds * 1000).toISOString(),
  };
}

/**
 * Digest yang diverifikasi kontrak di settle() — HARUS persis urutan
 * abi.encode on-chain:
 * (chainId, contractAddress, positionId, user, refundAmount, treasury,
 *  treasuryAmount, nonce, expiresAt)
 */
function settlementDigest(instruction) {
  const { keccak256, encodeAbiParameters } = thirdweb();
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" }, // chainid
        { type: "address" }, // escrow
        { type: "bytes32" }, // positionId
        { type: "address" }, // user
        { type: "uint256" }, // refundAmount
        { type: "address" }, // treasury
        { type: "uint256" }, // treasuryAmount
        { type: "uint256" }, // nonce
        { type: "uint256" }, // expiresAt
      ],
      [
        BigInt(instruction.chain_id),
        instruction.contract_address,
        positionIdBytes32(instruction.position_id),
        instruction.user_recipient,
        BigInt(instruction.refund_qty_raw),
        instruction.treasury_recipient,
        BigInt(instruction.debt_alloc_qty_raw) +
          BigInt(instruction.compensation_qty_raw),
        BigInt(instruction.nonce),
        BigInt(Math.floor(new Date(instruction.expires_at).getTime() / 1000)),
      ],
    ),
  );
}

async function signInstruction(instruction) {
  const canonical = JSON.stringify(
    instruction,
    Object.keys(instruction).sort(),
  );
  if (MODE === "live") {
    const { adminAccount } = thirdweb();
    // EIP-191 atas digest kanonik — dicocokkan kontrak via
    // toEthSignedMessageHash(digest).recover(sig) == settlementSigner
    return adminAccount.signMessage({
      message: { raw: settlementDigest(instruction) },
    });
  }
  return crypto
    .createHmac("sha256", process.env.JWT_SECRET || "loan-mock")
    .update(canonical)
    .digest("hex");
}

/** Atomic split: refund -> user, debt+comp -> treasury. */
async function settleLiquidation(position, liq, instruction, signature) {
  if (MODE === "mock") {
    return mockHash(
      "settle",
      position.id,
      liq.id,
      instruction.nonce,
      signature.slice(0, 16),
    );
  }
  return sendEscrowTx(
    position.collateralAsset,
    "function settle(bytes32 positionId, address user, uint256 refundAmount, address treasury, uint256 treasuryAmount, uint256 nonce, uint256 expiresAt, bytes signature)",
    [
      positionIdBytes32(position.id),
      instruction.user_recipient,
      BigInt(instruction.refund_qty_raw),
      instruction.treasury_recipient,
      BigInt(instruction.debt_alloc_qty_raw) +
        BigInt(instruction.compensation_qty_raw),
      BigInt(instruction.nonce),
      BigInt(Math.floor(new Date(instruction.expires_at).getTime() / 1000)),
      signature,
    ],
    "settle",
  );
}

async function readOnchainPosition(position) {
  if (MODE === "mock") {
    return {
      owner: position.ownerAddress,
      locked: tokenRaw(position.lockedQty, position.tokenDecimals),
      status: 1,
      mock: true,
    };
  }
  const { readContract } = thirdweb();
  const { withRpcRetry } = require("../../utils/rpcRetry");
  const [owner, locked, status] = await withRpcRetry(() =>
    readContract({
      contract: escrowContract(position.collateralAsset),
      method:
        "function getPosition(bytes32 positionId) view returns (address owner, uint256 locked, uint8 status)",
      params: [positionIdBytes32(position.id)],
    }),
  );
  return { owner, locked, status: Number(status) };
}

/** Estimasi gas release dalam IDR (tanpa markup). Mock: flat env. */
async function estimateReleaseGasIdr() {
  return new Decimal(process.env.LOAN_RELEASE_GAS_IDR || "15000");
}

module.exports = {
  MODE,
  CHAIN_ID,
  TREASURY_WALLET,
  ESCROW_ADDRESS,
  positionIdBytes32,
  getBeneficiaryAddress,
  lockCollateral,
  releaseCollateral,
  buildSettlementInstruction,
  signInstruction,
  settleLiquidation,
  readOnchainPosition,
  estimateReleaseGasIdr,
};
