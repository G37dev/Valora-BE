const midtrans = require("../services/midtransService");

const {
  sequelize,
  TopUp,
  InternalWallet,
  InternalTransaction,
  User,
} = require("../models");

// ============================================================
// PAYMENT METHOD NAME
// ============================================================

const getPaymentMethodName = (paymentMethod) => {
  const names = {
    SNAP: "SNAP",
    QRIS: "QRIS",
    DANA: "DANA",
    OVO: "OVO",
    BCA_VA: "BCA Virtual Account",
    MANDIRI_VA: "Mandiri Virtual Account",
  };

  return names[paymentMethod] || paymentMethod;
};

/**
 * Midtrans mengirim settlement_time dalam format WIB
 * ("YYYY-MM-DD HH:mm:ss", Asia/Jakarta) TANPA offset.
 * new Date() mem-parse itu sebagai waktu lokal server —
 * di Vercel (UTC) hasilnya bergeser +7 jam dari waktu asli.
 * Parse eksplisit sebagai UTC+7.
 */
const parseMidtransTime = (value) => {
  if (!value) return new Date();
  const m = String(value)
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (m) return new Date(`${m[1]}T${m[2]}+07:00`);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
};

// ============================================================
// CREATE MIDTRANS TOP UP
// ============================================================

const createMidtransTopUp = async (req, res) => {
  console.log("[TopUp] req.user =", req.user);

  console.log(
    "[TopUp] authorization =",
    req.headers.authorization ? "ADA" : "TIDAK ADA",
  );

  try {
    const { amount, paymentMethod, prodDesc } = req.body;

    // ========================================================
    // USER DARI JWT
    // ========================================================

    const coreId = req.user?.coreId;

    if (!coreId) {
      return res.status(401).json({
        success: false,
        message: "Core ID tidak ditemukan di token",
      });
    }

    // ========================================================
    // VALIDATE AMOUNT
    // ========================================================

    const numericAmount = Number(amount);

    if (!Number.isSafeInteger(numericAmount) || numericAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid amount",
      });
    }

    if (numericAmount < 10000) {
      return res.status(400).json({
        success: false,
        message: "Minimum deposit IDR adalah 10.000 IDR",
      });
    }

    // ========================================================
    // VALIDATE PAYMENT METHOD
    // ========================================================

    if (!paymentMethod) {
      return res.status(400).json({
        success: false,
        message: "paymentMethod is required",
      });
    }

    // Untuk flow yang sekarang, frontend menggunakan SNAP.
    // Midtrans yang menampilkan pilihan QRIS / DANA / OVO / VA.
    if (String(paymentMethod).toUpperCase() !== "SNAP") {
      return res.status(400).json({
        success: false,
        message: "Top Up saat ini harus menggunakan paymentMethod SNAP",
      });
    }

    // ========================================================
    // GET USER
    // ========================================================

    const user = await User.findByPk(coreId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // ========================================================
    // USER DATA
    // ========================================================

    const userName =
      user.name ||
      user.fullName ||
      user.username ||
      req.user?.name ||
      "Customer";

    const userEmail = user.email || req.user?.email || null;

    const userContact = user.phone || user.phoneNumber || user.contact || null;

    if (!userEmail) {
      return res.status(400).json({
        success: false,
        message: "User email not found",
      });
    }

    if (!userContact) {
      return res.status(400).json({
        success: false,
        message: "User contact not found",
      });
    }

    // ========================================================
    // GET / CREATE INTERNAL WALLET
    // ========================================================

    let wallet = await InternalWallet.findOne({
      where: {
        coreId: String(coreId),
      },
    });

    if (!wallet) {
      console.log("[TopUp] InternalWallet belum ada. Membuat wallet:", coreId);

      wallet = await InternalWallet.create({
        coreId: String(coreId),
        balanceIdr: 0,
      });
    }

    console.log("[TopUp] InternalWallet:", {
      walletId: wallet.id,
      coreId: wallet.coreId,
      balanceIdr: wallet.balanceIdr,
    });

    // ========================================================
    // GENERATE REF NO
    // ========================================================

    const refNo = `TOPUP-${Date.now()}-${coreId}`;

    // ========================================================
    // CREATE TOP UP
    // ========================================================

    const topUp = await TopUp.create({
      refNo,

      coreId: String(coreId),

      internalWalletId: wallet.id,

      amountIdr: numericAmount,

      currency: "IDR",

      paymentMethod: "SNAP",

      provider: "MIDTRANS",

      status: "PENDING",
    });

    console.log("[TopUp] Created:", {
      id: topUp.id,
      refNo: topUp.refNo,
      coreId: topUp.coreId,
      internalWalletId: topUp.internalWalletId,
      amount: topUp.amountIdr,
    });

    // ========================================================
    // CREATE MIDTRANS PAYMENT
    // ========================================================

    let payment;

    try {
      payment = await midtrans.createPayment({
        refNo: topUp.refNo,

        amount: numericAmount,

        userName: String(userName).trim(),

        userEmail: String(userEmail).trim(),

        userContact: String(userContact).trim(),

        prodDesc: prodDesc || "Top Up IDR",
      });
    } catch (midtransError) {
      console.error("[Midtrans] createPayment failed:", midtransError);

      // Midtrans gagal -> TopUp FAILED
      await topUp.update({
        status: "FAILED",

        failureReason:
          midtransError.message || "Failed to create Midtrans payment",
      });

      throw midtransError;
    }

    // ========================================================
    // VALIDATE MIDTRANS RESPONSE
    // ========================================================

    if (!payment) {
      await topUp.update({
        status: "FAILED",
        failureReason: "Empty response from Midtrans",
      });

      throw new Error("Empty response from Midtrans");
    }

    if (!payment.token && !payment.redirectUrl) {
      await topUp.update({
        status: "FAILED",
        failureReason: "Midtrans token/redirectUrl tidak tersedia",
      });

      throw new Error("Midtrans token/redirectUrl tidak tersedia");
    }

    // ========================================================
    // UPDATE PROVIDER PAYMENT ID
    // ========================================================

    await topUp.update({
      providerPaymentId: payment.orderId || topUp.refNo,
      snapToken: payment.token || null,
      expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      rawResponse: {
        redirectUrl: payment.redirectUrl || null,
        orderId: payment.orderId || null,
      },
    });

    // ========================================================
    // RESPONSE
    // ========================================================

    return res.status(200).json({
      success: true,

      message: "Midtrans payment created",

      data: {
        topUpId: String(topUp.id),

        refNo: topUp.refNo,

        orderId: payment.orderId || topUp.refNo,

        amount: Number(topUp.amountIdr),

        currency: topUp.currency,

        paymentMethod: "SNAP",

        paymentMethodName: "SNAP",

        status: topUp.status,

        redirectUrl: payment.redirectUrl || null,

        token: payment.token || null,

        clientKey: payment.clientKey || null,
      },
    });
  } catch (error) {
    console.error("[Midtrans] Create payment error:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Failed to create Midtrans payment",

      code: error.code || "MIDTRANS_ERROR",
    });
  }
};

