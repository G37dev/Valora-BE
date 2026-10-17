const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Lending pool singleton (brief 04, 16): eligible lending capital +
 * protected reserve (ring-fenced, TIDAK dihitung sebagai lending capital)
 * + confirmed cash. Nilai diubah admin/treasury, bukan hardcode.
 */
const LoanPool = sequelize.define(
  "LoanPool",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, defaultValue: 1 },
    eligibleLendingCapitalIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "eligible_lending_capital_idr" },
    protectedReserveIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "protected_reserve_idr" },
    protectedReserveTargetIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "protected_reserve_target_idr" },
    confirmedCashIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "confirmed_cash_idr" },
    onloanPrincipalIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "onloan_principal_idr" },
    restrictedAllocationIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "restricted_allocation_idr" },
    outstandingAdvanceIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "outstanding_advance_idr" },
    lendingPaused: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "lending_paused" },
    pauseReason: { type: DataTypes.STRING, allowNull: true, field: "pause_reason" },
    lastReconciledAt: { type: DataTypes.DATE, allowNull: true, field: "last_reconciled_at" },
    updatedBy: { type: DataTypes.STRING, allowNull: true, field: "updated_by" },
  },
  {
    tableName: "loan_pool",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
);

module.exports = LoanPool;
