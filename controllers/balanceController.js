const { Wallet, InternalWallet } = require("../models");
const { createThirdwebClient, getContract } = require("thirdweb");
const { sepolia } = require("../utils/chain");
const { getWalletBalance } = require("thirdweb/wallets");
const {
  balanceOf,
  decimals: readDecimals,
} = require("thirdweb/extensions/erc20");
const { toTokens } = require("thirdweb/utils");
const { withRpcRetry } = require("../utils/rpcRetry");

const client = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY || "",
});

// decimals() token itu statis — cache per kontrak supaya metadata
// (name/symbol/decimals) nggak ikut di-fetch ulang tiap request balance.
// getErc20Balance sebelumnya melakukan itu dan sering crash dengan
// "Invalid currency token: fetch failed" saat RPC flake. Fallback 6:
// semua dummy token kita 6 desimal.
const decimalsCache = new Map();
const getTokenDecimalsCached = async (tokenContract) => {
  const addr = tokenContract.address;
  const cached = decimalsCache.get(addr);
  if (cached != null) return cached;
  let dec = 6;
  try {
    dec = await withRpcRetry(() => readDecimals({ contract: tokenContract }), {
      label: "decimals",
      retries: 1,
    });
  } catch {}
  decimalsCache.set(addr, dec);
  return dec;
};

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
    const degraded = [];

    try {
      const nativeRes = await withRpcRetry(
        () =>
          getWalletBalance({
            client,
            chain: sepolia,
            address: wallet.address,
          }),
        { label: "balance-eth" },
      );

      ethBalance = nativeRes.displayValue;
    } catch (err) {
      degraded.push("eth");
      console.warn("Gagal fetch ETH balance:", err.message);
    }

    // ==========================================
    // 4. Helper ERC20 balance
    // ==========================================
    const fetchTokenBalance = async (contractAddress, symbol) => {
      if (!contractAddress) return "0";

      try {
        const tokenContract = getContract({
          client,
          chain: sepolia,
          address: contractAddress,
        });

        const balanceWei = await withRpcRetry(
          () =>
            balanceOf({
              contract: tokenContract,
              address: wallet.address,
            }),
          { label: `balance-${symbol}` },
        );

        const dec = await getTokenDecimalsCached(tokenContract);
        return toTokens(balanceWei, dec) || "0";
      } catch (err) {
        degraded.push(symbol);
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
        fetchTokenBalance(process.env.USDT_DUMMY_CONTRACT_ADDRESS, "usdt"),
        fetchTokenBalance(process.env.USDC_DUMMY_CONTRACT_ADDRESS, "usdc"),
        fetchTokenBalance(process.env.XAUT_DUMMY_CONTRACT_ADDRESS, "xaut"),
        fetchTokenBalance(process.env.GOLD_DUMMY_CONTRACT_ADDRESS, "gold"),
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

      /*
       * Asset yang gagal di-fetch setelah retry — FE bisa bedain
       * "balance 0 beneran" vs "RPC lagi down" (balance tetap "0"
       * untuk kompatibilitas, tapi flag ini memberi sinyal jujur).
       */
      degraded,
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