// ============================================================
// MIDTRANS WEBHOOK
// ============================================================

const handleMidtransNotification = async (req, res) => {
  try {
    const notification = req.body || {};

    const {
      order_id,
      status_code,
      gross_amount,
      signature_key,
      transaction_status,
      fraud_status,
      transaction_id,
      payment_type,
      transaction_time,
      settlement_time,
      currency,
    } = notification;

    console.log("[Midtrans] Notification:", {
      order_id,
      transaction_status,
      fraud_status,
      gross_amount,
      currency,
      payment_type,
    });

    // ========================================================
    // VALIDATE NOTIFICATION
    // ========================================================

    if (!order_id) {
      return res.status(400).json({
        success: false,
        message: "order_id is required",
      });
    }

    if (!status_code) {
      return res.status(400).json({
        success: false,
        message: "status_code is required",
      });
    }

    if (gross_amount === undefined || gross_amount === null) {
      return res.status(400).json({
        success: false,
        message: "gross_amount is required",
      });
    }

    if (!signature_key) {
      return res.status(400).json({
        success: false,
        message: "signature_key is required",
      });
    }

    // ========================================================
    // VERIFY MIDTRANS SIGNATURE
    // ========================================================

    const validSignature = midtrans.verifyNotificationSignature({
      order_id,
      status_code,
      gross_amount,
      signature_key,
    });

    if (!validSignature) {
      console.error("[Midtrans] Invalid signature:", order_id);

      return res.status(403).json({
        success: false,
        message: "Invalid signature",
      });
    }

    // ========================================================
    // NORMALIZE STATUS
    // ========================================================

    const status = String(transaction_status || "").toLowerCase();

    const fraud = String(fraud_status || "").toLowerCase();

    // ========================================================
    // FAILED / EXPIRED / CANCELLED
    // ========================================================

    if (midtrans.isFailedStatus(status)) {
      await sequelize.transaction(async (transaction) => {
        const topUp = await TopUp.findOne({
          where: {
            refNo: String(order_id),
          },

          transaction,

          lock: transaction.LOCK.UPDATE,
        });

        if (!topUp) {
          throw new Error(`TopUp not found: ${order_id}`);
        }

        // SUCCESS tidak boleh kembali FAILED
        if (topUp.status === "SUCCESS") {
          return;
        }

        // Terminal state
        if (["FAILED", "EXPIRED"].includes(topUp.status)) {
          return;
        }

        const newStatus = status === "expire" ? "EXPIRED" : "FAILED";

        await topUp.update(
          {
            status: newStatus,

            failureReason: status,

            providerPaymentId: transaction_id || topUp.providerPaymentId,

            callbackPayload: notification,
          },
          {
            transaction,
          },
        );
      });

      console.log("[Midtrans] TopUp failed:", order_id);

      return res.status(200).json({
        success: true,
        message: "Notification received",
      });
    }

    // ========================================================
    // PENDING
    // ========================================================

    if (midtrans.isPendingStatus(status)) {
      await sequelize.transaction(async (transaction) => {
        const topUp = await TopUp.findOne({
          where: {
            refNo: String(order_id),
          },

          transaction,

          lock: transaction.LOCK.UPDATE,
        });

        if (!topUp) {
          throw new Error(`TopUp not found: ${order_id}`);
        }

        // Jangan ubah SUCCESS menjadi PENDING
        if (["SUCCESS", "FAILED", "EXPIRED"].includes(topUp.status)) {
          return;
        }

        await topUp.update(
          {
            status: "PENDING",

            providerPaymentId: transaction_id || topUp.providerPaymentId,

            callbackPayload: notification,
          },
          {
            transaction,
          },
        );
      });

      console.log("[Midtrans] TopUp pending:", order_id);

      return res.status(200).json({
        success: true,
        message: "Notification received",
      });
    }

    // ========================================================
    // SUCCESS
    // ========================================================

    if (midtrans.isSuccessStatus(status)) {
      // Capture harus fraud accept
      if (status === "capture" && fraud && fraud !== "accept") {
        console.log("[Midtrans] Capture but fraud not accepted:", {
          order_id,
          fraud_status,
        });

        return res.status(200).json({
          success: true,
          message: "Notification received",
        });
      }

      // ======================================================
      // DATABASE TRANSACTION
      // ======================================================

      await sequelize.transaction(async (transaction) => {
        // ----------------------------------------------------
        // LOCK TOP UP
        // ----------------------------------------------------

        const topUp = await TopUp.findOne({
          where: {
            refNo: String(order_id),
          },

          transaction,

          lock: transaction.LOCK.UPDATE,
        });

        if (!topUp) {
          throw new Error(`TopUp not found: ${order_id}`);
        }

        // ----------------------------------------------------
        // IDEMPOTENCY TOP UP
        // ----------------------------------------------------

        if (topUp.status === "SUCCESS") {
          console.log("[Midtrans] Already processed:", order_id);

          return;
        }

        // ----------------------------------------------------
        // TERMINAL STATE
        // ----------------------------------------------------

        if (["FAILED", "EXPIRED"].includes(topUp.status)) {
          throw new Error(`Cannot settle terminal TopUp: ${order_id}`);
        }

        // ----------------------------------------------------
        // VERIFY AMOUNT
        // ----------------------------------------------------

        const receivedAmount = Number(gross_amount);

        const expectedAmount = Number(topUp.amountIdr);

        if (
          !Number.isFinite(receivedAmount) ||
          !Number.isFinite(expectedAmount)
        ) {
          throw new Error(`Invalid amount for TopUp: ${order_id}`);
        }

        if (receivedAmount !== expectedAmount) {
          throw new Error(
            `Amount mismatch for TopUp ${order_id}: received=${receivedAmount}, expected=${expectedAmount}`,
          );
        }

        // ----------------------------------------------------
        // VERIFY CURRENCY
        // ----------------------------------------------------

        if (String(topUp.currency).toUpperCase() !== "IDR") {
          throw new Error(`Currency mismatch for TopUp: ${order_id}`);
        }

        if (currency && String(currency).toUpperCase() !== "IDR") {
          throw new Error(
            `Notification currency mismatch for TopUp: ${order_id}`,
          );
        }

        // ----------------------------------------------------
        // GET / LOCK WALLET
        // ----------------------------------------------------

        const wallet = await InternalWallet.findOne({
          where: {
            id: topUp.internalWalletId,
          },

          transaction,

          lock: transaction.LOCK.UPDATE,
        });

        if (!wallet) {
          throw new Error(
            `InternalWallet not found: ${topUp.internalWalletId}`,
          );
        }

        // ----------------------------------------------------
        // REFERENCE LEDGER
        // ----------------------------------------------------

        const reference = `TOPUP-${topUp.id}`;

        // ----------------------------------------------------
        // CEK INTERNAL TRANSACTION
        //
        // PENTING:
        // Check dilakukan SEBELUM wallet di-credit.
        // ----------------------------------------------------

        const existingTransaction = await InternalTransaction.findOne({
          where: {
            reference,
          },

          transaction,

          lock: transaction.LOCK.UPDATE,
        });

        if (existingTransaction) {
          console.log("[Midtrans] InternalTransaction already exists:", {
            reference,
            status: existingTransaction.status,
          });

          // Kalau ledger sudah SUCCESS,
          // cukup tandai TopUp SUCCESS.
          if (existingTransaction.status === "SUCCESS") {
            await topUp.update(
              {
                status: "SUCCESS",

                providerPaymentId: transaction_id || topUp.providerPaymentId,

                paidAt: parseMidtransTime(settlement_time),

                callbackPayload: notification,
              },
              {
                transaction,
              },
            );

            return;
          }

          throw new Error(`InternalTransaction already exists: ${reference}`);
        }

        // ----------------------------------------------------
        // BALANCE
        // ----------------------------------------------------

        const balanceBefore = Number(wallet.balanceIdr);

        const topUpAmount = Number(topUp.amountIdr);

        if (!Number.isFinite(balanceBefore) || !Number.isFinite(topUpAmount)) {
          throw new Error(`Invalid wallet balance/TopUp amount: ${order_id}`);
        }

        const balanceAfter = balanceBefore + topUpAmount;

        // ----------------------------------------------------
        // CREDIT WALLET
        // ----------------------------------------------------

        await wallet.update(
          {
            balanceIdr: balanceAfter,
          },
          {
            transaction,
          },
        );

        console.log("[Midtrans] Wallet credited:", {
          walletId: wallet.id,
          coreId: wallet.coreId,
          balanceBefore,
          amount: topUpAmount,
          balanceAfter,
        });

        // ----------------------------------------------------
        // CREATE INTERNAL TRANSACTION
        // ----------------------------------------------------

        await InternalTransaction.create(
          {
            internalWalletId: topUp.internalWalletId,

            topUpId: topUp.id,

            coreId: topUp.coreId,

            type: "CREDIT",

            asset: "IDR",

            amount: topUpAmount,

            balanceBefore,

            balanceAfter,

            reference,

            status: "SUCCESS",

            metadata: {
              provider: "MIDTRANS",

              providerPaymentId: transaction_id || null,

              paymentType: payment_type || null,

              transactionStatus: status,

              transactionTime: transaction_time || null,

              settlementTime: settlement_time || null,

              grossAmount: gross_amount,

              currency: currency || "IDR",

              notification,
            },
          },
          {
            transaction,
          },
        );

        // ----------------------------------------------------
        // MARK TOP UP SUCCESS
        // ----------------------------------------------------

        await topUp.update(
          {
            status: "SUCCESS",

            providerPaymentId: transaction_id || topUp.providerPaymentId,

            paidAt: parseMidtransTime(settlement_time),

            callbackPayload: notification,
          },
          {
            transaction,
          },
        );

        console.log("[Midtrans] TOP UP SETTLED:", {
          topUpId: topUp.id,

          orderId: order_id,

          amount: topUpAmount,

          balanceBefore,

          balanceAfter,

          reference,
        });
      });

      return res.status(200).json({
        success: true,
        message: "Payment processed successfully",
      });
    }

    // ========================================================
    // UNKNOWN STATUS
    // ========================================================

    console.log("[Midtrans] Unknown transaction status:", {
      order_id,
      status,
    });

    return res.status(200).json({
      success: true,
      message: "Notification received",
    });
  } catch (error) {
    console.error("[Midtrans] Notification error:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Notification processing failed",
    });
  }
};

