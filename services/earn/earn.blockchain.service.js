const { createThirdwebClient, getContract, readContract: twReadContract } = require("thirdweb");
const { withRpcRetry } = require("../../utils/rpcRetry");

// Semua readContract di file ini lewat retry — Infura/free-tier sering
// balas 429/response malformed (thirdweb crash .buffer) pada burst.
const readContract = (opts) => withRpcRetry(() => twReadContract(opts));

const { privateKeyAccount, smartWallet } = require("thirdweb/wallets");

const {
  getPaymasterAndData,
  ENTRYPOINT_ADDRESS_v0_7,
} = require("thirdweb/wallets/smart");

const { sepolia } = require("../../utils/chain");

const { isValidAddress, normalizeAsset } = require("./earn.validation");
const { cachedDecimals } = require("../rpcCache");

const client = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY,
});

if (!process.env.THIRDWEB_SECRET_KEY) {
  throw new Error("THIRDWEB_SECRET_KEY belum dikonfigurasi.");
}

if (!process.env.VALORA_ADMIN_PRIVATE_KEY) {
  throw new Error("VALORA_ADMIN_PRIVATE_KEY belum dikonfigurasi.");
}

const adminAccount = privateKeyAccount({
  client,
  privateKey: process.env.VALORA_ADMIN_PRIVATE_KEY,
});

const getAssetTokenAddress = (asset) => {
  const normalized = normalizeAsset(asset);

  if (!normalized) {
    return null;
  }

  const tokenMap = {
    USDT: process.env.USDT_DUMMY_CONTRACT_ADDRESS,
    USDC: process.env.USDC_DUMMY_CONTRACT_ADDRESS,
    GOLD: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
    XAUT: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
  };

  return tokenMap[normalized] || null;
};

const getRouterAddress = () => {
  const address = process.env.EARN_ROUTER_CONTRACT_ADDRESS;

  if (!address) {
    throw new Error("EARN_ROUTER_CONTRACT_ADDRESS belum dikonfigurasi.");
  }

  if (!isValidAddress(address)) {
    throw new Error(`EARN_ROUTER_CONTRACT_ADDRESS tidak valid: ${address}`);
  }

  return address;
};

const getEarnPoolAddress = (asset) => {
  const normalized = normalizeAsset(asset);

  const poolMap = {
    USDT: process.env.EARN_USDT_POOL_CONTRACT_ADDRESS,
    USDC: process.env.EARN_USDC_POOL_CONTRACT_ADDRESS,
    GOLD: process.env.EARN_GOLD_POOL_CONTRACT_ADDRESS,
    XAUT: process.env.EARN_XAUT_POOL_CONTRACT_ADDRESS,
  };

  const address = poolMap[normalized];

  if (!address) {
    throw new Error(`Earn Pool untuk ${normalized} belum dikonfigurasi.`);
  }

  if (!isValidAddress(address)) {
    throw new Error(`Earn Pool ${normalized} tidak valid.`);
  }

  return address;
};

const getFactoryAddress = () => {
  const address = process.env.TW_FACTORY_ADDRESS;

  if (!address) {
    throw new Error("TW_FACTORY_ADDRESS belum dikonfigurasi.");
  }

  if (!isValidAddress(address)) {
    throw new Error(`TW_FACTORY_ADDRESS tidak valid: ${address}`);
  }

  return address;
};

const getTokenContract = (tokenAddress) => {
  if (!isValidAddress(tokenAddress)) {
    throw new Error(`Token address tidak valid: ${tokenAddress}`);
  }

  return getContract({
    client,
    chain: sepolia,
    address: tokenAddress,
  });
};

const getRouterContract = () => {
  return getContract({
    client,
    chain: sepolia,
    address: getRouterAddress(),
  });
};

const getTokenDecimals = async (tokenAddress) => {
  const contract = getTokenContract(tokenAddress);
  return cachedDecimals(contract, readContract);
};

const getTokenAllowance = async ({ tokenAddress, owner, spender }) => {
  const contract = getTokenContract(tokenAddress);

  const allowance = await readContract({
    contract,
    method:
      "function allowance(address owner,address spender) view returns (uint256)",
    params: [owner, spender],
  });

  return BigInt(allowance);
};

