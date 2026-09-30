const { createThirdwebClient, getContract, readContract } = require("thirdweb");

const { privateKeyAccount, smartWallet } = require("thirdweb/wallets");

const { sepolia } = require("thirdweb/chains");

const { isValidAddress, normalizeAsset } = require("./earn.validation");

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

  const decimals = await readContract({
    contract,
    method: "function decimals() view returns (uint8)",
    params: [],
  });

  return Number(decimals);
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
};
