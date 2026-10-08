const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Jadwal cicilan Standard. Dibuat saat contract activation.
 * sequence 1 = installment pertama (dibayar saat activation).
 */
const InstallmentSchedule = sequelize.define(
  "InstallmentSchedule",
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

    sequence: {
      type: DataTypes.SMALLINT,
      allowNull: false,
    },

    dueAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "due_at",
    },

    amountIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: "amount_idr",
    },

    paidIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "paid_idr",
    },

    // Total late penalty yang pernah di-charge untuk item ini (cap 2% x amount)
    latePenaltyChargedIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "late_penalty_charged_idr",
    },

    // Sampai kapan penalty sudah dihitung (effective time, bukan cron time)
    penaltyAccruedThroughAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "penalty_accrued_through_at",
    },

    status: {
      type: DataTypes.ENUM("PENDING", "PARTIAL", "PAID"),
      allowNull: false,
      defaultValue: "PENDING",
    },

    paidAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "paid_at",
    },
  },
  {
    tableName: "installment_schedules",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [
      { unique: true, fields: ["plan_id", "sequence"] },
      { fields: ["plan_id", "status"] },
      { fields: ["due_at"] },
    ],
  },
);

module.exports = InstallmentSchedule;
