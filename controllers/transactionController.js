require("dotenv").config();
const { Wallet, Transaction } = require("../models");
const {
  createThirdwebClient,
  getContract,
  sendTransaction,
} = require("thirdweb");
const { getRpcClient, eth_blockNumber } = require("thirdweb/rpc");
const { sepolia } = require("../utils/chain");
const { transfer } = require("thirdweb/extensions/erc20");
const { privateKeyAccount, smartWallet } = require("thirdweb/wallets");

const client = createThirdwebClient({
  secretKey: process.env.THIRDWEB_SECRET_KEY || "",
});

// Akun Admin server sebagai personalAccount / signer utama yang mengontrol Smart Wallet user
const adminAccount = privateKeyAccount({
  client,
  privateKey: process.env.VALORA_ADMIN_PRIVATE_KEY,
});

// Mapping alamat kontrak token dummy
const TOKEN_ADDRESSES = {
  USDT: process.env.USDT_DUMMY_CONTRACT_ADDRESS,
  USDC: process.env.USDC_DUMMY_CONTRACT_ADDRESS,
  XAUT: process.env.XAUT_DUMMY_CONTRACT_ADDRESS,
  GOLD: process.env.GOLD_DUMMY_CONTRACT_ADDRES,
};

// @desc    Ambil riwayat transaksi & hitung progress konfirmasi blok
// @route   GET /api/transactions/:coreId
exports.getUserTransactions = async (req, res) => {
  try {
    const { coreId } = req.params;
    const REQUIRED_CONFIRMATIONS = 12;

    const transactions = await Transaction.findAll({
      where: { core_id: coreId },
      order: [["createdAt", "DESC"]],
    });

    if (!transactions.length) {
      return res.status(200).json({ success: true, data: [] });
    }

    let currentBlock = 0;
    try {
      const rpcRequest = getRpcClient({ client, chain: sepolia });
      const blockNumBigInt = await eth_blockNumber(rpcRequest);
      currentBlock = Number(blockNumBigInt);
    } catch (err) {
      console.error("Gagal mengambil blok terbaru dari RPC:", err.message);
    }

    const formattedData = await Promise.all(
      transactions.map(async (tx) => {
        let finalStatus = tx.status;
        let confirmations = 0;

        if (tx.tx_block_number && currentBlock > 0) {
          confirmations = currentBlock - Number(tx.tx_block_number);
          if (confirmations < 0) confirmations = 0;

          if (
            finalStatus === "PENDING" &&
            confirmations >= REQUIRED_CONFIRMATIONS
          ) {
            finalStatus = "SUCCESS";
            await tx.update({ status: "SUCCESS" });
          }
        }

        if (finalStatus === "SUCCESS") {
          confirmations = REQUIRED_CONFIRMATIONS;
        }

        return {
          tx_hash: tx.tx_hash,
          type: tx.type,
          asset: tx.asset,
          amount: tx.amount,
          status: finalStatus,
          confirmations: confirmations,
          requiredConfirmations: REQUIRED_CONFIRMATIONS,
          createdAt: tx.createdAt,
        };
      }),
    );

    return res.status(200).json({
      success: true,
      data: formattedData,
    });
  } catch (error) {
    console.error("Gagal mengambil transaksi:", error);
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan server saat mengambil histori transaksi.",
      error: error.message,
    });
  }
};

