const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/* Snapshot pool pada event finansial (opening, liquidation, inject). */
const LoanPoolSnapshot = sequelize.define(
  "LoanPoolSnapshot",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    eligibleCapitalIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "eligible_capital_idr" },
    protectedReserveIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "protected_reserve_idr" },
    onloanPrincipalIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "onloan_principal_idr" },
    confirmedCashIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "confirmed_cash_idr" },
    reason: { type: DataTypes.STRING(64), allowNull: false },
    positionId: { type: DataTypes.UUID, allowNull: true, field: "position_id" },
    asOf: { type: DataTypes.DATE, allowNull: false, field: "as_of" },
  },
  {
    tableName: "loan_pool_snapshots",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
  },
);

module.exports = LoanPoolSnapshot;
