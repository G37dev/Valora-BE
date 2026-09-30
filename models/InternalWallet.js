const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const InternalWallet = sequelize.define(
  "InternalWallet",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      field: "core_id",
    },

    balanceIdr: {
      type: DataTypes.DECIMAL(20, 2),
      allowNull: false,
      defaultValue: 0,
      field: "balance_idr",
    },
  },
  {
    tableName: "internal_wallets",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
);

module.exports = InternalWallet;