/**
 * Minimum callGasLimit untuk sponsored UserOp.
 *
 * Estimasi gas dari bundler/paymaster thirdweb kadang underestimate
 * untuk call yang banyak cold SSTORE (createEarn butuh ~390k, sempat
 * diestimasi 170k dan revert OOG di dalam UserOp).
 *
 * Di thirdweb@5.x jalur sponsorGas selalu menimpa callGasLimit dengan
 * hasil paymaster/bundler, dan field gas ikut ditandatangani paymaster
 * — jadi nilai tidak bisa diubah setelah pm_sponsorUserOperation.
 *
 * Workaround: double-call. Call pertama dapatkan paymasterData; call
 * kedua kirim op yang sudah berisi paymasterData + callGasLimit target
 * — dalam kondisi itu paymaster menandatangani nilai yang direquest.
 */
const MIN_CALL_GAS_LIMIT = BigInt(
  process.env.AA_MIN_CALL_GAS_LIMIT || "500000",
);

const sponsoredPaymaster = async (userOp) => {
  // UserOp v0.7 pakai field factoryData/paymasterData terpisah; v0.6 pakai initCode/paymasterAndData
  const isV07 =
    userOp.factory !== undefined ||
    userOp.factoryData !== undefined ||
    userOp.paymaster !== undefined ||
    userOp.paymasterData !== undefined;

  const entrypointAddress = isV07
    ? ENTRYPOINT_ADDRESS_v0_7
    : "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";

  const pmCall = (op) =>
    getPaymasterAndData({
      userOp: op,
      client,
      chain: sepolia,
      entrypointAddress,
    });

  const r1 = await pmCall(userOp);

  if (!r1?.paymaster && !r1?.paymasterAndData) {
    return r1;
  }

  // callGasLimit awal = estimasi lokal prepareContractCall (tx.gas)
  const requested = BigInt(userOp.callGasLimit ?? 0n);
  const targetCallGas =
    requested * 2n > MIN_CALL_GAS_LIMIT ? requested * 2n : MIN_CALL_GAS_LIMIT;

  const signedOp = { ...userOp, callGasLimit: targetCallGas };
  if (isV07) {
    signedOp.paymaster = r1.paymaster;
    signedOp.paymasterData = r1.paymasterData;
  } else {
    signedOp.paymasterAndData = r1.paymasterAndData;
  }
  for (const key of [
    "verificationGasLimit",
    "preVerificationGas",
    "paymasterVerificationGasLimit",
    "paymasterPostOpGasLimit",
  ]) {
    if (r1[key] !== undefined) signedOp[key] = r1[key];
  }

  const r2 = await pmCall(signedOp);

  console.log("[AA PM] callGasLimit:", {
    pmEstimate: r1.callGasLimit?.toString(),
    final: r2.callGasLimit?.toString(),
  });

  return r2;
};

const getUserSmartAccount = async (userWallet, coreId) => {
  if (!userWallet?.address) {
    throw new Error("Smart Wallet user tidak ditemukan.");
  }

  const factoryAddress = getFactoryAddress();

  const wallet = smartWallet({
    chain: sepolia,
    factoryAddress,
    sponsorGas: true,
    overrides: {
      accountAddress: userWallet.address,
      accountSalt: String(coreId),
      paymaster: sponsoredPaymaster,
    },
  });

  const smartAccount = await wallet.connect({
    client,
    personalAccount: adminAccount,
  });

  if (!smartAccount?.address) {
    throw new Error("Gagal mendapatkan Smart Account.");
  }

  if (smartAccount.address.toLowerCase() !== userWallet.address.toLowerCase()) {
    throw new Error("Smart Wallet mismatch.");
  }

  return smartAccount;
};

const getPoolRouterAddress = async (poolAddress) => {
  const poolContract = getContract({
    client,
    chain: sepolia,
    address: poolAddress,
  });

  return await readContract({
    contract: poolContract,
    method: "function router() view returns (address)",
    params: [],
  });
};

