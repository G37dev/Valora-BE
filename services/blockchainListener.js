require("dotenv").config();
const {
  createThirdwebClient,
  getContract,
  prepareEvent,
  watchContractEvents,
} = require("thirdweb");
const { sepolia: customSepolia } = require("../utils/chain");
const { toTokens } = require("thirdweb/utils");
const { decimals } = require("thirdweb/extensions/erc20");
const { Op } = require("sequelize");
const {
  Wallet,
  Transaction,
  Swap,
  LoanCollateralRelease,
  LoanLiquidation,
} = require("../models");
process.on("unhandledRejection", (reason) => {
  console.error("[RPC Error]:", reason?.message || reason);
});
if (!process.env.THIRDWEB_SECRET_KEY) {
  console.error("THIRDWEB_SECRET_KEY tidak ditemukan");
}
const client = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY,
});

const normalizeAddress = (address) =>
  address ? String(address).trim().toLowerCase() : "";
const getTokensToWatch = () => [
  {
    name: "USDT",
    address: process.env.USDT_DUMMY_CONTRACT_ADDRESS,
    earnPoolAddress: process.env.EARN_USDT_POOL_CONTRACT_ADDRESS,
    swapPoolAddress: process.env.SWAP_USDT_POOL_ADDRESS,
  },
  {
    name: "USDC",
    address: process.env.USDC_DUMMY_CONTRACT_ADDRESS,
    earnPoolAddress: process.env.EARN_USDC_POOL_CONTRACT_ADDRESS,
    swapPoolAddress: process.env.SWAP_USDT_POOL_ADDRESS,
  },
  {
    name: "GOLD",
    address: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
    earnPoolAddress: process.env.EARN_GOLD_POOL_CONTRACT_ADDRESS,
    swapPoolAddress: process.env.SWAP_GOLD_POOL_ADDRESS,
    installmentPoolAddress: process.env.INSTALLMENT_GOLD_POOL_ADDRESS,
  },
  {
    name: "XAUT",
    address: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
    earnPoolAddress: process.env.EARN_XAUT_POOL_CONTRACT_ADDRESS,
    swapPoolAddress: process.env.SWAP_XAUT_POOL_ADDRESS,
    installmentPoolAddress: process.env.INSTALLMENT_XAUT_POOL_ADDRESS,
  },
];
const getEarnPoolAddresses = () =>
  getTokensToWatch()
    .map((token) => token.earnPoolAddress)
    .filter(Boolean)
    .map(normalizeAddress);
const getSwapPoolAddresses = () =>
  getTokensToWatch()
    .map((token) => token.swapPoolAddress)
    .filter(Boolean)
    .map(normalizeAddress);
const getInstallmentPoolAddresses = () =>
  getTokensToWatch()
    .map((token) => token.installmentPoolAddress)
    .filter(Boolean)
    .map(normalizeAddress);
const getLoanEscrowAddresses = () =>
  [process.env.LOAN_ESCROW_XAUT_ADDRESS, process.env.LOAN_ESCROW_GOLD_ADDRESS]
    .filter(Boolean)
    .map(normalizeAddress);
