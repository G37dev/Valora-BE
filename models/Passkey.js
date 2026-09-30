const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Passkey = sequelize.define(
  "Passkey",
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
    credentialId: {
      // Credential ID dari WebAuthn bisa cukup panjang, gunakan TEXT atau STRING(500)
      type: DataTypes.TEXT,
      allowNull: false,
      field: "credential_id",
    },
    publicKey: {
      // Menyimpan Public Key dari perangkat pengguna
      type: DataTypes.TEXT,
      allowNull: false,
      field: "public_key",
    },
    counter: {
      // Wajib ada di standar FIDO2/WebAuthn untuk mencegah serangan Replay (cloning)
      type: DataTypes.INTEGER,
      defaultValue: 0,
      allowNull: false,
    },
    deviceType: {
      // Opsional: Untuk menandai apakah ini dari iPhone, Mac, dll (SingleDevice / MultiDevice)
      type: DataTypes.STRING,
      allowNull: true,
      field: "device_type",
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: "ACTIVE",
    },
  },
  {
    tableName: "passkeys", // Nama tabel di database
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
);

module.exports = Passkey;
