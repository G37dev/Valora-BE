const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const AuthIdentity = sequelize.define(
  "AuthIdentity",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "core_id",
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    provider: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    providerUserId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "provider_user_id",
    },
    passwordHash: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "password_hash",
    },
    // ---- TAMBAHAN FIELD BARU UNTUK TOTP ----
    secretKey: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "secret_key",
      comment: "Menyimpan Secret Key untuk Google Authenticator",
    },
    // ---------------------------------------
    status: {
      type: DataTypes.STRING,
      defaultValue: "ACTIVE",
    },
  },
  {
    tableName: "auth_identities",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
  },
);

module.exports = AuthIdentity;
