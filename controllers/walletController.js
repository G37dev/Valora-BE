const { KycProfile, Wallet, InternalWallet } = require("../models");
const {
  createThirdwebClient,
  getContract,
  sendTransaction,
} = require("thirdweb");
const { privateKeyAccount, smartWallet } = require("thirdweb/wallets");
const { sepolia } = require("../utils/chain");
const { transfer } = require("thirdweb/extensions/erc20");
const { getRpcClient, eth_blockNumber } = require("thirdweb/rpc");

const client = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY || "",
});

const adminAccount = privateKeyAccount({
  client,
  privateKey: process.env.VALORA_ADMIN_PRIVATE_KEY,
});

const TOKEN_ADDRESSES = {
  USDT: process.env.USDT_DUMMY_CONTRACT_ADDRESS,
  USDC: process.env.USDC_DUMMY_CONTRACT_ADDRESS,
  XAUT: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
  GOLD: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
};

exports.checkWalletStatus = async (req, res) => {
  try {
    const { coreId } = req.params;

    const wallet = await Wallet.findOne({ where: { core_id: coreId } });

    if (!wallet || !wallet.address) {
      return res.status(200).json({
        success: true,
        isWalletActive: false,
        message: "Wallet belum diaktifkan.",
      });
    }

    return res.status(200).json({
      success: true,
      isWalletActive: true,
      message: "Wallet sudah aktif.",
      data: {
        address: wallet.address,
        chain: wallet.chain,
      },
    });
  } catch (error) {
    console.error("Gagal mengecek status wallet:", error);
    return res.status(500).json({
      success: false,
      message: "Kesalahan server saat mengecek status wallet.",
      error: error.message,
    });
  }
};

exports.activateWallet = async (req, res) => {
  try {
    const { coreId } = req.params;

    // 1. Validasi Status KYC
    const kyc = await KycProfile.findOne({ where: { core_id: coreId } });
    if (!kyc || kyc.status !== "VERIFIED") {
      return res.status(403).json({
        success: false,
        message:
          "Harap selesaikan KYC (VERIFIED) terlebih dahulu untuk mengaktifkan wallet.",
      });
    }

    // 2. Cek apakah coreId ini sudah punya wallet terdaftar di database
    let wallet = await Wallet.findOne({ where: { core_id: coreId } });
    if (wallet) {
      return res.status(200).json({
        success: true,
        message: "Wallet pengguna sudah aktif.",
        data: {
          id: wallet.id,
          core_id: wallet.core_id,
          address: wallet.address,
          status: wallet.status,
        },
      });
    }

    // 3. Konfigurasi Smart Wallet AA via Thirdweb (Gunakan accountSalt: coreId)
    const userSmartWalletConfig = smartWallet({
      chain: sepolia,
      factoryAddress: process.env.TW_FACTORY_ADDRESS,
      gasless: true,
      overrides: {
        accountSalt: coreId,
      },
    });

    const userSmartAccount = await userSmartWalletConfig.connect({
      client,
      personalAccount: adminAccount,
    });

    const aaAddress = userSmartAccount.address;
    console.log(`Smart Wallet AA untuk ${coreId} - Address:`, aaAddress);

    // 4. Cek apakah address ini sudah dipakai oleh core_id LAIN
    const existingWalletByAddress = await Wallet.findOne({
      where: { address: aaAddress },
    });

    if (existingWalletByAddress && existingWalletByAddress.core_id !== coreId) {
      return res.status(400).json({
        success: false,
        message: "Alamat Smart Wallet ini sudah tertaut ke akun lain.",
      });
    }

    // 5. Simpan Smart Wallet baru ke database
    wallet = await Wallet.create({
      core_id: coreId,
      type: "AA",
      address: aaAddress,
      sid: "MANAGED_AA_ADMIN",
      status: "ACTIVE",
      chain: "SEPOLIA",
    });

    // 6. Otomatis buat Internal Wallet (Saldo IDR)
    await InternalWallet.findOrCreate({
      where: { coreId: coreId },
      defaults: {
        balanceIdr: 0.0,
      },
    });
    console.log(`[INTERNAL WALLET] Berhasil dibuat untuk coreId: ${coreId}`);

    return res.status(201).json({
      success: true,
      message: "Smart Wallet AA dan Internal Wallet berhasil diaktifkan!",
      data: {
        id: wallet.id,
        core_id: wallet.core_id,
        address: wallet.address,
        status: wallet.status,
      },
    });
  } catch (error) {
    console.error("Gagal mengaktifkan Smart Wallet AA:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server saat mengaktifkan Smart Wallet.",
      error: error.message,
    });
  }
};
