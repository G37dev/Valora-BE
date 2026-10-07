const crypto = require("crypto");
const Decimal = require("decimal.js");
const { createThirdwebClient, getContract } = require("thirdweb");
const { balanceOf, decimals } = require("thirdweb/extensions/erc20");
const { sepolia } = require("thirdweb/chains");
const {
  sequelize,
  Swap,
  SwapEvent,
  Price,
  InternalWallet,
} = require("../../models");
const { swapQueue } = require("../../queues/swap.queue");
const thirdwebClient = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY,
});
const SWAP_FEE_RATE = new Decimal("0.0035");
const IDR_DECIMALS = 2;
const ASSETS = {
  USDT: {
    type: "BLOCKCHAIN",
    tokenAddress: process.env.USDT_DUMMY_CONTRACT_ADDRESS,
    poolAddress: process.env.SWAP_USDT_POOL_ADDRESS,
  },
  USDC: {
    type: "BLOCKCHAIN",
    tokenAddress: process.env.USDC_DUMMY_CONTRACT_ADDRESS,
    poolAddress: process.env.SWAP_USDC_POOL_ADDRESS,
  },
  GOLD: {
    type: "BLOCKCHAIN",
    tokenAddress: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
    poolAddress: process.env.SWAP_GOLD_POOL_ADDRESS,
  },
  XAUT: {
    type: "BLOCKCHAIN",
    tokenAddress: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
    poolAddress: process.env.SWAP_XAUT_POOL_ADDRESS,
  },
  IDR: { type: "INTERNAL", tokenAddress: null, poolAddress: null },
};
const FALLBACK_DECIMALS = { USDT: 6, USDC: 6, GOLD: 6, XAUT: 6 };
function normalizeAsset(asset) {
  return String(asset || "")
    .trim()
    .toUpperCase();
}
function validateAsset(asset) {
  const normalized = normalizeAsset(asset);
  if (!ASSETS[normalized]) {
    throw new Error(`Asset tidak didukung: ${normalized}`);
  }
  return normalized;
}
function decimal(value, fieldName = "amount") {
  try {
    const result = new Decimal(String(value));
    if (!result.isFinite()) {
      throw new Error();
    }
    return result;
  } catch {
    throw new Error(`${fieldName} tidak valid`);
  }
}
function decimalToString(value) {
  return new Decimal(value).toFixed();
}
function floorDecimal(value, decimals) {
  const factor = new Decimal(10).pow(decimals);
  return new Decimal(value).mul(factor).floor().div(factor);
}
function getAssetType(asset) {
  return ASSETS[asset].type;
}
function getPoolAddress(asset) {
  return ASSETS[asset].poolAddress;
}
function getTokenAddress(asset) {
  return ASSETS[asset].tokenAddress;
}
function createReference() {
  return `SWAP-${crypto.randomBytes(16).toString("hex").toUpperCase()}`;
}
async function getTokenContract(asset) {
  const normalizedAsset = validateAsset(asset);
  const tokenAddress = getTokenAddress(normalizedAsset);
  if (!tokenAddress) {
    throw new Error(`Contract token ${normalizedAsset} belum dikonfigurasi`);
  }
  return getContract({
    client: thirdwebClient,
    chain: sepolia,
    address: tokenAddress,
  });
}
async function getAssetDecimals(asset) {
  const normalizedAsset = validateAsset(asset);
  if (normalizedAsset === "IDR") {
    return IDR_DECIMALS;
  }
  try {
    const contract = await getTokenContract(normalizedAsset);
    return Number(await decimals({ contract }));
  } catch {
    return FALLBACK_DECIMALS[normalizedAsset];
  }
}
async function getAssetPrice(asset, transaction) {
  const normalizedAsset = validateAsset(asset);
  if (normalizedAsset === "IDR") {
    return new Decimal("1");
  }
  const price = await Price.findOne({
    where: { asset: normalizedAsset },
    transaction,
  });
  if (!price) {
    throw new Error(`Harga ${normalizedAsset}/IDR tidak ditemukan`);
  }
  const value = decimal(price.priceIdr, `${normalizedAsset} price`);
  if (value.lte(0)) {
    throw new Error(`Harga ${normalizedAsset}/IDR tidak valid`);
  }
  return value;
}

const XAUT_GRAMS = new Decimal("31.1035");

