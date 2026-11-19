require("dotenv").config();
const {
  Wallet,
  Transaction,
  Swap,
  InternalTransaction,
  TopUp,
  InstallmentPayment,
  InstallmentPlan,
  LoanRepayment,
  LoanDrawdown,
  LoanPosition,
  EarnPosition,
} = require("../models");
const {
  createThirdwebClient,
  getContract,
  sendBatchTransaction,
} = require("thirdweb");
const { getRpcClient } = require("thirdweb/rpc");
const { cachedBlockNumber } = require("../services/rpcCache");
const { sepolia } = require("../utils/chain");
const { transfer, decimals } = require("thirdweb/extensions/erc20");
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
  GOLD: process.env.GOLD_DUMMY_CONTRACT_ADDRESS,
};

// Fee withdraw per aset (unit token) — mirror tabel mobile; dipotong dari
// gross amount lalu ditransfer ke Fee Treasury Safe.
const WITHDRAWAL_FEES = {
  USDT: "1",
  USDC: "1",
  XAUT: "0.0003",
  GOLD: "1",
};
const DEFAULT_WITHDRAWAL_FEE = "1";
const FEE_TREASURY = process.env.FEE_TREASURY_SAFE_ADDRESS;

// Konversi string desimal -> raw unit BigInt (10^decimals) untuk hitungan
// fee/net yang presisi tanpa float.
function decimalToRaw(str, decimals) {
  const [intPart, fracPart = ""] = String(str).split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  return BigInt((intPart || "0") + frac);
}

function rawToDecimal(raw, decimals) {
  const s = raw.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, -decimals) || "0";
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : intPart;
}

// Cache decimals() per kontrak — nilai immutable on-chain.
const tokenDecimalsCache = new Map();
async function getTokenDecimals(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (!tokenDecimalsCache.has(key)) {
    const contract = getContract({
      client,
      chain: sepolia,
      address: tokenAddress,
    });
    const d = await decimals({ contract });
    tokenDecimalsCache.set(key, Number(d));
  }
  return tokenDecimalsCache.get(key);
}

// Validasi amount string: digits+dot saja, desimal <= precision token.
function validateAmountPrecision(amount, tokenDecimals) {
  const str = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) {
    return "Format jumlah tidak valid.";
  }
  const fraction = str.split(".")[1] || "";
  if (fraction.length > tokenDecimals) {
    return `Jumlah melebihi presisi token (maks. ${tokenDecimals} angka desimal).`;
  }
  if (BigInt(str.replace(".", "")) === 0n) {
    return "Jumlah harus lebih besar dari 0.";
  }
  return null;
}

// Throttle scan deposit on-demand per coreId — endpoint ini di-poll
// tiap ~4 detik oleh app; scan maksimal sekali per 45 detik per user
// per instance supaya tidak membebani RPC.
const depositScanLastAt = new Map();
const DEPOSIT_SCAN_INTERVAL_MS = 45_000;

