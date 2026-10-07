const {
  createSwapService,
  getSwapStatusService,
  getUserSwapsService,
  getTokenBalance,
} = require("../services/swap/swap.service");

const { Wallet } = require("../models");

async function createSwap(req, res) {
  try {
    const coreId = req.user?.coreId;

    if (!coreId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const {
      fromAsset,
      toAsset,
      fromAmount,
      idempotencyKey,
      fromWalletAddress,
      toWalletAddress,
    } = req.body;

    if (
      !fromAsset ||
      !toAsset ||
      fromAmount === undefined ||
      fromAmount === null ||
      !idempotencyKey
    ) {
      return res.status(400).json({
        success: false,
        message:
          "fromAsset, toAsset, fromAmount, dan idempotencyKey wajib diisi",
      });
    }

    const result = await createSwapService({
      coreId,
      fromAsset,
      toAsset,
      fromAmount,
      idempotencyKey,
      fromWalletAddress: fromWalletAddress || null,
      toWalletAddress: toWalletAddress || null,
    });

    return res.status(result.existing ? 200 : 202).json({
      success: true,
      message: result.existing
        ? "Swap sudah pernah dibuat"
        : "Swap berhasil dibuat dan sedang diproses",
      data: result.swap,
    });
  } catch (error) {
    console.error("createSwap error:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Gagal membuat swap",
    });
  }
}

async function getSwapStatus(req, res) {
  try {
    const coreId = req.user?.coreId;
    const { swapId } = req.params;

    if (!coreId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!swapId) {
      return res.status(400).json({
        success: false,
        message: "swapId wajib diisi",
      });
    }

    const swap = await getSwapStatusService({
      coreId,
      swapId,
    });

    return res.status(200).json({
      success: true,
      data: swap,
    });
  } catch (error) {
    console.error("getSwapStatus error:", error);

    const statusCode = error.message === "Swap tidak ditemukan" ? 404 : 400;

    return res.status(statusCode).json({
      success: false,
      message: error.message || "Gagal mengambil status swap",
    });
  }
}

async function getUserSwaps(req, res) {
  try {
    const coreId = req.user?.coreId;

    if (!coreId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const { limit, offset } = req.query;

    const result = await getUserSwapsService({
      coreId,
      limit,
      offset,
    });

    return res.status(200).json({
      success: true,
      data: result.rows,
      pagination: {
        total: result.count,
        limit: result.limit,
        offset: result.offset,
      },
    });
  } catch (error) {
    console.error("getUserSwaps error:", error);

    return res.status(400).json({
      success: false,
      message: error.message || "Gagal mengambil riwayat swap",
    });
  }
}

async function getTokenBalanceController(req, res) {
  try {
    const coreId = req.user?.coreId;
    const { asset } = req.params;

    if (!coreId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    if (!asset) {
      return res.status(400).json({
        success: false,
        message: "asset wajib diisi",
      });
    }

    const normalizedAsset = String(asset).trim().toUpperCase();

    let walletAddress = null;

    if (normalizedAsset !== "IDR") {
      const wallet = await Wallet.findOne({
        where: {
          coreId,
        },
      });

      if (!wallet) {
        return res.status(404).json({
          success: false,
          message: "Wallet tidak ditemukan",
        });
      }

      walletAddress = wallet.address || wallet.walletAddress;

      if (!walletAddress) {
        return res.status(400).json({
          success: false,
          message: "Wallet address tidak ditemukan",
        });
      }
    }

    const balance = await getTokenBalance({
      coreId,
      asset: normalizedAsset,
      walletAddress,
    });

    return res.status(200).json({
      success: true,
      data: balance,
    });
  } catch (error) {
    console.error("getTokenBalance error:", error);

    const message = error.message || "Gagal mengambil token balance";

    let statusCode = 400;

    if (
      message.toLowerCase().includes("tidak ditemukan") ||
      message.toLowerCase().includes("not found")
    ) {
      statusCode = 404;
    }

    return res.status(statusCode).json({
      success: false,
      message,
    });
  }
}

module.exports = {
  createSwap,
  getSwapStatus,
  getUserSwaps,
  getTokenBalance: getTokenBalanceController,
};
