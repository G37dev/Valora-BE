require("dotenv").config();

const express = require("express");
const cors = require("cors");

const {
  sequelize,
  UserPushToken,
  BusinessClock,
  LoanRiskPolicyVersion,
  LoanPool,
  LoanPoolSnapshot,
  LoanBorrowerCycle,
  LoanPosition,
  LoanDrawdown,
  LoanInterestEvent,
  LoanRepayment,
  LoanCollateralRelease,
  LoanRiskSnapshot,
  LoanLiquidation,
  LoanTreasuryLot,
  LoanPgAllocation,
  LoanEvent,
  LoanPriceTick,
} = require("./models");

const authRoutes = require("./routes/authRoutes");
const tenantRoutes = require("./routes/tenantRoutes");
const userRoutes = require("./routes/userRoutes");
const kycRoutes = require("./routes/kycRoutes");
const walletRoutes = require("./routes/walletRoutes");
const transactionRoutes = require("./routes/transactionRoutes");
const earnRoutes = require("./routes/earnRoutes");
const topupRoutes = require("./routes/topupRoutes");
const priceRoutes = require("./routes/priceRoutes");
const internalWalletRoutes = require("./routes/internalWalletRoutes");
const swapRoutes = require("./routes/swapRoutes");
const installmentRoutes = require("./routes/installmentRoutes");
const clockRoutes = require("./routes/clockRoutes");
const loanRoutes = require("./routes/loanRoutes");
const app = express();
const PORT = process.env.PORT || 5000;
app.use(cors());
app.use(
  express.json({
    // Simpan raw body — dibutuhkan untuk verifikasi
    // signature webhook (Veriff, dsb) yang dihitung
    // dari bytes asli, bukan hasil re-serialize JSON.
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);

// ===============================
// DATABASE
// ===============================

let databasePromise = null;

async function connectDatabase() {
  if (!databasePromise) {
    databasePromise = (async () => {
      await sequelize.authenticate();
      // CREATE TABLE IF NOT EXISTS — sync() tidak jalan di Vercel
      // karena app.listen hanya dieksekusi saat require.main === module.
      await UserPushToken.sync();
      await BusinessClock.sync();
      // Loan V1 — parent dulu baru child (FK order)
      await LoanRiskPolicyVersion.sync();
      await LoanPool.sync();
      await LoanPoolSnapshot.sync();
      await LoanBorrowerCycle.sync();
      await LoanPosition.sync();
      await LoanDrawdown.sync();
      await LoanInterestEvent.sync();
      await LoanRepayment.sync();
      await LoanCollateralRelease.sync();
      await LoanRiskSnapshot.sync();
      await LoanLiquidation.sync();
      await LoanTreasuryLot.sync();
      await LoanPgAllocation.sync();
      await LoanEvent.sync();
      await LoanPriceTick.sync();
    })();
  }

  await databasePromise;
}

// ===============================
// HEALTH CHECK
// ===============================

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Hello from Valora Core API",
  });
});

// ===============================
// WELL-KNOWN — Android Digital Asset Links (Passkey/WebAuthn)
// ===============================
// SHA-256 fingerprint signing certificate yang diizinkan.
// Default: debug keystore (dev build). Tambah fingerprint
// release keystore lewat env ASSETLINKS_FINGERPRINTS (comma-sep, hex tanpa colon).
app.get("/.well-known/assetlinks.json", (req, res) => {
  const fingerprints = (
    process.env.ASSETLINKS_FINGERPRINTS ||
    "D5:88:46:5A:39:03:7D:49:A8:9A:CC:36:8D:65:1A:CB:81:00:62:39:65:F2:7D:1C:71:DF:05:28:98:A6:BD:54,FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C,A5:E8:3E:11:D1:D6:12:AE:55:E4:14:FC:64:B6:42:31:2C:51:B4:9E:A3:77:CA:9C:EE:93:46:92:19:B0:FD:D0"
  ).split(",");

  res.json(
    fingerprints.map((fp) => ({
      relation: [
        "delegate_permission/common.handle_all_urls",
        "delegate_permission/common.get_login_creds",
      ],
      target: {
        namespace: "android_app",
        package_name: "com.valora.valoramobile",
        sha256_cert_fingerprints: [fp.trim()],
      },
    })),
  );
});

// ===============================
// DATABASE MIDDLEWARE
// ===============================

app.use(async (req, res, next) => {
  try {
    await connectDatabase();
    next();
  } catch (error) {
    console.error("Database connection failed:", error);

    return res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
});

// ===============================
// API ROUTES
// ===============================

app.use("/api/auth", authRoutes);
app.use("/api/tenants", tenantRoutes);
app.use("/api/users", userRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/transactions", transactionRoutes);
app.use("/api/prices", priceRoutes);
app.use("/api/internal-wallet", internalWalletRoutes);
app.use("/api/earn", earnRoutes);
app.use("/api/topups", topupRoutes);
app.use("/api/swap", swapRoutes);
app.use("/api/installments", installmentRoutes);
app.use("/api/admin", clockRoutes);
app.use("/api/loans", loanRoutes);

// ===============================
// MIDTRANS REDIRECT
// ===============================

app.get("/payment/success", (req, res) => {
  res.redirect("valoramobile://payment/success");
});

app.get("/payment/pending", (req, res) => {
  res.redirect("valoramobile://payment/pending");
});

app.get("/payment/error", (req, res) => {
  res.redirect("valoramobile://payment/error");
});

// ===============================
// EXPORT
// ===============================

if (require.main === module) {
  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server Valora berjalan di http://localhost:${PORT}`);

    try {
      await sequelize.authenticate();
      console.log("PostgreSQL connected.");

      // await sequelize.sync({ alter: true });
      // console.log("Database tables synced.");

      await sequelize.sync();
      console.log("Database tables synced.");
    } catch (error) {
      console.error("Database connection failed:", error);
    }
  });
}

module.exports = app;