// ============================================================
// MIDTRANS RESPONSE
// ============================================================

const handleMidtransResponse = async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "orderId is required",
      });
    }

    const result = await midtrans.getTransactionStatus(orderId);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("[Midtrans] Response error:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Failed to check Midtrans payment",
    });
  }
};

// ============================================================
// GET TOP UP STATUS
// ============================================================

const getTopUpStatus = async (req, res) => {
  try {
    const { refNo } = req.params;

    if (!refNo) {
      return res.status(400).json({
        success: false,
        message: "refNo is required",
      });
    }

    const topUp = await TopUp.findOne({
      where: {
        refNo: String(refNo),
      },

      attributes: [
        "id",
        "refNo",
        "coreId",
        "internalWalletId",
        "provider",
        "providerPaymentId",
        "amountIdr",
        "currency",
        "status",
        "paymentMethod",
        "expiredAt",
        "failureReason",
        "paidAt",
        "callbackPayload",
        "created_at",
        "updated_at",
      ],
    });

    if (!topUp) {
      return res.status(404).json({
        success: false,
        message: "TopUp not found",
      });
    }

    /*
     * Refresh status dari Midtrans kalau masih PENDING — webhook "expire"
     * tidak selalu sampai, jadi tanpa ini topup yang kadaluarsa di sisi
     * Midtrans akan PENDING selamanya di DB dan user terkunci tidak bisa
     * membuat transaksi baru.
     */
    if (topUp.status === "PENDING") {
      try {
        const tx = await midtrans.getTransactionStatus(
          topUp.providerPaymentId || topUp.refNo,
        );
        const txStatus = String(tx?.transaction_status || "").toLowerCase();

        /*
         * Midtrans balas HTTP 200 dengan status_code "404" baik untuk
         * order Snap yang sudah mati MAUPUN topup fresh yang belum pernah
         * dibayar. Jangan langsung anggap expired — hanya terminal kalau
         * order sudah melewati batas umur Snap (expiredAt / 24 jam).
         */
        const ageMs =
          Date.now() - new Date(topUp.createdAt || topUp.created_at).getTime();
        const pastExpiry =
          (topUp.expiredAt && new Date(topUp.expiredAt).getTime() <= Date.now()) ||
          ageMs > 24 * 60 * 60 * 1000;

        const orderDead =
          (String(tx?.status_code) === "404" ||
            (!txStatus && !midtrans.isSuccessStatus(txStatus))) &&
          pastExpiry;

        if (midtrans.isFailedStatus(txStatus) || orderDead) {
          const newStatus =
            txStatus === "expire" || orderDead ? "EXPIRED" : "FAILED";
          await topUp.update({
            status: newStatus,
            failureReason:
              txStatus || tx?.status_message || "order not found",
          });
        }
      } catch (statusErr) {
        // Query gagal (network/404) — kembalikan status DB, jangan block.
        console.warn(
          "[Midtrans] Status refresh skipped for",
          topUp.refNo,
          statusErr.message,
        );
      }
    }

    return res.status(200).json({
      success: true,
      data: topUp,
    });
  } catch (error) {
    console.error("[Midtrans] Get TopUp status error:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Failed to get TopUp status",
    });
  }
};

