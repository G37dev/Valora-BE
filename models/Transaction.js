const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Transaction = sequelize.define("Transaction", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  core_id: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  tx_hash: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false,
  },
  type: {
    type: DataTypes.STRING, // Contoh: "DEPOSIT"
  },
  asset: {
    type: DataTypes.STRING, // Contoh: "USDT", "ETH"
  },
  amount: {
    type: DataTypes.STRING,
  },
  tx_block_number: {
    type: DataTypes.BIGINT, // Blok saat transaksi pertama kali masuk
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: "PENDING", // PENDING, SUCCESS, FAILED
  },
});

module.exports = Transaction;
