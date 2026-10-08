const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Domain event + revenue event registry (brief 16.3 & 17).
 *
 * Event dengan rev_id != NULL adalah revenue event:
 * revenue_event_id unik per occurrence, rev_id adalah klasifikasi sumber.
 * Reversal tidak menghapus history; pakai reversal_of_event_id.
 */
const InstallmentEvent = sequelize.define(
  "InstallmentEvent",
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

    eventType: {
      type: DataTypes.STRING(64),
      allowNull: false,
      field: "event_type",
    },

    // Waktu efektif finansial (bukan waktu cron)
    effectiveAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "effective_at",
    },

    // ---------- Revenue fields (nullable untuk non-revenue event) ----------
    revId: {
      type: DataTypes.STRING(32),
      allowNull: true,
      field: "rev_id",
    },

    revenueEventId: {
      type: DataTypes.UUID,
      allowNull: true,
      unique: true,
      field: "revenue_event_id",
    },

    amountIdr: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "amount_idr",
    },

    rateBps: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "rate_bps",
    },

    calculationBaseIdr: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "calculation_base_idr",
    },

    sourceTransactionId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "source_transaction_id",
    },

    destinationAccount: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "destination_account",
    },

    status: {
      type: DataTypes.ENUM("RECOGNIZED", "PENDING", "REVERSED"),
      allowNull: true,
    },

    reversalOfEventId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "reversal_of_event_id",
    },

    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    tableName: "installment_events",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
    indexes: [
      { fields: ["plan_id"] },
      { fields: ["core_id"] },
      { fields: ["event_type"] },
      { fields: ["rev_id"] },
      { fields: ["effective_at"] },
    ],
  },
);

module.exports = InstallmentEvent;
