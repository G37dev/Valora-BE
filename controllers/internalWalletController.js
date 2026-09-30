const { InternalWallet } = require("../models");

/**
 * @desc    Mendapatkan saldo IDR internal berdasarkan coreId
 * @route   GET /api/internal-wallet/:coreId
 */
const getInternalBalance = async (req, res) => {
  try {
    const { coreId } = req.params;

    let wallet = await InternalWallet.findOne({ where: { coreId: coreId } });

    // Jika user belum punya internal wallet, buatkan otomatis dengan saldo 0
    if (!wallet) {
      wallet = await InternalWallet.create({
        coreId: coreId,
        balanceIdr: 0.0,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Berhasil memuat saldo internal IDR",
      data: {
        core_id: wallet.coreId,
        balance_idr: wallet.balanceIdr,
      },
    });
  } catch (error) {
    console.error("Gagal mengambil saldo internal:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server",
      error: error.message,
    });
  }
};

module.exports = {
  getInternalBalance,
};
