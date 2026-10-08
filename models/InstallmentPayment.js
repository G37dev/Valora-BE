const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Satu pembayaran user ke plan + hasil alokasi waterfall-nya.
 * amount_idr = yang benar-benar didebit dari internal wallet.
 */
const InstallmentPayment = sequelize.define(
  "InstallmentPayment",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    planId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "plan_id",
    },

    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "core_id",
    },

    kind: {
      type: DataTypes.ENUM("INITIAL", "PAYMENT", "SETTLEMENT"),
      allowNull: false,
    },

    // Nominal yang diminta user
    requestedAmountIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: "requested_amount_idr",
    },

    // Nominal yang benar-benar didebit (<= requested; kelebihan tidak didebit)
    amountIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: "amount_idr",
    },

    effectiveAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "effective_at",
    },

    // { carrying, latePenalty, pastDuePenalty, restructureFee, principal }
    allocation: {
      type: DataTypes.JSONB,
      allowNull: false,
    },

    // Status plan sebelum dan sesudah
    statusBefore: {
      type: DataTypes.STRING(32),
      allowNull: false,
      field: "status_before",
    },

    statusAfter: {
      type: DataTypes.STRING(32),
      allowNull: false,
      field: "status_after",
    },

    internalTransactionId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "internal_transaction_id",
    },

    reference: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },

    idempotencyKey: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      field: "idempotency_key",
    },

    calculationSnapshot: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: "calculation_snapshot",
    },
  },
  {
    tableName: "installment_payments",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [
      { fields: ["plan_id"] },
      { fields: ["core_id"] },
      { fields: ["effective_at"] },
    ],
  },
);

module.exports = InstallmentPayment;
