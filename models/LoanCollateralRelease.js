const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Collateral release (Double-Limit / full settlement). Gas dibayar user
 * dalam IDR tanpa markup; tx gagal -> FAILED + retry tanpa double gas.
 */
const LoanCollateralRelease = sequelize.define(
  "LoanCollateralRelease",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    positionId: { type: DataTypes.UUID, allowNull: false, field: "position_id" },
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    repaymentId: { type: DataTypes.UUID, allowNull: true, field: "repayment_id" },
    kind: { type: DataTypes.ENUM("PARTIAL", "FULL", "LIQUIDATION_REFUND"), allowNull: false },
    tokenQty: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "token_qty" },
    tokenQtyRaw: { type: DataTypes.STRING(80), allowNull: true, field: "token_qty_raw" },
    valueIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "value_idr" },
    priceIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "price_idr" },
    qRiskLimit: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "q_risk_limit" },
    qPaymentLimit: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "q_payment_limit" },
    ltvAfterBps: { type: DataTypes.DECIMAL(12, 2), allowNull: true, field: "ltv_after_bps" },
    gasQuoteIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "gas_quote_idr" },
    gasActualIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "gas_actual_idr" },
    gasCharged: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "gas_charged" },
    userApproved: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "user_approved" },
    recipient: { type: DataTypes.STRING(64), allowNull: true },
    nonce: { type: DataTypes.INTEGER, allowNull: true },
    txHash: { type: DataTypes.STRING(80), allowNull: true, field: "tx_hash" },
    state: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "QUOTED" },
    attempts: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0 },
    lastError: { type: DataTypes.TEXT, allowNull: true, field: "last_error" },
    effectiveAt: { type: DataTypes.DATE, allowNull: false, field: "effective_at" },
    confirmedAt: { type: DataTypes.DATE, allowNull: true, field: "confirmed_at" },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loan_collateral_releases",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [{ fields: ["position_id"] }, { fields: ["state"] }],
  },
);

module.exports = LoanCollateralRelease;