// @desc    Proses Withdraw Gasless Account Abstraction (Background / Sekali Jalan)
// @route   POST /api/wallet/withdraw
exports.requestWithdraw = async (req, res) => {
  try {
    console.log("----------------------------------------");
    console.log("📥 [STEP 0] Menerima request withdraw masuk:", req.body);

    const { coreId, asset, amount, destinationAddress } = req.body;

    if (!coreId || !asset || !amount || !destinationAddress) {
      console.log("❌ [STEP 0 ERROR] Data request tidak lengkap.");
      return res
        .status(400)
        .json({ success: false, message: "Data tidak lengkap." });
    }

    const tokenAddress = TOKEN_ADDRESSES[asset.toUpperCase()];
    if (!tokenAddress) {
      console.log(`❌ [STEP 0 ERROR] Aset ${asset} tidak didukung.`);
      return res
        .status(400)
        .json({ success: false, message: `Aset ${asset} tidak didukung.` });
    }

    console.log(`✅ [STEP 1] Token Address untuk ${asset}: ${tokenAddress}`);

    // 1. Ambil data wallet user dari database (berisi alamat Smart Wallet AA)
    const userWallet = await Wallet.findOne({ where: { core_id: coreId } });
    if (!userWallet || !userWallet.address) {
      console.log(
        `❌ [STEP 1 ERROR] Wallet untuk coreId ${coreId} tidak ditemukan.`,
      );
      return res.status(404).json({
        success: false,
        message: "Smart Wallet user tidak ditemukan atau belum aktif.",
      });
    }

    console.log(
      `✅ [STEP 2] Smart Wallet user ditemukan: ${userWallet.address}`,
    );

    // 2. Buat catatan awal di database dengan status PENDING
    const pendingTx = await Transaction.create({
      core_id: coreId,
      tx_hash: "PENDING_" + Date.now(),
      type: "WITHDRAW",
      asset: asset.toUpperCase(),
      amount: amount,
      status: "PENDING",
    });

    console.log(
      `✅ [STEP 3] Catatan transaksi PENDING dibuat di DB dengan ID/Hash sementara: ${pendingTx.tx_hash}`,
    );

    // 3. Kirim respons sukses ke Frontend SEKARANG JUGA (Instant Response)
    res.status(200).json({
      success: true,
      message: "Withdraw sedang diproses di latar belakang.",
      data: {
        txHash: pendingTx.tx_hash,
        asset: asset.toUpperCase(),
        amount,
        destinationAddress,
      },
    });

    // 4. EKSEKUSI BLOCKCHAIN DI LATAR BELAKANG (Background Async Process)
    (async () => {
      try {
        console.log("----------------------------------------");
        console.log(
          `🚀 [BACKGROUND START] Memproses ${amount} ${asset} dari Smart Wallet ${userWallet.address} ke ${destinationAddress}`,
        );

        // Ambil objek kontrak token ERC-20
        const contract = getContract({
          client,
          chain: sepolia,
          address: tokenAddress,
        });
        console.log(
          "✅ [BACKGROUND STEP A] Kontrak token berhasil diinisialisasi.",
        );

        // Siapkan parameter transfer token
        const tx = transfer({
          contract,
          to: destinationAddress,
          amount: amount.toString(),
        });
        console.log(
          "✅ [BACKGROUND STEP B] Payload transfer ERC-20 berhasil disiapkan.",
        );

        // Konfigurasi Smart Wallet (AA) dengan Paymaster (gasless: true)
        const userSmartWalletConfig = smartWallet({
          chain: sepolia,
          factoryAddress: process.env.TW_FACTORY_ADDRESS,
          gasless: true,
          overrides: {
            accountSalt: coreId, // <-- Tambahkan ini agar salt-nya sinkron dengan saat activateWallet
          },
        });
        console.log(
          `✅ [BACKGROUND STEP C] Konfigurasi smartWallet siap menggunakan Factory: ${process.env.TW_FACTORY_ADDRESS}`,
        );

        // Hubungkan ke Smart Wallet milik user menggunakan adminAccount sebagai signer
        const userSmartAccount = await userSmartWalletConfig.connect({
          client,
          personalAccount: adminAccount,
          accountAddress: userWallet.address,
        });
        console.log(
          `✅ [BACKGROUND STEP D] Berhasil connect ke userSmartAccount dengan Alamat: ${userSmartAccount.address}`,
        );
        console.log(
          `ℹ️ [INFO SIGNER] Personal Account (Signer) yang terpasang: ${adminAccount.address}`,
        );

        // Eksekusi pengiriman transaksi sekali jalan menggunakan Smart Account
        console.log(
          "⏳ [BACKGROUND STEP E] Mengirim transaksi ke jaringan blockchain via sendTransaction...",
        );
        const txResult = await sendTransaction({
          transaction: tx,
          account: userSmartAccount,
        });

        const realTxHash = txResult.transactionHash;
        console.log(
          `🎉 [BACKGROUND SUCCESS] Transaksi Berhasil! Real Hash: ${realTxHash}`,
        );

        const rpcRequest = getRpcClient({ client, chain: sepolia });
        const blockNumBigInt = await eth_blockNumber(rpcRequest);
        const currentBlockNumber = Number(blockNumBigInt);
        console.log(
          `✅ [BACKGROUND STEP F] Block Number saat ini: ${currentBlockNumber}`,
        );

        // Update database dengan Hash asli dari blockchain
        await pendingTx.update({
          tx_hash: realTxHash,
          tx_block_number: currentBlockNumber,
          status: "PENDING",
        });
        console.log(
          "✅ [BACKGROUND FINISH] Database berhasil diperbarui dengan real hash.",
        );
        console.log("----------------------------------------");
      } catch (bgError) {
        console.error(
          "❌ [BACKGROUND ERROR] Gagal mengeksekusi withdraw AA di latar belakang:",
          bgError,
        );
        console.error("Detail Error Stack:", bgError.stack || bgError);
        await pendingTx.update({ status: "FAILED" });
      }
    })();
  } catch (error) {
    console.error(
      "❌ [SERVER ERROR] Gagal memproses request withdraw utama:",
      error,
    );
    return res.status(500).json({
      success: false,
      message: "Terjadi kesalahan pada server saat memproses withdraw.",
      error: error.message,
    });
  }
};
