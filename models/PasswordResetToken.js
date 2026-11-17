const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/**
 * Token OTP untuk forgot-password — multi-channel (wa | email).
 * Kode disimpan sebagai SHA-256 hash — plaintext tidak pernah disimpan.
 * Satu baris aktif per (identifier, channel) — kirim ulang
 * menonaktifkan yang lama. resetUsedAt menandai resetTicket
 * sudah dipakai (single-use reset).
 */
const PasswordResetToken = sequelize.define(
  "PasswordResetToken",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    identifier: {
      // email (channel 'email') atau nomor 62xxx (channel 'wa')
      type: DataTypes.STRING,
      allowNull: false,
    },
    channel: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "core_id",
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
      // diisi saat kode terverifikasi (ticket diterbitkan)
      type: DataTypes.DATE,
      allowNull: true,
      field: "consumed_at",
    },
    resetUsedAt: {
      // diisi saat resetTicket dipakai — reset hanya bisa sekali
      type: DataTypes.DATE,
      allowNull: true,
      field: "reset_used_at",
    },
  },
  {
    tableName: "password_reset_tokens",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
);

module.exports = PasswordResetToken;
