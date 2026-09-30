const axios = require("axios");
const crypto = require("crypto");

/**
 * ============================================================
 * CONFIG
 * ============================================================
 */

const MIDTRANS_ENV = String(process.env.MIDTRANS_ENV || "sandbox")
  .trim()
  .toLowerCase();

const CONFIG = {
  sandbox: {
    snapUrl: "https://app.sandbox.midtrans.com/snap/v1/transactions",
    apiUrl: "https://api.sandbox.midtrans.com",
  },

  production: {
    snapUrl: "https://app.midtrans.com/snap/v1/transactions",
    apiUrl: "https://api.midtrans.com",
  },
};

const config = CONFIG[MIDTRANS_ENV];

if (!config) {
  throw new Error(`Invalid MIDTRANS_ENV: ${MIDTRANS_ENV}`);
}

/**
 * ============================================================
 * MERCHANT CONFIG
 * ============================================================
 */

const serverKey = String(process.env.MIDTRANS_SERVER_KEY || "").trim();

const clientKey = String(process.env.MIDTRANS_CLIENT_KEY || "").trim();

if (!serverKey) {
  throw new Error("MIDTRANS_SERVER_KEY is not configured");
}

if (!clientKey) {
  throw new Error("MIDTRANS_CLIENT_KEY is not configured");
}

/**
 * ============================================================
 * CALLBACK CONFIG
 * ============================================================
 */

const finishRedirectUrl = String(
  process.env.MIDTRANS_FINISH_REDIRECT_URL || "",
).trim();

const unfinishRedirectUrl = String(
  process.env.MIDTRANS_UNFINISH_REDIRECT_URL || "",
).trim();

const errorRedirectUrl = String(
  process.env.MIDTRANS_ERROR_REDIRECT_URL || "",
).trim();

console.log("[Midtrans] Callback config:", {
  finish: finishRedirectUrl || "(not configured)",
  unfinish: unfinishRedirectUrl || "(not configured)",
  error: errorRedirectUrl || "(not configured)",
});

/**
 * ============================================================
 * HELPERS
 * ============================================================
 */

const normalizeString = (value) => {
  return String(value ?? "").trim();
};

const formatPaymentAmount = (amount) => {
  const value = normalizeString(amount);

  if (!/^\d+$/.test(value)) {
    throw new Error("IDR amount must be a whole number");
  }

  const numeric = Number(value);

  if (!Number.isSafeInteger(numeric)) {
    throw new Error("IDR amount is too large");
  }

  if (numeric <= 0) {
    throw new Error("IDR amount must be greater than zero");
  }

  return numeric;
};

/**
 * ============================================================
 * BASIC AUTH
 * ============================================================
 */

const getAuthHeader = () => {
  const token = Buffer.from(`${serverKey}:`, "utf8").toString("base64");

  return `Basic ${token}`;
};

/**
 * ============================================================
 * CREATE SNAP PAYMENT
 * ============================================================
 */

