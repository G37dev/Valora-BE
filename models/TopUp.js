const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const TopUp = sequelize.define(
  "TopUp",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    // Customer/core yang melakukan top up
    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "core_id",
    },

    // Wallet internal tujuan
    internalWalletId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "internal_wallet_id",
    },

    // Provider pembayaran
    provider: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "MIDTRANS",
    },

    // ID pembayaran dari provider
    providerPaymentId: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "provider_payment_id",
    },

    // Reference yang kita generate sendiri
    // Harus UNIQUE agar callback tidak bisa membuat transaksi ganda
    refNo: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      field: "ref_no",
    },

    // Nominal top up
    amountIdr: {
      type: DataTypes.DECIMAL(20, 2),
      allowNull: false,
      field: "amount_idr",
    },

    currency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: "IDR",
    },

    status: {
      type: DataTypes.ENUM(
        "PENDING",
        "PROCESSING",
        "SUCCESS",
        "FAILED",
        "EXPIRED",
      ),
      allowNull: false,
      defaultValue: "PENDING",
    },

    snapToken: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "snap_token",
    },

    paymentMethod: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "payment_method",
    },

    paidAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "paid_at",
    },

    expiredAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "expired_at",
    },

    failureReason: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "failure_reason",
    },

    // Response dari iPay88 untuk audit/debug
    rawResponse: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: "raw_response",
    },

    // Response callback terakhir
    callbackPayload: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: "callback_payload",
    },
  },
  {
    tableName: "topups",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",

    indexes: [
      {
        unique: true,
        fields: ["ref_no"],
      },
      {
        fields: ["core_id"],
      },
      {
        fields: ["internal_wallet_id"],
      },
      {
        fields: ["provider", "provider_payment_id"],
      },
      {
        fields: ["status"],
      },
    ],
  },
);

module.exports = TopUp;
