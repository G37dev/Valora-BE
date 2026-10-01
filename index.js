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
    databasePromise = sequelize.authenticate();
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
    } catch (error) {
      console.error("Database connection failed:", error);
    }
  });
}

module.exports = app;
