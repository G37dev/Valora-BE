const { createThirdwebClient, getContract, readContract } = require("thirdweb");

const { decimals, balanceOf } = require("thirdweb/extensions/erc20");
const { sepolia } = require("../../utils/chain");

const client = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY,
});

const POOLS = {
  USDT: {
    asset: "USDT",
    poolAddress: process.env.SWAP_USDT_POOL_ADDRESS,
    tokenAddress: process.env.USDT_DUMMY_CONTRACT_ADDRESS,
  },
  USDC: {
    asset: "USDC",
    poolAddress: process.env.SWAP_USDC_POOL_ADDRESS,
    tokenAddress: process.env.USDC_DUMMY_CONTRACT_ADDRESS,
  },
  GOLD: {
    asset: "GOLD",
    poolAddress: process.env.SWAP_GOLD_POOL_ADDRESS,
    tokenAddress: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
  },
  XAUT: {
    asset: "XAUT",
    poolAddress: process.env.SWAP_XAUT_POOL_ADDRESS,
    tokenAddress: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
  },
};

const POOL_ABI = [
  {
    type: "function",
    name: "tokenBalance",
    stateMutability: "view",
    inputs: [
      {
        name: "token",
        type: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
      },
    ],
  },
];

function getPoolConfig(asset) {
  const normalizedAsset = String(asset || "")
    .trim()
    .toUpperCase();

  const pool = POOLS[normalizedAsset];

  if (!pool) {
    throw new Error(`Pool asset tidak didukung: ${normalizedAsset}`);
  }

  if (!pool.poolAddress) {
    throw new Error(`Pool address ${normalizedAsset} belum dikonfigurasi`);
  }

  if (!pool.tokenAddress) {
    throw new Error(`Token address ${normalizedAsset} belum dikonfigurasi`);
  }

  return pool;
}

function getPoolContract(asset) {
  const pool = getPoolConfig(asset);

  return getContract({
    client,
    chain: sepolia,
    address: pool.poolAddress,
    abi: POOL_ABI,
  });
}

function getTokenContract(asset) {
  const pool = getPoolConfig(asset);

  return getContract({
    client,
    chain: sepolia,
    address: pool.tokenAddress,
  });
}

function formatBalance(rawBalance, tokenDecimals) {
  const raw = BigInt(rawBalance);

  if (tokenDecimals === 0) {
    return raw.toString();
  }

  const divisor = 10n ** BigInt(tokenDecimals);
  const integer = raw / divisor;
  const fraction = raw % divisor;

  if (fraction === 0n) {
    return integer.toString();
  }

  return `${integer}.${fraction
    .toString()
    .padStart(tokenDecimals, "0")
    .replace(/0+$/, "")}`;
}

async function getPoolTokenBalance(asset) {
  const pool = getPoolConfig(asset);

  const contract = getPoolContract(asset);
  const token = getTokenContract(asset);

  const [accountingRawBalance, erc20RawBalance, tokenDecimals] =
    await Promise.all([
      readContract({
        contract,
        method: "function tokenBalance(address token) view returns (uint256)",
        params: [pool.tokenAddress],
      }),

      balanceOf({
        contract: token,
        address: pool.poolAddress,
      }),

      decimals({
        contract: token,
      }),
    ]);

  const decimalsNumber = Number(tokenDecimals);

  const accountingRaw = accountingRawBalance.toString();

  const erc20Raw = erc20RawBalance.toString();

  return {
    asset: pool.asset,
    poolAddress: pool.poolAddress,
    tokenAddress: pool.tokenAddress,
    decimals: decimalsNumber,

    rawBalance: accountingRaw,
    balance: formatBalance(accountingRaw, decimalsNumber),

    erc20RawBalance: erc20Raw,
    erc20Balance: formatBalance(erc20Raw, decimalsNumber),
  };
}

async function getAllPoolBalances() {
  const assets = Object.keys(POOLS);

  return Promise.all(assets.map((asset) => getPoolTokenBalance(asset)));
}

async function getPoolBalanceMap() {
  const pools = await getAllPoolBalances();

  return pools.reduce((result, pool) => {
    result[pool.asset] = pool;
    return result;
  }, {});
}

module.exports = {
  client,
  POOLS,
  getPoolConfig,
  getPoolContract,
  getTokenContract,
  getPoolTokenBalance,
  getAllPoolBalances,
  getPoolBalanceMap,
};
