const {
  prepareContractCall,
  sendTransaction,
  waitForReceipt,
  getContract,
} = require("thirdweb");

const {
  client,
  getTokenContract,
  getTokenAllowance,
  waitForAllowance,
  getEarnPoolAddress,
  getRouterContract,
} = require("./earn.blockchain.service");

const { sepolia } = require("../../utils/chain");

const ensureTokenAllowance = async ({
  tokenAddress,
  asset,
  owner,
  amount,
  smartAccount,
}) => {
  const poolAddress = getEarnPoolAddress(asset);

  console.log("[Earn TX] Checking allowance:", {
    token: tokenAddress,
    owner,
    spender: poolAddress,
    amount: amount.toString(),
  });

  const currentAllowance = await getTokenAllowance({
    tokenAddress,
    owner,
    spender: poolAddress,
  });

  console.log("[Earn TX] Current allowance:", currentAllowance.toString());

  if (currentAllowance >= amount) {
    return {
      approved: false,
      allowance: currentAllowance,
      txHash: null,
    };
  }

  console.log("[Earn TX] Approval diperlukan.");
  console.log("[Earn TX] Approving pool:", poolAddress);

  const tokenContract = getTokenContract(tokenAddress);

  const transaction = prepareContractCall({
    contract: tokenContract,
    method: "function approve(address spender,uint256 amount) returns (bool)",
    params: [poolAddress, amount],
  });

  const result = await sendTransaction({
    transaction,
    account: smartAccount,
  });

  const txHash = result?.transactionHash;

  if (!txHash) {
    throw new Error("Transaction hash approve tidak ditemukan.");
  }

  console.log("[Earn TX] APPROVE TX:", txHash);

  const receipt = await waitForReceipt({
    client,
    chain: sepolia,
    transactionHash: txHash,
  });

  if (!receipt || receipt.status !== "success") {
    throw new Error(`Approve gagal/reverted. tx=${txHash}`);
  }

  const newAllowance = await waitForAllowance({
    tokenAddress,
    owner,
    spender: poolAddress,
    required: amount,
  });

  console.log("[Earn TX] New allowance:", newAllowance.toString());

  if (newAllowance < amount) {
    throw new Error(
      `Allowance masih tidak cukup. allowance=${newAllowance.toString()}, required=${amount.toString()}`,
    );
  }

  return {
    approved: true,
    allowance: newAllowance,
    txHash,
  };
};

const createEarnTransaction = async ({
  tokenAddress,
  amount,
  termCode,
  smartAccount,
}) => {
  const routerContract = getRouterContract();

  console.log("[Earn TX] Creating Earn:", {
    token: tokenAddress,
    amount: amount.toString(),
    termCode,
    account: smartAccount.address,
  });

  const transaction = prepareContractCall({
    contract: routerContract,
    method: "function createEarn(address token,uint256 amount,uint16 termCode)",
    params: [tokenAddress, amount, termCode],
  });

  const result = await sendTransaction({
    transaction,
    account: smartAccount,
  });

  const txHash = result?.transactionHash;

  if (!txHash) {
    throw new Error("Transaction hash createEarn tidak ditemukan.");
  }

  console.log("[Earn TX] CREATE EARN TX:", txHash);

  return txHash;
};

const claimEarnTransaction = async ({
  tokenAddress,
  positionId,
  smartAccount,
  routerAddress,
}) => {
  const routerContract = routerAddress
    ? getContract({ client, chain: sepolia, address: routerAddress })
    : getRouterContract();

  console.log("[Earn TX] Claiming Earn:", {
    token: tokenAddress,
    positionId: positionId.toString(),
    account: smartAccount.address,
  });

  const transaction = prepareContractCall({
    contract: routerContract,
    method: "function claim(address token,uint256 positionId)",
    params: [tokenAddress, positionId],
  });

  const result = await sendTransaction({
    transaction,
    account: smartAccount,
  });

  const txHash = result?.transactionHash;

  if (!txHash) {
    throw new Error("Transaction hash claim tidak ditemukan.");
  }

  console.log("[Earn TX] CLAIM TX:", txHash);

  return txHash;
};

module.exports = {
  ensureTokenAllowance,
  createEarnTransaction,
  claimEarnTransaction,
};