async function calculateSwapQuote({
  fromAmount,
  fromPriceIdr,
  toPriceIdr,
  fromAsset,
  toAsset,
}) {
  const amount = decimal(fromAmount, "fromAmount");

  if (amount.lte(0)) {
    throw new Error("Amount harus lebih besar dari 0");
  }

  let amountInPriceUnit = amount;

  if (fromAsset === "XAUT") {
    amountInPriceUnit = amount.mul(XAUT_GRAMS);
  }

  const grossValueIdr = amountInPriceUnit.mul(fromPriceIdr);

  const feeAmountIdr = grossValueIdr.mul(SWAP_FEE_RATE);

  const netValueIdr = grossValueIdr.sub(feeAmountIdr);

  if (grossValueIdr.lte(0)) {
    throw new Error("Gross value tidak valid");
  }

  if (netValueIdr.lte(0)) {
    throw new Error("Nilai setelah fee tidak valid");
  }

  let grossReceiveAmount;
  let feeAmount;
  let receiveAmount;

  if (toAsset === "IDR") {
    grossReceiveAmount = floorDecimal(netValueIdr, IDR_DECIMALS);
    feeAmount = floorDecimal(feeAmountIdr, IDR_DECIMALS);
    receiveAmount = grossReceiveAmount;
  } else {
    const tokenDecimals = await getAssetDecimals(toAsset);

    grossReceiveAmount = floorDecimal(
      grossValueIdr.div(toPriceIdr),
      tokenDecimals,
    );

    feeAmount = floorDecimal(feeAmountIdr.div(toPriceIdr), tokenDecimals);

    receiveAmount = floorDecimal(netValueIdr.div(toPriceIdr), tokenDecimals);
  }

  if (receiveAmount.lte(0)) {
    throw new Error("Receive amount terlalu kecil");
  }

  return {
    grossValueIdr,
    feeAmountIdr,
    netValueIdr,
    grossReceiveAmount,
    feeAmount,
    receiveAmount,
  };
}
async function validateInternalWallet({ coreId, amount, transaction }) {
  const wallet = await InternalWallet.findOne({
    where: { coreId },
    transaction,
  });
  if (!wallet) {
    throw new Error("Internal wallet tidak ditemukan");
  }
  const balance = decimal(wallet.balanceIdr, "internal wallet balance");
  if (balance.lt(amount)) {
    throw new Error("Saldo IDR tidak mencukupi");
  }
  return { wallet, balance };
}
async function getTokenBalance({ coreId, asset, walletAddress = null }) {
  if (!coreId) {
    throw new Error("coreId wajib ada");
  }
  const normalizedAsset = validateAsset(asset);
  if (normalizedAsset === "IDR") {
    const wallet = await InternalWallet.findOne({ where: { coreId } });
    if (!wallet) {
      throw new Error("Internal wallet tidak ditemukan");
    }
    const balance = decimal(wallet.balanceIdr, "internal wallet balance");
    const balanceRaw = balance
      .mul(new Decimal(10).pow(IDR_DECIMALS))
      .toFixed(0);
    return {
      asset: "IDR",
      type: "INTERNAL",
      walletAddress: null,
      balance: balance.toFixed(IDR_DECIMALS),
      balanceRaw,
      decimals: IDR_DECIMALS,
      contractAddress: null,
      poolAddress: null,
    };
  }
  if (!walletAddress) {
    throw new Error(`walletAddress wajib untuk ${normalizedAsset}`);
  }
  const contract = await getTokenContract(normalizedAsset);
  const tokenDecimals = Number(await decimals({ contract }));
  const rawBalance = await balanceOf({ contract, address: walletAddress });
  const balance = new Decimal(rawBalance.toString()).div(
    new Decimal(10).pow(tokenDecimals),
  );
  return {
    asset: normalizedAsset,
    type: "BLOCKCHAIN",
    walletAddress,
    balance: balance.toFixed(),
    balanceRaw: rawBalance.toString(),
    decimals: tokenDecimals,
    contractAddress: getTokenAddress(normalizedAsset),
    poolAddress: getPoolAddress(normalizedAsset) || null,
  };
}
async function queueSwap(swapId, coreId) {
  try {
    await swapQueue.add(
      "process-swap",
      { swapId, coreId },
      { jobId: `swap-${swapId}`, removeOnComplete: true, removeOnFail: false },
    );
  } catch (queueError) {
    await Swap.update(
      { failureReason: `Queue error: ${queueError.message}` },
      { where: { id: swapId } },
    );
    throw new Error(
      `Swap dibuat tetapi gagal masuk queue: ${queueError.message}`,
    );
  }
}
async function createSwapService({
  coreId,
  fromAsset,
  toAsset,
  fromAmount,
  idempotencyKey,
  fromWalletAddress = null,
  toWalletAddress = null,
}) {
  if (!coreId) {
    throw new Error("coreId wajib ada");
  }
  if (!idempotencyKey) {
    throw new Error("idempotencyKey wajib ada");
  }
  const normalizedFromAsset = validateAsset(fromAsset);
  const normalizedToAsset = validateAsset(toAsset);
  if (normalizedFromAsset === normalizedToAsset) {
    throw new Error("Asset asal dan tujuan tidak boleh sama");
  }
  const amount = decimal(fromAmount, "fromAmount");
  if (amount.lte(0)) {
    throw new Error("Amount harus lebih besar dari 0");
  }
  const existingSwap = await Swap.findOne({ where: { idempotencyKey } });
  if (existingSwap) {
    const sameRequest =
      existingSwap.coreId === coreId &&
      existingSwap.fromAsset === normalizedFromAsset &&
      existingSwap.toAsset === normalizedToAsset &&
      new Decimal(existingSwap.fromAmount).eq(amount);
    if (!sameRequest) {
      throw new Error("Idempotency key sudah digunakan untuk swap berbeda");
    }
    return { existing: true, swap: existingSwap };
  }
  const fromType = getAssetType(normalizedFromAsset);
  const toType = getAssetType(normalizedToAsset);
  const fromPoolAddress = getPoolAddress(normalizedFromAsset);
  const toPoolAddress = getPoolAddress(normalizedToAsset);
  if (fromType === "BLOCKCHAIN" && !fromWalletAddress) {
    throw new Error(`fromWalletAddress wajib untuk ${normalizedFromAsset}`);
  }
  if (toType === "BLOCKCHAIN" && !toWalletAddress) {
    throw new Error(`toWalletAddress wajib untuk ${normalizedToAsset}`);
  }
  const transaction = await sequelize.transaction();
  try {
    const fromPriceIdr = await getAssetPrice(normalizedFromAsset, transaction);
    const toPriceIdr = await getAssetPrice(normalizedToAsset, transaction);
    const quote = await calculateSwapQuote({
      fromAmount: amount,
      fromPriceIdr,
      toPriceIdr,
      fromAsset: normalizedFromAsset,
      toAsset: normalizedToAsset,
    });
    if (fromType === "INTERNAL") {
      await validateInternalWallet({ coreId, amount, transaction });
    }
    const swap = await Swap.create(
      {
        coreId,
        idempotencyKey,
        fromAsset: normalizedFromAsset,
        toAsset: normalizedToAsset,
        fromAmount: decimalToString(amount),
        toAmount: decimalToString(quote.receiveAmount),
        fromPriceIdr: decimalToString(fromPriceIdr),
        toPriceIdr: decimalToString(toPriceIdr),
        grossValueIdr: decimalToString(quote.grossValueIdr),
        feeRate: SWAP_FEE_RATE.toFixed(6),
        feeAmountIdr: decimalToString(quote.feeAmountIdr),
        feeAsset: "IDR",
        feeAmount: decimalToString(quote.feeAmount),
        receiveAmount: decimalToString(quote.receiveAmount),
        quoteId: null,
        quoteExpiresAt: null,
        status: "PENDING",
        failureReason: null,
        fromType,
        toType,
        fromWalletAddress: fromWalletAddress || null,
        toWalletAddress: toWalletAddress || null,
        fromPoolAddress: fromPoolAddress || null,
        toPoolAddress: toPoolAddress || null,
        depositTxHash: null,
        withdrawalTxHash: null,
        refundTxHash: null,
        fromBlockNumber: null,
        toBlockNumber: null,
        processedAt: null,
        completedAt: null,
        failedAt: null,
        refundedAt: null,
      },
      { transaction },
    );
    await SwapEvent.create(
      {
        swapId: swap.id,
        coreId,
        eventType: "SWAP_CREATED",
        status: "PENDING",
        txHash: null,
        blockNumber: null,
        metadata: {
          fromAsset: normalizedFromAsset,
          toAsset: normalizedToAsset,
          fromAmount: decimalToString(amount),
          receiveAmount: decimalToString(quote.receiveAmount),
          fromPriceIdr: decimalToString(fromPriceIdr),
          toPriceIdr: decimalToString(toPriceIdr),
          grossValueIdr: decimalToString(quote.grossValueIdr),
          feeRate: SWAP_FEE_RATE.toFixed(6),
          feeAmountIdr: decimalToString(quote.feeAmountIdr),
          fromType,
          toType,
          fromPoolAddress,
          toPoolAddress,
        },
      },
      { transaction },
    );
    await transaction.commit();
    await queueSwap(swap.id, coreId);
    return {
      existing: false,
      swap: {
        id: swap.id,
        coreId: swap.coreId,
        fromAsset: swap.fromAsset,
        toAsset: swap.toAsset,
        fromAmount: swap.fromAmount,
        toAmount: swap.toAmount,
        fromPriceIdr: swap.fromPriceIdr,
        toPriceIdr: swap.toPriceIdr,
        grossValueIdr: swap.grossValueIdr,
        feeRate: swap.feeRate,
        feeAsset: swap.feeAsset,
        feeAmount: swap.feeAmount,
        receiveAmount: swap.receiveAmount,
        fromType: swap.fromType,
        toType: swap.toType,
        fromWalletAddress: swap.fromWalletAddress,
        toWalletAddress: swap.toWalletAddress,
        fromPoolAddress: swap.fromPoolAddress,
        toPoolAddress: swap.toPoolAddress,
        status: swap.status,
        createdAt: swap.createdAt,
      },
    };
  } catch (error) {
    if (!transaction.finished) {
      await transaction.rollback();
    }
    throw error;
  }
}
async function confirmCryptoToIdr({ swapId, coreId, txHash }) {
  if (!swapId) {
    throw new Error("swapId wajib diisi");
  }
  if (!coreId) {
    throw new Error("coreId wajib ada");
  }
  if (!txHash) {
    throw new Error("txHash wajib diisi");
  }
  const normalizedTxHash = String(txHash).trim();
  const swap = await Swap.findOne({ where: { id: swapId, coreId } });
  if (!swap) {
    throw new Error("Swap tidak ditemukan");
  }
  if (swap.fromAsset === "IDR" || swap.toAsset !== "IDR") {
    throw new Error("Swap bukan Crypto -> IDR");
  }
  const status = String(swap.status).toUpperCase();
  if (["COMPLETED", "REFUNDED"].includes(status)) {
    return swap;
  }
  if (
    swap.depositTxHash &&
    swap.depositTxHash.toLowerCase() === normalizedTxHash.toLowerCase()
  ) {
    await queueSwap(swap.id, coreId);
    return swap;
  }
  const duplicate = await Swap.findOne({
    where: { depositTxHash: normalizedTxHash },
  });
  if (duplicate && duplicate.id !== swap.id) {
    throw new Error("Transaction hash sudah digunakan");
  }
  await swap.update({
    depositTxHash: normalizedTxHash,
    status: "PROCESSING",
    failureReason: null,
  });
  await SwapEvent.create({
    swapId: swap.id,
    coreId,
    eventType: "DEPOSIT_SUBMITTED",
    status: "PROCESSING",
    txHash: normalizedTxHash,
    blockNumber: null,
    metadata: {
      fromAsset: swap.fromAsset,
      toAsset: swap.toAsset,
      amount: swap.fromAmount,
      poolAddress: swap.fromPoolAddress,
    },
  });
  await queueSwap(swap.id, coreId);
  return swap;
}
async function getSwapStatusService({ coreId, swapId }) {
  if (!coreId) {
    throw new Error("coreId wajib ada");
  }
  if (!swapId) {
    throw new Error("swapId wajib ada");
  }
  const swap = await Swap.findOne({
    where: { id: swapId, coreId },
    include: [{ model: SwapEvent, as: "events", required: false }],
    order: [[{ model: SwapEvent, as: "events" }, "created_at", "ASC"]],
  });
  if (!swap) {
    throw new Error("Swap tidak ditemukan");
  }
  return swap;
}
async function getUserSwapsService({ coreId, limit = 50, offset = 0 }) {
  if (!coreId) {
    throw new Error("coreId wajib ada");
  }
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
  const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);
  const result = await Swap.findAndCountAll({
    where: { coreId },
    order: [["created_at", "DESC"]],
    limit: safeLimit,
    offset: safeOffset,
  });
  return {
    rows: result.rows,
    count: result.count,
    limit: safeLimit,
    offset: safeOffset,
  };
}
module.exports = {
  createSwapService,
  confirmCryptoToIdr,
  getSwapStatusService,
  getUserSwapsService,
  getAssetPrice,
  getTokenBalance,
  calculateSwapQuote,
  ASSETS,
  SWAP_FEE_RATE,
  createReference,
};
