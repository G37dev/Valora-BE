const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Logical lock IDR di PG untuk posisi VVLR (brief 15) & reservation lock
 * drawdown. Bukan physical freeze — backend enforce di semua debit internal.
 */
const LoanPgAllocation = sequelize.define(
  "LoanPgAllocation",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    positionId: { type: DataTypes.UUID, allowNull: false, field: "position_id" },
    sourceAccount: { type: DataTypes.STRING(64), allowNull: false, defaultValue: "LOAN_POOL", field: "source_account" },
    asset: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "IDR" },
    amountLockedIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "amount_locked_idr" },
    kind: { type: DataTypes.ENUM("DISBURSEMENT_RESERVATION", "VVLR_RESTRICTED", "SETTLEMENT_ADVANCE"), allowNull: false },
    releaseStatus: { type: DataTypes.ENUM("LOCKED", "RELEASED", "CONSUMED"), allowNull: false, defaultValue: "LOCKED", field: "release_status" },
    lastReconciledAt: { type: DataTypes.DATE, allowNull: true, field: "last_reconciled_at" },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loan_pg_allocations",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [{ fields: ["position_id"] }, { fields: ["release_status"] }],
  },
);

module.exports = LoanPgAllocation;
