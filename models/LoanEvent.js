const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Domain event + revenue registry (brief 18). rev_id = klasifikasi sumber,
 * revenue_event_id unik per occurrence; reversal via reversal_of_event_id.
 */
const LoanEvent = sequelize.define(
  "LoanEvent",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    positionId: { type: DataTypes.UUID, allowNull: true, field: "position_id" },
    coreId: { type: DataTypes.STRING, allowNull: true, field: "core_id" },
    eventType: { type: DataTypes.STRING(64), allowNull: false, field: "event_type" },
    effectiveAt: { type: DataTypes.DATE, allowNull: false, field: "effective_at" },
    revId: { type: DataTypes.STRING(32), allowNull: true, field: "rev_id" },
    revenueEventId: { type: DataTypes.UUID, allowNull: true, unique: true, field: "revenue_event_id" },
    amountIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "amount_idr" },
    amountQty: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "amount_qty" },
    asset: { type: DataTypes.STRING(16), allowNull: true },
    rateBps: { type: DataTypes.INTEGER, allowNull: true, field: "rate_bps" },
    calculationBaseIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "calculation_base_idr" },
    sourceTxId: { type: DataTypes.STRING(128), allowNull: true, field: "source_tx_id" },
    status: { type: DataTypes.ENUM("RECOGNIZED", "PENDING", "REVERSED"), allowNull: true },
    reversalOfEventId: { type: DataTypes.UUID, allowNull: true, field: "reversal_of_event_id" },
    correlationId: { type: DataTypes.STRING(128), allowNull: true, field: "correlation_id" },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loan_events",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
    indexes: [
      { fields: ["position_id"] },
      { fields: ["core_id"] },
      { fields: ["event_type"] },
      { fields: ["rev_id"] },
      { fields: ["effective_at"] },
    ],
  },
);

module.exports = LoanEvent;
