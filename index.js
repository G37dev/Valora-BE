require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { sequelize } = require("./models");

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

const { startBlockchainListener } = require("./services/blockchainListener");

const { startEarnListener } = require("./services/earnListener");

require("./services/priceScheduler");
require("./workers/earn.worker");
require("./workers/earn-claim.worker");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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

// ===============================
// MIDTRANS REDIRECT
// ===============================

app.get("/payment/success", (req, res) => {
  console.log("[Midtrans Redirect] SUCCESS");

  res.redirect("valoramobile://payment/success");
});

app.get("/payment/pending", (req, res) => {
  console.log("[Midtrans Redirect] PENDING");

  res.redirect("valoramobile://payment/pending");
});

app.get("/payment/error", (req, res) => {
  console.log("[Midtrans Redirect] ERROR");

  res.redirect("valoramobile://payment/error");
});

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
// START SERVER
// ===============================

sequelize
  .sync({ alter: true })
  .then(() => {
    console.log(
      "Database PostgreSQL terhubung dan tersinkronisasi dengan Sequelize.",
    );

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server Valora berjalan di port ${PORT}`);

      startBlockchainListener();
      startEarnListener();
    });
  })
  .catch((err) => {
    console.error("Gagal menghubungkan ke database:", err);
  });
