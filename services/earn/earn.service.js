const { EarnPosition, Wallet } = require("../../models");

const {
  getAssetTokenAddress,
  getEarnPoolAddress,
  getTokenDecimals,
  readAprBps,
} = require("./earn.blockchain.service");

const {
  parseTokenAmount,
  parseTermCode,
  normalizeAsset,
} = require("./earn.validation");

const { EARN_STATUS } = require("./earn.constants");

const createPendingEarn = async ({
  coreId,
  asset,
  amount,
  termCode,
  idempotencyKey,
}) => {
  console.log("[Earn Service] START");

  console.log("[Earn Service] Input:", {
    coreId,
    asset,
    amount,
    termCode,
    idempotencyKey,
  });

  /**
   * 1. VALIDATE ASSET
   */
  console.log("[Earn Service] normalizeAsset...");

  const normalizedAsset = normalizeAsset(asset);

  console.log("[Earn Service] normalizedAsset:", normalizedAsset);

  if (!normalizedAsset) {
    throw new Error("Asset tidak valid.");
  }

  /**
   * 2. TOKEN ADDRESS
   */
  console.log("[Earn Service] getAssetTokenAddress...");

  const tokenAddress = getAssetTokenAddress(normalizedAsset);

  console.log("[Earn Service] tokenAddress:", tokenAddress);

  if (!tokenAddress) {
    throw new Error(`Token ${normalizedAsset} belum dikonfigurasi.`);
  }

  /**
   * 3. DECIMALS
   */
  console.log("[Earn Service] getTokenDecimals...");

  const tokenDecimals = await getTokenDecimals(tokenAddress);

  console.log("[Earn Service] tokenDecimals:", tokenDecimals);

  /**
   * 4. PARSE AMOUNT
   */
  console.log("[Earn Service] parseTokenAmount...");

  const amountBigInt = parseTokenAmount(amount, tokenDecimals);

  console.log("[Earn Service] amountBigInt:", amountBigInt.toString());

  if (amountBigInt <= 0n) {
    throw new Error("amount harus lebih besar dari 0.");
  }

  /**
   * 5. TERM
   */
  console.log("[Earn Service] parseTermCode...");

  const parsedTermCode = parseTermCode(termCode);

  console.log("[Earn Service] parsedTermCode:", parsedTermCode);

  /**
   * 5b. TERM HARUS DIDUKUNG POOL (aprConfigs[term] > 0 on-chain).
   * Kalau tidak, createEarn pasti revert UnsupportedTerm dan
   * posisi cuma jadi FAILED sia-sia — reject di sini.
   */
  const poolAddress = getEarnPoolAddress(normalizedAsset);
  const aprBps = await readAprBps(poolAddress, parsedTermCode);

  if (!aprBps) {
    throw new Error(
      `Term ${parsedTermCode} hari tidak tersedia untuk ${normalizedAsset}.`,
    );
  }

  console.log("[Earn Service] aprBps on-chain:", aprBps);

  /**
   * 6. WALLET
   */
  console.log("[Earn Service] mencari wallet...");

  const wallet = await Wallet.findOne({
    where: {
      core_id: coreId,
    },
  });

  console.log("[Earn Service] wallet:", {
    found: !!wallet,
    address: wallet?.address,
  });

  if (!wallet?.address) {
    throw new Error("Smart Wallet user tidak ditemukan.");
  }

  /**
   * 7. IDEMPOTENCY
   */
  console.log("[Earn Service] checking idempotency...");

  const existingPosition = await EarnPosition.findOne({
    where: {
      idempotencyKey,
    },
  });

  if (existingPosition) {
    console.log("[Earn Service] Existing position:", existingPosition.id);

    return {
      isExisting: true,
      position: existingPosition,
    };
  }

  /**
   * 8. CREATE DATABASE
   */
  console.log("[Earn Service] creating DB position...");

  const position = await EarnPosition.create({
    coreId,
    asset: normalizedAsset,

    principal: amountBigInt.toString(),

    termCode: parsedTermCode,

    status: EARN_STATUS.PENDING,

    txHash: null,

    idempotencyKey,
  });

  console.log("[Earn Service] DB position created:", {
    id: position.id,
    positionId: position.positionId,
    status: position.status,
  });

  /**
   * 9. RETURN
   */
  console.log("[Earn Service] SUCCESS");

  return {
    isExisting: false,
    position,
    tokenAddress,
    amountBigInt,
    termCode: parsedTermCode,
    wallet,
  };
};

module.exports = {
  createPendingEarn,
};
