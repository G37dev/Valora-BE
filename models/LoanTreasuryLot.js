const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Inventory lot Treasury hasil liquidation (brief 16). Lot debt-recovery
 * dipisah dari lot compensation. uPNL & BEP dihitung dari lot yang HELD.
 */
const LoanTreasuryLot = sequelize.define(
  "LoanTreasuryLot",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    liquidationId: { type: DataTypes.UUID, allowNull: false, field: "liquidation_id" },
    sourcePositionId: { type: DataTypes.UUID, allowNull: false, field: "source_position_id" },
    asset: { type: DataTypes.STRING(16), allowNull: false },
    lotType: { type: DataTypes.ENUM("DEBT_RECOVERY", "COMPENSATION"), allowNull: false, field: "lot_type" },
    qtyOriginal: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "qty_original" },
    qtyRemaining: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "qty_remaining" },
    entryPriceIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "entry_price_idr" },
    advanceIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "advance_idr" },
    advanceRemainingIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "advance_remaining_idr" },
    realizedProceedsIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "realized_proceeds_idr" },
    realizedCostIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "realized_cost_idr" },
    realizedPnlIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "realized_pnl_idr" },
    status: { type: DataTypes.ENUM("HELD", "PARTIALLY_SOLD", "SOLD"), allowNull: false, defaultValue: "HELD" },
    receivedAt: { type: DataTypes.DATE, allowNull: false, field: "received_at" },
    txHash: { type: DataTypes.STRING(80), allowNull: true, field: "tx_hash" },
    sales: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loan_treasury_lots",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [{ fields: ["asset", "status"] }, { fields: ["source_position_id"] }],
  },
);

module.exports = LoanTreasuryLot;
