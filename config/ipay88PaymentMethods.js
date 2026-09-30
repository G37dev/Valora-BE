const IPAY88_PAYMENT_METHODS = Object.freeze({
  // ==========================================
  // CREDIT / DEBIT CARD
  // ==========================================

  CREDIT_CARD_BCA: {
    paymentId: "101",
    name: "Credit Card (BCA)",
    category: "CARD",
    currency: "IDR",
  },

  CREDIT_CARD_BCA_2D: {
    paymentId: "102",
    name: "Credit Card (BCA 2D)",
    category: "CARD",
    currency: "IDR",
  },

  CREDIT_CARD_BRI: {
    paymentId: "105",
    name: "Credit Card (BRI)",
    category: "CARD",
    currency: "IDR",
  },

  CREDIT_CARD_BRI_2D: {
    paymentId: "106",
    name: "Credit Card (BRI 2D)",
    category: "CARD",
    currency: "IDR",
  },

  CREDIT_CARD_CIMB: {
    paymentId: "103",
    name: "Credit Card (CIMB)",
    category: "CARD",
    currency: "IDR",
  },

  CREDIT_CARD_CIMB_2D: {
    paymentId: "104",
    name: "Credit Card (CIMB 2D)",
    category: "CARD",
    currency: "IDR",
  },

  CREDIT_CARD_CIMB_AUTHORIZATION: {
    paymentId: "116",
    name: "Credit Card (CIMB Authorization)",
    category: "CARD",
    currency: "IDR",
  },

  CREDIT_CARD_CIMB_IPG: {
    paymentId: "34",
    name: "Credit Card (CIMB IPG)",
    category: "CARD",
    currency: "IDR",
  },

  CREDIT_CARD_CIMB_IPG_2D: {
    paymentId: "44",
    name: "Credit Card (CIMB IPG 2D)",
    category: "CARD",
    currency: "IDR",
  },

  CREDIT_CARD_DANAMON: {
    paymentId: "88",
    name: "Credit Card (Danamon)",
    category: "CARD",
    currency: "IDR",
  },

  DEBIT_CARD_GPN: {
    paymentId: "49",
    name: "Debit Card (GPN)",
    category: "CARD",
    currency: "IDR",
  },

  CREDIT_CARD_UNIONPAY: {
    paymentId: "54",
    name: "Credit Card (UnionPay)",
    category: "CARD",
    currency: "IDR",
  },

  // ==========================================
  // ONLINE BANKING
  // ==========================================

  CIMB_CLICKS: {
    paymentId: "81",
    name: "CIMB Clicks",
    category: "ONLINE_BANKING",
    currency: "IDR",
  },

  D_BANK_PRO: {
    paymentId: "23",
    name: "D-Bank Pro",
    category: "ONLINE_BANKING",
    currency: "IDR",
  },

  JENIUS_PAY: {
    paymentId: "80",
    name: "Jenius Pay",
    category: "ONLINE_BANKING",
    currency: "IDR",
  },

  // ==========================================
  // VIRTUAL ACCOUNT
  // ==========================================

  MAYBANK_VA: {
    paymentId: "9",
    name: "Maybank VA",
    category: "VIRTUAL_ACCOUNT",
    currency: "IDR",
    seamless: true,
  },

  PERMATA_VA: {
    paymentId: "112",
    name: "Permata VA",
    category: "VIRTUAL_ACCOUNT",
    currency: "IDR",
    seamless: true,
  },

  MANDIRI_VA: {
    paymentId: "119",
    name: "Mandiri VA",
    category: "VIRTUAL_ACCOUNT",
    currency: "IDR",
    seamless: true,
  },

  BCA_VA: {
    paymentId: "140",
    name: "BCA VA",
    category: "VIRTUAL_ACCOUNT",
    currency: "IDR",
    seamless: true,
  },

  BRI_VA: {
    paymentId: "118",
    name: "BRI VA",
    category: "VIRTUAL_ACCOUNT",
    currency: "IDR",
    seamless: true,
  },

  BNI_VA: {
    paymentId: "139",
    name: "BNI VA",
    category: "VIRTUAL_ACCOUNT",
    currency: "IDR",
    seamless: true,
  },

  CIMB_VA: {
    paymentId: "135",
    name: "CIMB VA",
    category: "VIRTUAL_ACCOUNT",
    currency: "IDR",
    seamless: true,
  },

  DANAMON_VA: {
    paymentId: "111",
    name: "Danamon VA",
    category: "VIRTUAL_ACCOUNT",
    currency: "IDR",
    seamless: true,
  },

  // ==========================================
  // VIRTUAL ACCOUNT STATIC
  // ==========================================

  BRI_VA_STATIC: {
    paymentId: "118",
    name: "BRI VA Static",
    category: "VIRTUAL_ACCOUNT_STATIC",
    currency: "IDR",
    seamless: true,
  },

  MANDIRI_VA_STATIC: {
    paymentId: "119",
    name: "Mandiri VA Static",
    category: "VIRTUAL_ACCOUNT_STATIC",
    currency: "IDR",
    seamless: true,
  },

  MAYBANK_VA_STATIC: {
    paymentId: "9",
    name: "Maybank VA Static",
    category: "VIRTUAL_ACCOUNT_STATIC",
    currency: "IDR",
    seamless: true,
  },

  PERMATA_VA_STATIC: {
    paymentId: "112",
    name: "Permata VA Static",
    category: "VIRTUAL_ACCOUNT_STATIC",
    currency: "IDR",
    seamless: true,
  },

  BCA_VA_STATIC: {
    paymentId: "140",
    name: "ALTO BCA VA Static",
    category: "VIRTUAL_ACCOUNT_STATIC",
    currency: "IDR",
    seamless: true,
  },

  // ==========================================
  // E-WALLET
  // ==========================================

  OVO: {
    paymentId: "63",
    name: "OVO",
    category: "E_WALLET",
    currency: "IDR",
  },

  DANA: {
    paymentId: "134",
    name: "DANA",
    category: "E_WALLET",
    currency: "IDR",
  },

  LINKAJA: {
    paymentId: "13",
    name: "LinkAja",
    category: "E_WALLET",
    currency: "IDR",
  },

  SHOPEEPAY_JUMPAPP: {
    paymentId: "133",
    name: "ShopeePay JumpApp",
    category: "E_WALLET",
    currency: "IDR",
  },

  // ==========================================
  // QRIS
  // ==========================================

  QRIS: {
    paymentId: "120",
    name: "QRIS",
    category: "QRIS",
    currency: "IDR",
    seamless: true,
  },

  QRIS_STATIC: {
    paymentId: "144",
    name: "QRIS Static",
    category: "QRIS_STATIC",
    currency: "IDR",
    seamless: true,
  },

  // ==========================================
  // OVER THE COUNTER
  // ==========================================

  ALFAMART: {
    paymentId: "60",
    name: "Alfamart",
    category: "OVER_THE_COUNTER",
    currency: "IDR",
    seamless: true,
  },

  INDOMARET: {
    paymentId: "65",
    name: "Indomaret",
    category: "OVER_THE_COUNTER",
    currency: "IDR",
    seamless: true,
  },

  // ==========================================
  // ONLINE CREDIT
  // ==========================================

  AKULAKU: {
    paymentId: "71",
    name: "Akulaku",
    category: "ONLINE_CREDIT",
    currency: "IDR",
  },

  INDODANA: {
    paymentId: "70",
    name: "Indodana",
    category: "ONLINE_CREDIT",
    currency: "IDR",
  },

  KREDIVO: {
    paymentId: "55",
    name: "Kredivo",
    category: "ONLINE_CREDIT",
    currency: "IDR",
  },

  ATOME: {
    paymentId: "73",
    name: "Atome",
    category: "ONLINE_CREDIT",
    currency: "IDR",
  },
});