const getPoolContract = (poolAddress) =>
  getContract({ client, chain: sepolia, address: poolAddress });

/** Baca Position struct dari EarnAssetPool. */
const readPoolPosition = async (poolAddress, positionId) => {
  const result = await readContract({
    contract: getPoolContract(poolAddress),
    method:
      "function positions(uint256) view returns (uint256 principalRaw, address owner, uint64 maturityAt, uint16 aprBps, uint16 termCode, uint8 status)",
    params: [BigInt(positionId)],
  });
  return {
    principalRaw: BigInt(result.principalRaw ?? result[0]),
    owner: result.owner ?? result[1],
    maturityAt: Number(result.maturityAt ?? result[2]),
    aprBps: Number(result.aprBps ?? result[3]),
    termCode: Number(result.termCode ?? result[4]),
    status: Number(result.status ?? result[5]), // 0=Active, 1=Claimed
    exists:
      (result.owner ?? result[1]) &&
      (result.owner ?? result[1]) !==
        "0x0000000000000000000000000000000000000000",
  };
};

const readNextPositionId = async (poolAddress) => {
  const result = await readContract({
    contract: getPoolContract(poolAddress),
    method: "function nextPositionId() view returns (uint256)",
    params: [],
  });
  return BigInt(result);
};

const readPlatformFeeBps = async (poolAddress) => {
  const result = await readContract({
    contract: getPoolContract(poolAddress),
    method: "function platformFeeBps() view returns (uint16)",
    params: [],
  });
  return Number(result);
};

/** Baca APR on-chain untuk termCode (0 = term tidak didukung pool). */
const readAprBps = async (poolAddress, termCode) => {
  // Pool v2 pakai aprConfigs(uint16); legacy v1 pakai uint8 —
  // selector beda, jadi fallback kalau versi baru revert.
  try {
    const result = await readContract({
      contract: getPoolContract(poolAddress),
      method: "function aprConfigs(uint16) view returns (uint16)",
      params: [Number(termCode)],
    });
    return Number(result);
  } catch {
    const result = await readContract({
      contract: getPoolContract(poolAddress),
      method: "function aprConfigs(uint8) view returns (uint16)",
      params: [Number(termCode)],
    });
    return Number(result);
  }
};

const readTokenBalance = async ({ tokenAddress, owner }) => {
  const result = await readContract({
    contract: getTokenContract(tokenAddress),
    method: "function balanceOf(address) view returns (uint256)",
    params: [owner],
  });
  return BigInt(result);
};

/**
 * Cari posisi on-chain yang "yatim": dibuat untuk `user` dengan
 * principal+termCode cocok tapi belum tercatat di DB (worker crash
 * setelah tx tapi sebelum update). Scan beberapa posisi terakhir.
 */
const findOrphanPosition = async ({
  poolAddress,
  user,
  expectedPrincipal,
  termCode,
  createdAfter,
  scanLast = 5,
}) => {
  const nextId = await readNextPositionId(poolAddress);
  const ownerLc = user.toLowerCase();
  const afterMs = createdAfter ? new Date(createdAfter).getTime() : 0;

  for (
    let id = nextId - 1n;
    id >= 1n && id >= nextId - BigInt(scanLast);
    id -= 1n
  ) {
    const pos = await readPoolPosition(poolAddress, id);
    if (
      pos.exists &&
      pos.owner.toLowerCase() === ownerLc &&
      pos.termCode === termCode &&
      pos.principalRaw === expectedPrincipal &&
      pos.maturityAt * 1000 > afterMs
    ) {
      return { positionId: id.toString(), ...pos };
    }
  }
  return null;
};

module.exports = {
  client,
  adminAccount,
  getAssetTokenAddress,
  getRouterAddress,
  getEarnPoolAddress,
  getTokenContract,
  getRouterContract,
  getTokenDecimals,
  getTokenAllowance,
  getUserSmartAccount,
  getPoolRouterAddress,
  getPoolContract,
  readPoolPosition,
  readNextPositionId,
  readPlatformFeeBps,
  readAprBps,
  readTokenBalance,
  findOrphanPosition,
};
