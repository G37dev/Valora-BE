const { createThirdwebClient, getContract } = require("thirdweb");

const { privateKeyAccount } = require("thirdweb/wallets");

const { sepolia } = require("./chain");

if (!process.env.THIRDWEB_SECRET_KEY) {
  throw new Error("THIRDWEB_SECRET_KEY belum dikonfigurasi.");
}

if (!process.env.VALORA_ADMIN_PRIVATE_KEY) {
  throw new Error("VALORA_ADMIN_PRIVATE_KEY belum dikonfigurasi.");
}

const client = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY,
});

const adminAccount = privateKeyAccount({
  client,
  privateKey: process.env.VALORA_ADMIN_PRIVATE_KEY,
});

const getContractInstance = (address) => {
  if (!address) {
    throw new Error("Contract address wajib diisi.");
  }

  return getContract({
    client,
    chain: sepolia,
    address,
  });
};

module.exports = {
  client,
  adminAccount,
  sepolia,
  getContractInstance,
};