/**
 * Ambil metode pembayaran berdasarkan key.
 */
const getPaymentMethod = (method) => {
  if (!method) {
    return null;
  }

  const key = String(method).trim().toUpperCase();

  const paymentMethod = IPAY88_PAYMENT_METHODS[key];

  if (!paymentMethod) {
    return null;
  }

  return {
    key,
    ...paymentMethod,
  };
};

/**
 * Pastikan payment method tersedia.
 */
const requirePaymentMethod = (method) => {
  const paymentMethod = getPaymentMethod(method);

  if (!paymentMethod) {
    const error = new Error(`Unsupported iPay88 payment method: ${method}`);

    error.code = "IPAY88_UNSUPPORTED_PAYMENT_METHOD";

    throw error;
  }

  return paymentMethod;
};

/**
 * Daftar semua metode untuk FE.
 *
 * PaymentId boleh dikirim sebagai response
 * ke FE untuk informasi/display, tetapi FE
 * tidak boleh mengontrol PaymentId saat checkout.
 */
const getAvailablePaymentMethods = () => {
  return Object.entries(IPAY88_PAYMENT_METHODS).map(([key, value]) => ({
    key,
    name: value.name,
    category: value.category,
    currency: value.currency,
    seamless: value.seamless || false,
  }));
};

module.exports = {
  IPAY88_PAYMENT_METHODS,
  getPaymentMethod,
  requirePaymentMethod,
  getAvailablePaymentMethods,
};