// ============================================================
// RENDER MIDTRANS CHECKOUT
// ============================================================

const renderMidtransCheckout = async (req, res) => {
  try {
    const { refNo } = req.params;

    if (!refNo) {
      return res.status(400).send("refNo is required");
    }

    const topUp = await TopUp.findOne({
      where: {
        refNo: String(refNo),
      },
    });

    if (!topUp) {
      return res.status(404).send("TopUp not found");
    }

    return res.status(200).json({
      success: true,

      data: {
        refNo: topUp.refNo,

        status: topUp.status,

        amountIdr: topUp.amountIdr,

        paymentMethod: topUp.paymentMethod,
      },
    });
  } catch (error) {
    console.error("[Midtrans] Checkout error:", error);

    return res.status(500).json({
      success: false,

      message: error.message || "Failed to get checkout",
    });
  }
};

// ============================================================
// EXPORT
// ============================================================

// ============================================================
// LIST TOP UPS (history + pending) milik user yang login
// ============================================================

const listTopUps = async (req, res) => {
  try {
    const coreId = req.user?.coreId;

    if (!coreId) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    const topUps = await TopUp.findAll({
      where: { coreId: String(coreId) },
      order: [["created_at", "DESC"]],
      limit: 50,
      attributes: [
        "id",
        "refNo",
        "amountIdr",
        "currency",
        "status",
        "paymentMethod",
        "expiredAt",
        "paidAt",
        "snapToken",
        "rawResponse",
        "created_at",
      ],
    });

    const data = topUps.map((t) => {
      const j = t.toJSON();
      return {
        id: j.id,
        refNo: j.refNo,
        amountIdr: j.amountIdr,
        currency: j.currency,
        status: j.status,
        paymentMethod: j.paymentMethod,
        expiredAt: j.expiredAt,
        paidAt: j.paidAt,
        createdAt: j.created_at || j.createdAt,
        // redirectUrl hanya relevan untuk resume transaksi PENDING.
        redirectUrl:
          j.status === "PENDING" ? j.rawResponse?.redirectUrl || null : null,
      };
    });

    return res.status(200).json({ success: true, data });
  } catch (error) {
    console.error("[Midtrans] List TopUps error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to list top ups",
    });
  }
};

module.exports = {
  createMidtransTopUp,

  handleMidtransNotification,

  handleMidtransResponse,

  renderMidtransCheckout,

  getTopUpStatus,

  listTopUps,
};
