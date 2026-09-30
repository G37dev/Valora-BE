const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const Customer = require("./Customer");

const Wallet = sequelize.define(
  "Wallet",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    core_id: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: Customer,
        key: "core_id",
      },
    },
    type: {
      type: DataTypes.STRING, // AA, EOA
      defaultValue: "AA",
    },
    address: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: true, // Bisa null sebelum di-generate
    },
    sid: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    chain: {
      type: DataTypes.STRING,
      defaultValue: "POLYGON", // Contoh default chain
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: "ACTIVE", // PENDING, ACTIVE, SUSPENDED
    },
  },
  {
    tableName: "wallets",
    timestamps: true,
  },
);

// Definisikan Relasi
Customer.hasOne(Wallet, { foreignKey: "core_id" });
Wallet.belongsTo(Customer, { foreignKey: "core_id" });

module.exports = Wallet;
