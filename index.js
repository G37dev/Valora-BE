require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { sequelize, UserPushToken, BusinessClock } = require("./models");

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
const app = express();
const PORT = process.env.PORT || 5000;
app.use(cors());
app.use(express.json());

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
