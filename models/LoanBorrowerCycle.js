const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Borrower Cycle Snapshot (brief 04): eligible lending capital pada
 * pembukaan loan pertama siklus; dipakai posisi ke-2; reset hanya ketika
 * SEMUA posisi user closed.
 */
const LoanBorrowerCycle = sequelize.define(
  "LoanBorrowerCycle",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    poolSnapshotId: { type: DataTypes.UUID, allowNull: false, field: "pool_snapshot_id" },
    eligibleCapitalAtFirstLoanIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "eligible_capital_at_first_loan_idr" },
    borrowerCapIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "borrower_cap_idr" },
    cycleStartedAt: { type: DataTypes.DATE, allowNull: false, field: "cycle_started_at" },
    cycleClosedAt: { type: DataTypes.DATE, allowNull: true, field: "cycle_closed_at" },
    status: { type: DataTypes.ENUM("OPEN", "CLOSED"), allowNull: false, defaultValue: "OPEN" },
  },
  {
    tableName: "loan_borrower_cycles",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [{ fields: ["core_id", "status"] }],
  },
);

module.exports = LoanBorrowerCycle;
