const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/* Auto Liquidation record + signed settlement instruction (brief 14, D.3). */
const LoanLiquidation = sequelize.define(
  "LoanLiquidation",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    positionId: { type: DataTypes.UUID, allowNull: false, field: "position_id" },
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    triggerType: { type: DataTypes.STRING(32), allowNull: false, field: "trigger_type" },
    observationStartedAt: { type: DataTypes.DATE, allowNull: true, field: "observation_started_at" },
    authorizedAt: { type: DataTypes.DATE, allowNull: false, field: "authorized_at" },
    executedAt: { type: DataTypes.DATE, allowNull: true, field: "executed_at" },
    referencePriceIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "reference_price_idr" },
    priceSource: { type: DataTypes.STRING(32), allowNull: true, field: "price_source" },
    priceObservedAt: { type: DataTypes.DATE, allowNull: true, field: "price_observed_at" },
    haircutBps: { type: DataTypes.INTEGER, allowNull: false, field: "haircut_bps" },
    conservativePriceIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "conservative_price_idr" },
    principalIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "principal_idr" },
    interestIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "interest_idr" },
    pdpIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "pdp_idr" },
    totalDebtDueIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "total_debt_due_idr" },
    lockedQty: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "locked_qty" },
    debtAllocQty: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "debt_alloc_qty" },
    compensationQty: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "compensation_qty" },
    refundQty: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "refund_qty" },
    treasuryQty: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "treasury_qty" },
    deficitIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "deficit_idr" },
    advanceIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "advance_idr" },
    userRecipient: { type: DataTypes.STRING(64), allowNull: true, field: "user_recipient" },
    treasuryRecipient: { type: DataTypes.STRING(64), allowNull: true, field: "treasury_recipient" },
    nonce: { type: DataTypes.INTEGER, allowNull: false },
    instruction: { type: DataTypes.JSONB, allowNull: true },
    signature: { type: DataTypes.TEXT, allowNull: true },
    txHash: { type: DataTypes.STRING(80), allowNull: true, field: "tx_hash" },
    state: { type: DataTypes.STRING(24), allowNull: false, defaultValue: "AUTHORIZED" },
    configVersion: { type: DataTypes.STRING(64), allowNull: true, field: "config_version" },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loan_liquidations",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [{ fields: ["position_id"] }, { fields: ["state"] }],
  },
);

module.exports = LoanLiquidation;
