const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/* Jejak evaluasi risk engine per posisi (asof, price, HF, LTV, status). */
const LoanRiskSnapshot = sequelize.define(
  "LoanRiskSnapshot",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    positionId: { type: DataTypes.UUID, allowNull: false, field: "position_id" },
    asOf: { type: DataTypes.DATE, allowNull: false, field: "as_of" },
    priceSource: { type: DataTypes.STRING(32), allowNull: true, field: "price_source" },
    validatedPriceIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "validated_price_idr" },
    priceObservedAt: { type: DataTypes.DATE, allowNull: true, field: "price_observed_at" },
    priceStatus: { type: DataTypes.STRING(32), allowNull: false, field: "price_status" },
    totalDebtIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "total_debt_idr" },
    collateralValueIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "collateral_value_idr" },
    ltvBps: { type: DataTypes.DECIMAL(12, 2), allowNull: true, field: "ltv_bps" },
    hf: { type: DataTypes.DECIMAL(12, 4), allowNull: true },
    statusBefore: { type: DataTypes.STRING(32), allowNull: false, field: "status_before" },
    statusAfter: { type: DataTypes.STRING(32), allowNull: false, field: "status_after" },
    configVersion: { type: DataTypes.STRING(64), allowNull: true, field: "config_version" },
    note: { type: DataTypes.STRING, allowNull: true },
  },
  {
    tableName: "loan_risk_snapshots",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
    indexes: [{ fields: ["position_id"] }, { fields: ["as_of"] }],
  },
);

module.exports = LoanRiskSnapshot;
