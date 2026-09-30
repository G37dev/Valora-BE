const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const InternalTransaction = sequelize.define(
  "InternalTransaction",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    internalWalletId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "internal_wallet_id",
    },

    /**
     * Satu TopUp hanya boleh menghasilkan
     * satu InternalTransaction.
     *
     * NULL tetap diperbolehkan untuk transaksi
     * lain seperti adjustment/withdraw yang
     * tidak berasal dari TopUp.
     */
    topUpId: {
      type: DataTypes.UUID,
      allowNull: true,
      unique: true,
      field: "topup_id",
    },

    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "core_id",
    },

    type: {
      type: DataTypes.ENUM("CREDIT", "DEBIT"),
      allowNull: false,
    },

    asset: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: "IDR",
    },

    amount: {
      type: DataTypes.DECIMAL(20, 2),
      allowNull: false,
    },

    balanceBefore: {
      type: DataTypes.DECIMAL(20, 2),
      allowNull: false,
      field: "balance_before",
    },

    balanceAfter: {
      type: DataTypes.DECIMAL(20, 2),
      allowNull: false,
      field: "balance_after",
    },

    /**
     * Reference bisnis yang immutable.
     *
     * Contoh:
     * TOPUP-550e8400-e29b-41d4-a716-446655440000
     */
    reference: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },

    status: {
      type: DataTypes.ENUM("PENDING", "SUCCESS", "FAILED", "REVERSED"),
      allowNull: false,
      defaultValue: "SUCCESS",
    },

    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "internal_transactions",

    timestamps: true,

    createdAt: "created_at",
    updatedAt: "updated_at",

    indexes: [
      {
        fields: ["internal_wallet_id"],
      },

      {
        fields: ["core_id"],
      },

      {
        fields: ["topup_id"],
      },

      {
        fields: ["type"],
      },

      {
        fields: ["status"],
      },
    ],
  },
);

module.exports = InternalTransaction;