const createPayment = async ({
  refNo,
  amount,
  userName,
  userEmail,
  userContact,
  prodDesc,
}) => {
  if (!refNo) {
    throw new Error("refNo is required");
  }

  const orderId = normalizeString(refNo);

  if (!orderId) {
    throw new Error("refNo cannot be empty");
  }

  const grossAmount = formatPaymentAmount(amount);

  const customerName = normalizeString(userName || "Customer").slice(0, 50);

  const customerEmail = normalizeString(userEmail).slice(0, 100);

  const customerPhone = normalizeString(userContact).slice(0, 20);

  if (!customerEmail) {
    throw new Error("userEmail is required");
  }

  if (!customerPhone) {
    throw new Error("userContact is required");
  }

  /**
   * ----------------------------------------------------------
   * SNAP REQUEST
   * ----------------------------------------------------------
   *
   * User tetap menggunakan Snap WebView.
   *
   * Di dalam Snap:
   * - QRIS
   * - GoPay
   * - DANA
   * - OVO
   * - Virtual Account
   * - payment method lain yang aktif
   *
   * akan ditampilkan oleh Midtrans sesuai konfigurasi merchant.
   */

  const parameter = {
    transaction_details: {
      order_id: orderId,
      gross_amount: grossAmount,
    },

    customer_details: {
      first_name: customerName,
      email: customerEmail,
      phone: customerPhone,
    },

    item_details: [
      {
        id: orderId,
        price: grossAmount,
        quantity: 1,
        name: normalizeString(prodDesc || "Top Up IDR").slice(0, 50),
      },
    ],

    /**
     * --------------------------------------------------------
     * SNAP CALLBACK
     * --------------------------------------------------------
     *
     * Setelah payment selesai:
     *
     * finish   -> payment/success
     * unfinish -> payment/pending
     * error    -> payment/error
     */

    callbacks: {
      ...(finishRedirectUrl
        ? {
            finish: finishRedirectUrl,
          }
        : {}),

      ...(unfinishRedirectUrl
        ? {
            unfinish: unfinishRedirectUrl,
          }
        : {}),

      ...(errorRedirectUrl
        ? {
            error: errorRedirectUrl,
          }
        : {}),
    },
  };

  console.log("[Midtrans] Payment Request:", {
    environment: MIDTRANS_ENV,
    orderId,
    grossAmount,
    currency: "IDR",

    callbacks: {
      finish: finishRedirectUrl || null,
      unfinish: unfinishRedirectUrl || null,
      error: errorRedirectUrl || null,
    },
  });

  let response;

  try {
    response = await axios.post(config.snapUrl, parameter, {
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },

      timeout: 30000,
    });
  } catch (error) {
    console.error("[Midtrans] Payment request failed:", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });

    const serviceError = new Error(
      error.response?.data?.error_messages?.join(", ") ||
        error.response?.data?.status_message ||
        error.message ||
        "Unable to create Midtrans payment",
    );

    serviceError.code = "MIDTRANS_SNAP_ERROR";
    serviceError.cause = error;
    serviceError.midtrans = error.response?.data || null;

    throw serviceError;
  }

  const data = response.data;

  if (!data || typeof data !== "object") {
    throw new Error("Invalid response from Midtrans Snap");
  }

  const token = data.token || null;

  const redirectUrl = data.redirect_url || data.redirectUrl || null;

  if (!token && !redirectUrl) {
    const error = new Error(
      "Midtrans Snap tidak mengembalikan token atau redirect URL",
    );

    error.code = "MIDTRANS_SNAP_INVALID_RESPONSE";
    error.midtrans = data;

    throw error;
  }

  console.log("[Midtrans] Payment Response:", {
    orderId,
    hasToken: Boolean(token),
    redirectUrl,
  });

  return {
    success: true,

    environment: MIDTRANS_ENV,

    orderId,

    token,

    redirectUrl,

    clientKey,

    grossAmount,

    currency: "IDR",

    raw: data,
  };
};

/**
 * ============================================================
 * VERIFY WEBHOOK SIGNATURE
 * ============================================================
 *
 * SHA512:
 *
 * order_id + status_code + gross_amount + ServerKey
 */

const generateNotificationSignature = ({
  orderId,
  statusCode,
  grossAmount,
}) => {
  const raw =
    `${orderId}` + `${statusCode}` + `${grossAmount}` + `${serverKey}`;

  return crypto.createHash("sha512").update(raw, "utf8").digest("hex");
};

const verifyNotificationSignature = ({
  order_id,
  status_code,
  gross_amount,
  signature_key,
}) => {
  if (
    !order_id ||
    !status_code ||
    typeof gross_amount === "undefined" ||
    !signature_key
  ) {
    return false;
  }

  const expected = generateNotificationSignature({
    orderId: order_id,
    statusCode: status_code,
    grossAmount: gross_amount,
  });

  return String(signature_key).toLowerCase() === expected.toLowerCase();
};

/**
 * ============================================================
 * STATUS HELPERS
 * ============================================================
 */

const isSuccessStatus = (transactionStatus) => {
  return ["capture", "settlement"].includes(
    String(transactionStatus).toLowerCase(),
  );
};

const isPendingStatus = (transactionStatus) => {
  return String(transactionStatus).toLowerCase() === "pending";
};

const isFailedStatus = (transactionStatus) => {
  return ["deny", "cancel", "expire", "failure"].includes(
    String(transactionStatus).toLowerCase(),
  );
};

/**
 * ============================================================
 * QUERY TRANSACTION
 * ============================================================
 */