// @desc    Ambil riwayat transaksi & hitung progress konfirmasi blok
// @route   GET /api/transactions/:coreId
exports.getUserTransactions = async (req, res) => {
  try {
    const { coreId } = req.params;
    const REQUIRED_CONFIRMATIONS = 12;

    /*
     * Opportunistic deposit scan — cron tick (±1 mnt) adalah fallback;
     * scan di sini bikin deposit terdeteksi dalam sekali poll saat user
     * aktif membuka aplikasi. Dijalankan sebelum fetch list supaya row
     * baru langsung ikut response ini.
     */
    try {
      const lastScan = depositScanLastAt.get(coreId) || 0;
      if (Date.now() - lastScan > DEPOSIT_SCAN_INTERVAL_MS) {
        depositScanLastAt.set(coreId, Date.now());
        const userWallet = await Wallet.findOne({
          where: { core_id: coreId },
          attributes: ["address"],
        });
        if (userWallet?.address) {
          const {
            scanWalletRecentTransfers,
          } = require("../services/blockchainListener");
          await scanWalletRecentTransfers(userWallet.address);
        }
      }
    } catch (scanErr) {
      console.error("[DepositScan] skip:", scanErr?.message || scanErr);
    }

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
      currentBlock = await cachedBlockNumber(rpcRequest);
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
          id: `tx-${tx.id}`,
          tx_hash: tx.tx_hash,
          type: tx.type,
          asset: tx.asset,
          amount: tx.amount,
          status: finalStatus,
          confirmations: confirmations,
          requiredConfirmations: REQUIRED_CONFIRMATIONS,
          createdAt: tx.createdAt,
          destination: tx.destination_address || null,
          from: tx.from_address || null,
        };
      }),
    );

    /*
     * Global history: gabungkan transaksi on-chain (tabel
     * Transactions) dengan Swap dan ledger InternalTransaction
     * (top-up IDR, pembayaran installment, refund, dsb).
     * Entry ledger yang terkait swap_id di-skip karena sudah
     * terwakili oleh row Swap itu sendiri.
     */
    const [swaps, internalTxs] = await Promise.all([
      Swap.findAll({
        where: { coreId },
        order: [["created_at", "DESC"]],
      }),
      InternalTransaction.findAll({
        where: { coreId, swapId: null },
        order: [["created_at", "DESC"]],
      }),
    ]);

    const swapRows = swaps.map((s) => ({
      id: `swap-${s.id}`,
      type: "SWAP",
      asset: s.fromAsset,
      amount: s.fromAmount,
      toAsset: s.toAsset,
      toAmount: s.toAmount,
      direction: "DEBIT",
      status: s.status === "PROCESSING" ? "PENDING" : s.status,
      confirmations: 0,
      requiredConfirmations: 0,
      description: `Swap ${s.fromAsset} → ${s.toAsset}`,
      createdAt: s.created_at || s.createdAt,
    }));

    // Earn rows sudah masuk lewat Transaction (type EARN_DEPOSIT/
    // EARN_CLAIM dari earnListener) — nggak perlu merge terpisah.
    // Subtitle "VVLR Earn • {term}D" di-resolve via tx_hash.
    const earnHashes = formattedData
      .filter((r) => String(r.type || "").startsWith("EARN"))
      .map((r) => r.tx_hash);
    const earnPositions = earnHashes.length
      ? await EarnPosition.findAll({
          where: {
            coreId,
            [require("sequelize").Op.or]: [
              { txHash: earnHashes },
              { claimTxHash: earnHashes },
            ],
          },
        })
      : [];
    const earnByHash = new Map(
      earnPositions.flatMap((p) => [
        [String(p.txHash || "").toLowerCase(), { p, claim: false }],
        [String(p.claimTxHash || "").toLowerCase(), { p, claim: true }],
      ]),
    );
    for (const row of formattedData) {
      if (!String(row.type || "").startsWith("EARN")) continue;
      const hit = earnByHash.get(String(row.tx_hash || "").toLowerCase());
      if (hit?.p) {
        row.subtitle = `VVLR Earn • ${hit.p.termCode}D`;
        row.earnPositionId = hit.p.id;
      }
    }

    const inferInternalType = (t) => {
      const ref = String(t.reference || "").toUpperCase();
      const desc = String(t.description || "").toUpperCase();
      if (t.topUpId || ref.includes("TOPUP") || ref.includes("TOP_UP"))
        return "TOPUP";
      if (ref.includes("INSTALLMENT") || desc.includes("INSTALLMENT"))
        return "INSTALLMENT";
      if (ref.includes("REFUND") || desc.includes("REFUND")) return "REFUND";
      if (ref.startsWith("LOAN-REPAY")) return "PAWN_REPAYMENT";
      if (ref.startsWith("LOAN-DISB")) return "PAWN_DISBURSEMENT";
      if (ref.startsWith("LOAN-GAS")) return "PAWN_FEE";
      if (ref.includes("LOAN") || desc.includes("LOAN")) return "PAWN";
      return "TRANSFER";
    };

    // ---- Subtitle lookups (batch, bukan N+1) -------------------------
    const itxIds = internalTxs.map((t) => t.id);
    const instPayments = itxIds.length
      ? await InstallmentPayment.findAll({
          where: { internal_transaction_id: itxIds },
          include: [{ model: InstallmentPlan, as: "plan", required: false }],
        })
      : [];
    const instByItx = new Map(
      instPayments.map((p) => [p.internal_transaction_id, p]),
    );

    const topupIds = internalTxs.map((t) => t.topUpId).filter(Boolean);
    const topups = topupIds.length
      ? await TopUp.findAll({ where: { id: topupIds } })
      : [];
    const topupById = new Map(topups.map((t) => [String(t.id), t]));

    const loanRepayKeys = internalTxs
      .map((t) =>
        String(t.reference || "").match(/^LOAN-REPAY-([0-9a-fA-F-]{36})-(.+)$/),
      )
      .filter(Boolean);
    const loanRepayments = loanRepayKeys.length
      ? await LoanRepayment.findAll({
          where: {
            positionId: loanRepayKeys.map((m) => m[1]),
            idempotencyKey: loanRepayKeys.map((m) => m[2]),
          },
        })
      : [];
    const loanRepayByKey = new Map(
      loanRepayments.map((r) => [`${r.positionId}:${r.idempotencyKey}`, r]),
    );
    const loanDisbIds = internalTxs
      .map((t) =>
        String(t.reference || "").match(/^LOAN-DISB-([0-9a-fA-F-]{36})$/),
      )
      .filter(Boolean)
      .map((m) => m[1]);
    const loanDrawdowns = loanDisbIds.length
      ? await LoanDrawdown.findAll({ where: { id: loanDisbIds } })
      : [];
    const disbById = new Map(loanDrawdowns.map((d) => [String(d.id), d]));

    // Position lookup gabungan: repayment + disbursement + gas fee.
    const gasPosIds = internalTxs
      .filter((t) => String(t.reference || "").startsWith("LOAN-GAS-"))
      .map((t) => t.metadata?.position_id)
      .filter(Boolean);
    const loanPosIds = [
      ...new Set([
        ...loanRepayments.map((r) => r.positionId),
        ...loanDrawdowns.map((d) => d.positionId),
        ...gasPosIds,
      ]),
    ];
    const loanPositions = loanPosIds.length
      ? await LoanPosition.findAll({
          where: { id: loanPosIds },
        })
      : [];
    const loanPosById = new Map(loanPositions.map((p) => [String(p.id), p]));

    const internalRows = internalTxs.map((t) => {
      const ref = String(t.reference || "");
      const instP = instByItx.get(t.id);
      const loanM = ref.match(/^LOAN-REPAY-([0-9a-fA-F-]{36})-(.+)$/);
      const repay = loanM
        ? loanRepayByKey.get(`${loanM[1]}:${loanM[2]}`)
        : null;
      const disbM = ref.match(/^LOAN-DISB-([0-9a-fA-F-]{36})$/);
      const disbPos = disbM
        ? loanPosById.get(String(disbById.get(disbM[1])?.positionId))
        : null;
      const pos =
        (repay ? loanPosById.get(String(repay.positionId)) : null) ||
        disbPos ||
        (String(t.reference || "").startsWith("LOAN-GAS-")
          ? loanPosById.get(String(t.metadata?.position_id))
          : null);
      const topup = t.topUpId ? topupById.get(String(t.topUpId)) : null;

      let subtitle = null;
      if (instP?.plan?.plan_type) {
        subtitle =
          instP.plan.plan_type === "FLEXIBLE" ? "Flexible Plan" : "Standard Plan";
      } else if (pos?.collateralAsset) {
        subtitle = `${pos.collateralAsset} Pawn`;
      } else if (topup) {
        const notif = t.metadata?.notification || {};
        const va = Array.isArray(notif.va_numbers)
          ? notif.va_numbers[0]
          : null;
        subtitle = va?.bank
          ? `From ${String(va.bank).toUpperCase()} • VA`
          : "IDR Top Up";
      } else if (ref.startsWith("LOAN-DISB")) {
        subtitle = "Pawn Disbursement";
      } else if (ref.startsWith("LOAN-GAS")) {
        subtitle = "Release network fee";
      }

      return {
        id: `itx-${t.id}`,
        type: inferInternalType(t),
        asset: t.asset,
        amount: t.amount,
        direction: t.type, // CREDIT / DEBIT
        status: t.status,
        confirmations: 0,
        requiredConfirmations: 0,
        description: t.description || null,
        subtitle,
        createdAt: t.created_at || t.createdAt,
      };
    });

    const merged = [...formattedData, ...swapRows, ...internalRows].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    );

    return res.status(200).json({
      success: true,
      data: merged,
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

    const { coreId, asset, amount, destinationAddress, idempotencyKey } =
      req.body;

    if (!coreId || !asset || !amount || !destinationAddress) {
      console.log("❌ [STEP 0 ERROR] Data request tidak lengkap.");
      return res
        .status(400)
        .json({ success: false, message: "Data tidak lengkap." });
    }

    // Ownership: token JWT harus milik coreId yang sama — cegah IDOR
    // (withdraw atas nama user lain).
    if (
      !req.user ||
      req.user.coreId !== coreId ||
      req.user.scope === "pre_auth"
    ) {
      console.log(`❌ [STEP 0 ERROR] coreId mismatch vs token.`);
      return res.status(403).json({
        success: false,
        message: "Tidak berhak melakukan withdraw untuk akun ini.",
      });
    }

    const trimmedDest = String(destinationAddress).trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(trimmedDest)) {
      return res.status(400).json({
        success: false,
        message: "Format alamat tujuan tidak valid.",
      });
    }

    const tokenAddress = TOKEN_ADDRESSES[asset.toUpperCase()];
    if (!tokenAddress) {
      console.log(`❌ [STEP 0 ERROR] Aset ${asset} tidak didukung.`);
      return res
        .status(400)
        .json({ success: false, message: `Aset ${asset} tidak didukung.` });
    }

    // Presisi: tolak amount dengan desimal melebihi decimals() token —
    // sebelumnya nilai seperti 100.0000001 lolos dan ke-truncate on-chain.
    const cleanAmount = String(amount).trim();
    const tokenDecimals = await getTokenDecimals(tokenAddress);
    const precisionError = validateAmountPrecision(cleanAmount, tokenDecimals);
    if (precisionError) {
      return res.status(400).json({ success: false, message: precisionError });
    }

    // `amount` yang dikirim client = gross (total yang didebit dari wallet
    // user). Fee dipotong dari gross; sisanya (net) ditransfer ke tujuan.
    const feeStr = WITHDRAWAL_FEES[asset.toUpperCase()] ?? DEFAULT_WITHDRAWAL_FEE;
    if (!FEE_TREASURY) {
      console.error("❌ [CONFIG] FEE_TREASURY_SAFE_ADDRESS belum di-set.");
      return res.status(500).json({
        success: false,
        message: "Konfigurasi fee belum tersedia. Coba lagi nanti.",
      });
    }
    const grossRaw = decimalToRaw(cleanAmount, tokenDecimals);
    const feeRaw = decimalToRaw(feeStr, tokenDecimals);
    const netRaw = grossRaw - feeRaw;
    if (netRaw <= 0n) {
      return res.status(400).json({
        success: false,
        message: `Jumlah harus lebih besar dari fee withdraw (${feeStr} ${asset.toUpperCase()}).`,
      });
    }
    const netAmount = rawToDecimal(netRaw, tokenDecimals);

    // Idempotency: retry dengan key yang sama mengembalikan hasil
    // yang sudah ada, tanpa broadcast ulang.
    if (idempotencyKey) {
      const existing = await Transaction.findOne({
        where: { core_id: coreId, idempotency_key: String(idempotencyKey) },
      });
      if (existing) {
        console.log(
          `♻️ [IDEMPOTENT] Request withdraw duplikat (key ${idempotencyKey}), kembalikan tx ${existing.id} status ${existing.status}.`,
        );
        return res.status(200).json({
          success: true,
          idempotentReplay: true,
          message:
            existing.status === "FAILED"
              ? "Withdraw sebelumnya gagal."
              : "Withdraw sudah diproses sebelumnya.",
          data: {
            txHash: existing.tx_hash.startsWith("PENDING_")
              ? null
              : existing.tx_hash,
            status: existing.status,
            asset: existing.asset,
            amount: existing.amount,
            fee: existing.fee,
            destinationAddress: trimmedDest,
          },
        });
      }
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

    // Self-send: tujuan == smart wallet sendiri tidak masuk akal untuk withdraw.
    if (trimmedDest.toLowerCase() === userWallet.address.toLowerCase()) {
      return res.status(400).json({
        success: false,
        message:
          "Alamat tujuan sama dengan wallet pengirim. Gunakan alamat lain.",
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
      amount: netAmount,
      fee: feeStr,
      status: "PENDING",
      idempotency_key: idempotencyKey ? String(idempotencyKey) : null,
      destination_address: trimmedDest,
    });

    console.log(
      `✅ [STEP 3] Catatan transaksi PENDING dibuat di DB dengan ID/Hash sementara: ${pendingTx.tx_hash}`,
    );

    // 3. EKSEKUSI BLOCKCHAIN SECARA SINKRON.
    // PENTING: di serverless (Vercel) async pasca-response di-freeze,
    // jadi transfer AA harus di-await sebelum respond. Flow ini ~15-30s,
    // masih di bawah batas function duration.
    try {
      console.log("----------------------------------------");
      console.log(
        `🚀 [WITHDRAW START] Memproses ${cleanAmount} ${asset} (net ${netAmount} + fee ${feeStr}) dari Smart Wallet ${userWallet.address} ke ${destinationAddress}`,
      );

      // Ambil objek kontrak token ERC-20
      const contract = getContract({
        client,
        chain: sepolia,
        address: tokenAddress,
      });
      console.log("✅ [STEP A] Kontrak token berhasil diinisialisasi.");

      // Batch 2 transfer dalam 1 UserOp: net ke tujuan + fee ke Fee
      // Treasury — atomik, satu tx hash.
      const transferTxs = [
        transfer({
          contract,
          to: trimmedDest,
          amount: netAmount,
        }),
        transfer({
          contract,
          to: FEE_TREASURY,
          amount: feeStr,
        }),
      ];
      console.log(
        "✅ [STEP B] Payload transfer ERC-20 (net + fee) berhasil disiapkan.",
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
        `✅ [STEP C] Konfigurasi smartWallet siap menggunakan Factory: ${process.env.TW_FACTORY_ADDRESS}`,
      );

      // Hubungkan ke Smart Wallet milik user menggunakan adminAccount sebagai signer
      const userSmartAccount = await userSmartWalletConfig.connect({
        client,
        personalAccount: adminAccount,
        accountAddress: userWallet.address,
      });
      console.log(
        `✅ [STEP D] Berhasil connect ke userSmartAccount dengan Alamat: ${userSmartAccount.address}`,
      );
      console.log(
        `ℹ️ [INFO SIGNER] Personal Account (Signer) yang terpasang: ${adminAccount.address}`,
      );

      // Eksekusi pengiriman transaksi sekali jalan menggunakan Smart Account
      console.log(
        "⏳ [STEP E] Mengirim batch transaksi ke jaringan blockchain via sendBatchTransaction...",
      );
      const txResult = await sendBatchTransaction({
        transactions: transferTxs,
        account: userSmartAccount,
      });

      const realTxHash = txResult.transactionHash;
      console.log(
        `🎉 [WITHDRAW SUCCESS] Transaksi Berhasil! Real Hash: ${realTxHash}`,
      );

      const rpcRequest = getRpcClient({ client, chain: sepolia });
      const currentBlockNumber = await cachedBlockNumber(rpcRequest);
      console.log(`✅ [STEP F] Block Number saat ini: ${currentBlockNumber}`);

      // Update database dengan Hash asli dari blockchain
      await pendingTx.update({
        tx_hash: realTxHash,
        tx_block_number: currentBlockNumber,
        status: "PENDING",
      });
      console.log("✅ [WITHDRAW FINISH] Database diperbarui real hash.");
      console.log("----------------------------------------");

      return res.status(200).json({
        success: true,
        message: "Withdraw berhasil dikirim ke jaringan.",
        data: {
          txHash: realTxHash,
          asset: asset.toUpperCase(),
          amount: netAmount,
          fee: feeStr,
          grossAmount: cleanAmount,
          destinationAddress: trimmedDest,
        },
      });
    } catch (bgError) {
      console.error(
        "❌ [WITHDRAW ERROR] Gagal mengeksekusi withdraw AA:",
        bgError,
      );
      console.error("Detail Error Stack:", bgError.stack || bgError);
      await pendingTx.update({ status: "FAILED" });
      return res.status(502).json({
        success: false,
        message: "Eksekusi withdraw on-chain gagal. Silakan coba lagi.",
        error: bgError.message,
      });
    }
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

// @desc    Detail satu row activity (dipakai bottom sheet Activity)
// @route   GET /api/transactions/:coreId/detail/:refId
exports.getTransactionDetail = async (req, res) => {
  try {
    const { coreId, refId } = req.params;
    if (!coreId || !refId) {
      return res
        .status(400)
        .json({ success: false, message: "coreId dan refId wajib diisi." });
    }
    if (req.user && req.user.coreId && req.user.coreId !== coreId) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const {
      resolveActivityDetail,
    } = require("../services/activity/activity.service");

    let currentBlock = 0;
    try {
      const rpcRequest = getRpcClient({ client, chain: sepolia });
      currentBlock = await cachedBlockNumber(rpcRequest);
    } catch (err) {
      console.error("[TX DETAIL] block fetch gagal:", err.message);
    }

    const detail = await resolveActivityDetail({ coreId, refId, currentBlock });
    return res.status(200).json({ success: true, data: detail });
  } catch (error) {
    const msg = error.message || "Gagal mengambil detail transaksi";
    const code = /tidak ditemukan/.test(msg) ? 404 : 400;
    return res.status(code).json({ success: false, message: msg });
  }
};
