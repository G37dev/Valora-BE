const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const SwapRefund = sequelize.define(
  "SwapRefund",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    swapId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "swap_id",
    },

    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "core_id",
    },

    asset: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    amount: {
      type: DataTypes.NUMERIC(36, 18),
      allowNull: false,
    },

    refundType: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "refund_type",
    },

    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "PENDING",
    },

    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    processedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "processed_at",
    },

    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "completed_at",
    },
  },
  {
    tableName: "swap_refunds",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",

    indexes: [
      {
        fields: ["swap_id"],
      },
      {
        fields: ["core_id"],
      },
      {
        unique: true,
        fields: ["swap_id", "refund_type"],
      },
    ],
  },
);

module.exports = SwapRefund;