const getTransactionStatus = async (orderId) => {
  if (!orderId) {
    throw new Error("orderId is required");
  }

  try {
    const response = await axios.get(
      `${config.apiUrl}/v2/${encodeURIComponent(orderId)}/status`,
      {
        headers: {
          Authorization: getAuthHeader(),
          Accept: "application/json",
        },

        timeout: 30000,
      },
    );

    return response.data;
  } catch (error) {
    console.error("[Midtrans] Query transaction failed:", {
      orderId,
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });

    const serviceError = new Error("Unable to query Midtrans transaction");

    serviceError.code = "MIDTRANS_STATUS_CONNECTION_ERROR";

    serviceError.cause = error;

    if (error.response?.data) {
      serviceError.midtrans = error.response.data;
    }

    throw serviceError;
  }
};

/**
 * ============================================================
 * CREATE QRIS PAYMENT
 * ============================================================
 *
 * Ini tetap tersedia untuk kebutuhan lain.
 *
 * TopUp utama sekarang menggunakan SNAP.
 */

const createQrisPayment = async ({
  refNo,
  amount,
  userName,
  userEmail,
  userContact,
  prodDesc = "Top Up IDR",
}) => {
  if (!refNo) {
    throw new Error("refNo is required");
  }

  const grossAmount = formatPaymentAmount(amount);

  const orderId = normalizeString(refNo);

  const payload = {
    payment_type: "qris",

    transaction_details: {
      order_id: orderId,
      gross_amount: grossAmount,
    },

    customer_details: {
      first_name: normalizeString(userName || "Customer").slice(0, 50),

      email: normalizeString(userEmail || "").slice(0, 100),

      phone: normalizeString(userContact || "").slice(0, 20),
    },

    item_details: [
      {
        id: orderId,
        price: grossAmount,
        quantity: 1,
        name: String(prodDesc).trim().slice(0, 50),
      },
    ],

    qris: {
      acquirer: "gopay",
    },
  };

  console.log("[Midtrans QRIS] Request:", {
    environment: MIDTRANS_ENV,
    orderId,
    grossAmount,
  });

  let response;

  try {
    response = await axios.post(`${config.apiUrl}/v2/charge`, payload, {
      headers: {
        Authorization: getAuthHeader(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },

      timeout: 30000,
    });
  } catch (error) {
    const serviceError = new Error(
      error.response?.data?.status_message ||
        "Unable to create Midtrans QRIS payment",
    );

    serviceError.code = "MIDTRANS_QRIS_ERROR";

    serviceError.cause = error;

    serviceError.midtrans = error.response?.data || null;

    throw serviceError;
  }

  const data = response.data;

  if (!data || typeof data !== "object") {
    throw new Error("Invalid QRIS response from Midtrans");
  }

  if (String(data.status_code) !== "201") {
    const error = new Error(
      data.status_message || "Midtrans QRIS payment failed",
    );

    error.code = "MIDTRANS_QRIS_REQUEST_FAILED";

    error.midtrans = data;

    throw error;
  }

  const qrAction = Array.isArray(data.actions)
    ? data.actions.find((action) => action.name === "generate-qr-code")
    : null;

  const qrActionV2 = Array.isArray(data.actions)
    ? data.actions.find((action) => action.name === "generate-qr-code-v2")
    : null;

  const qrCodeImageUrl = qrActionV2?.url || qrAction?.url || null;

  console.log("[Midtrans QRIS] Response:", {
    orderId: data.order_id,
    transactionId: data.transaction_id,
    status: data.transaction_status,
    qrCodeImageUrl,
  });

  return {
    success: true,

    environment: MIDTRANS_ENV,

    orderId: data.order_id,

    transactionId: data.transaction_id,

    grossAmount: data.gross_amount,

    currency: data.currency,

    paymentType: data.payment_type,

    transactionStatus: data.transaction_status,

    fraudStatus: data.fraud_status,

    acquirer: data.acquirer,

    qrString: data.qr_string || null,

    qrCodeImageUrl,

    actions: data.actions || [],

    raw: data,
  };
};

/**
 * ============================================================
 * EXPORT
 * ============================================================
 */

module.exports = {
  config,

  clientKey,

  createPayment,

  createQrisPayment,

  generateNotificationSignature,

  verifyNotificationSignature,

  getTransactionStatus,

  isSuccessStatus,

  isFailedStatus,

  isPendingStatus,

  formatPaymentAmount,
};
