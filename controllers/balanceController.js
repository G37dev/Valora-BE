const { Wallet, InternalWallet } = require("../models");
const { createThirdwebClient, getContract } = require("thirdweb");
const { sepolia } = require("thirdweb/chains");
const { getWalletBalance } = require("thirdweb/wallets");
const { getBalance: getErc20Balance } = require("thirdweb/extensions/erc20");

const client = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY || "",
});

exports.getAllBalances = async (req, res) => {
  try {
    const { coreId } = req.params;

    // ==========================================
    // 1. Ambil wallet on-chain
    // ==========================================
    const wallet = await Wallet.findOne({
      where: {
        core_id: coreId,
      },
    });

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet belum diaktifkan.",
      });
    }

    // ==========================================
    // 2. Ambil saldo IDR internal
    // ==========================================
    const internalWallet = await InternalWallet.findOne({
      where: {
        coreId: coreId,
      },
    });

    // Kalau InternalWallet belum ada, saldo dianggap 0
    const idrBalance = internalWallet
      ? String(internalWallet.balanceIdr || "0.00")
      : "0.00";

    // ==========================================
    // 3. Ambil saldo Native (Sepolia ETH)
    // ==========================================
    let ethBalance = "0";

    try {
      const nativeRes = await getWalletBalance({
        client,
        chain: sepolia,
        address: wallet.address,
      });

      ethBalance = nativeRes.displayValue;
    } catch (err) {
      console.warn("Gagal fetch ETH balance:", err.message);
    }

    // ==========================================
    // 4. Helper ERC20 balance
    // ==========================================
    const fetchTokenBalance = async (contractAddress) => {
      if (!contractAddress) return "0";

      try {
        const tokenContract = getContract({
          client,
          chain: sepolia,
          address: contractAddress,
        });

        const balanceResult = await getErc20Balance({
          contract: tokenContract,
          address: wallet.address,
        });

        return balanceResult.displayValue || "0";
      } catch (err) {
        console.warn(
          `Gagal fetch balance untuk ${contractAddress}:`,
          err.message,
        );

        return "0";
      }
    };

    // ==========================================
    // 5. Ambil balance semua token secara parallel
    // ==========================================
    const [usdtBalance, usdcBalance, xautBalance, goldBalance] =
      await Promise.all([
        fetchTokenBalance(process.env.USDT_DUMMY_CONTRACT_ADDRESS),
        fetchTokenBalance(process.env.USDC_DUMMY_CONTRACT_ADDRESS),
        fetchTokenBalance(process.env.XAUT_DUMMY_CONTRACT_ADDRESS),
        fetchTokenBalance(process.env.GOLD_DUMMY_CONTRACT_ADDRESS),
      ]);

    // ==========================================
    // 6. Susun response
    // ==========================================
    const assets = {
      internal: {
        idr: {
          balance: idrBalance,
          idrValue: Number(idrBalance),
        },
      },

      onChain: {
        eth: {
          balance: ethBalance,
          symbol: "ETH",
        },

        usdt: {
          balance: usdtBalance,
          symbol: "USDT",
        },

        usdc: {
          balance: usdcBalance,
          symbol: "USDC",
        },

        xaut: {
          balance: xautBalance,
          symbol: "XAUT",
        },

        gold: {
          balance: goldBalance,
          symbol: "GOLD",
        },
      },

      walletInfo: {
        address: wallet.address,
        chain: wallet.chain,
        status: wallet.status,
      },
    };

    return res.status(200).json({
      success: true,
      data: assets,
    });
  } catch (error) {
    console.error("Gagal mengambil semua balance:", error);

    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server saat mengambil balance.",
      error: error.message,
    });
  }
};