const findLoanReleaseType = async (txHash) => {
  const release = await LoanCollateralRelease.findOne({
    where: { txHash },
  });
  if (release) {
    return release.kind === "LIQUIDATION_REFUND"
      ? "LIQUIDATION_REFUND"
      : "COLLATERAL_RELEASE";
  }
  const liquidation = await LoanLiquidation.findOne({
    where: { txHash },
  });
  if (liquidation) return "LIQUIDATION_REFUND";
  return "COLLATERAL_RELEASE";
};
const findExistingTransaction = async (txHash) => {
  if (!txHash) return null;
  return Transaction.findOne({ where: { tx_hash: txHash } });
};
const findSwapPayout = async (txHash) => {
  if (!txHash) return null;
  return Swap.findOne({ where: { withdrawalTxHash: txHash } });
};
const findWalletByAddress = async (address) => {
  if (!address) return null;
  return Wallet.findOne({ where: { address: { [Op.iLike]: address } } });
};
const createDepositTransaction = async ({
  receiverWallet,
  token,
  value,
  txHash,
  blockNumber,
  tokenDecimals,
  type = "DEPOSIT",
}) => {
  const formattedAmount = toTokens(value, tokenDecimals);
  return Transaction.create({
    core_id: receiverWallet.core_id,
    tx_hash: txHash,
    type,
    asset: token.name,
    amount: formattedAmount,
    tx_block_number: Number(blockNumber),
    status: "PENDING",
  });
};
const handleTransferEvent = async ({ event, token }) => {
  const from = event.args?.from;
  const to = event.args?.to;
  const value = event.args?.value;
  const txHash = event.transactionHash;
  const blockNumber = event.blockNumber;
  if (!to || !txHash || value === undefined || value === null) {
    return;
  }
  const normalizedFrom = normalizeAddress(from);
  const normalizedTo = normalizeAddress(to);
  console.log(`[Blockchain] ${token.name} Transfer`, {
    from,
    to,
    value: value.toString(),
    txHash,
    blockNumber,
  });
  const existingTx = await findExistingTransaction(txHash);
  if (existingTx) {
    console.log(`[Blockchain] TX sudah tercatat: ${txHash}`);
    return;
  }
  const swapPayout = await findSwapPayout(txHash);
  if (swapPayout) {
    console.log(`[Blockchain] Skip SWAP payout: ${txHash}`);
    return;
  }
  const earnPoolAddresses = getEarnPoolAddresses();
  const swapPoolAddresses = getSwapPoolAddresses();
  const installmentPoolAddresses = getInstallmentPoolAddresses();
  if (earnPoolAddresses.includes(normalizedFrom)) {
    console.log(`[Blockchain] Skip Earn Pool payout: ${txHash}`);
    return;
  }
  if (swapPoolAddresses.includes(normalizedFrom)) {
    console.log(`[Blockchain] Skip Swap Pool payout: ${txHash}`);
    return;
  }
  if (installmentPoolAddresses.includes(normalizedFrom)) {
    console.log(`[Blockchain] Skip Installment Pool payout: ${txHash}`);
    return;
  }
  const receiverWallet = await findWalletByAddress(to);
  if (!receiverWallet) {
    console.log(`[Blockchain] Receiver bukan wallet user terdaftar: ${to}`);
    return;
  }
  const loanEscrowAddresses = getLoanEscrowAddresses();
  let txType = "DEPOSIT";
  if (loanEscrowAddresses.includes(normalizedFrom)) {
    // Payout dari escrow loan = collateral release / liquidation refund,
    // bukan deposit bebas.
    txType = await findLoanReleaseType(txHash);
  }
  const contract = getContract({
    client,
    chain: customSepolia,
    address: token.address,
  });
  let tokenDecimals;
  try {
    tokenDecimals = await decimals({ contract });
  } catch (error) {
    console.error(
      `[Blockchain] Gagal membaca decimals ${token.name}:`,
      error?.message || error,
    );
    return;
  }
  const transaction = await createDepositTransaction({
    receiverWallet,
    token,
    value,
    txHash,
    blockNumber,
    tokenDecimals,
    type: txType,
  });
  console.log(`[Blockchain] ${txType} ${token.name} tersimpan`, {
    id: transaction.id,
    coreId: transaction.core_id,
    amount: transaction.amount,
    txHash: transaction.tx_hash,
  });
};
const startBlockchainListener = async () => {
  console.log("");
  console.log("========================================");
  console.log("MULTI-TOKEN BLOCKCHAIN LISTENER");
  console.log("========================================");
  const tokensToWatch = getTokensToWatch();
  const transferEvent = prepareEvent({
    signature:
      "event Transfer(address indexed from,address indexed to,uint256 value)",
  });
  for (const token of tokensToWatch) {
    if (!token.address) {
      console.warn(`Alamat contract ${token.name} belum dikonfigurasi`);
      continue;
    }
    const contract = getContract({
      client,
      chain: customSepolia,
      address: token.address,
    });
    console.log("");
    console.log(`Watching ${token.name}`);
    console.log(`Token: ${token.address}`);
    console.log(`Earn Pool: ${token.earnPoolAddress || "NOT CONFIGURED"}`);
    console.log(`Swap Pool: ${token.swapPoolAddress || "NOT CONFIGURED"}`);
    console.log(
      `Installment Pool: ${token.installmentPoolAddress || "NOT CONFIGURED"}`,
    );
    watchContractEvents({
      contract,
      events: [transferEvent],
      onEvents: async (events) => {
        if (!Array.isArray(events) || !events.length) {
          return;
        }
        for (const event of events) {
          try {
            await handleTransferEvent({ event, token });
          } catch (error) {
            console.error(
              `[Blockchain] Gagal memproses ${token.name}:`,
              error?.message || error,
            );
          }
        }
      },
    });
  }
  console.log("");
  console.log("========================================");
  console.log("Blockchain listener aktif");
  console.log("========================================");
};
module.exports = {
  startBlockchainListener,
  handleTransferEvent,
  getTokensToWatch,
  client,
  customSepolia,
};
