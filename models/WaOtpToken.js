const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/**
 * Token OTP sekali-pakai yang dikirim via WhatsApp.
 * Kode disimpan sebagai SHA-256 hash — plaintext tidak pernah disimpan.
 * Satu baris aktif per (phone, purpose) — kirim ulang menonaktifkan yang lama.
 */
const WaOtpToken = sequelize.define(
  "WaOtpToken",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: false,
    },
    coreId: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "core_id",
    },
    purpose: {
      // register | login | transaction | verify-phone
      type: DataTypes.STRING(30),
      allowNull: false,
    },
    codeHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: "code_hash",
    },
    attempts: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "expires_at",
    },
    consumedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "consumed_at",
    },
  },
  {
    tableName: "wa_otp_tokens",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
);

module.exports = WaOtpToken;
