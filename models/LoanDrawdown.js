const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/* Setiap disbursement (initial + additional) — fee_id unik per draw (brief 05). */
const LoanDrawdown = sequelize.define(
  "LoanDrawdown",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    positionId: { type: DataTypes.UUID, allowNull: false, field: "position_id" },
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    kind: { type: DataTypes.ENUM("INITIAL", "ADDITIONAL"), allowNull: false },
    grossIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "gross_idr" },
    protocolFeeIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "protocol_fee_idr" },
    paidIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "paid_idr" },
    feeEventId: { type: DataTypes.UUID, allowNull: true, field: "fee_event_id" },
    pgReference: { type: DataTypes.STRING, allowNull: true, field: "pg_reference" },
    status: { type: DataTypes.ENUM("PENDING", "CONFIRMED", "FAILED", "REVERSED"), allowNull: false, defaultValue: "PENDING" },
    priceSnapshotIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "price_snapshot_idr" },
    eligiblePriceIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "eligible_price_idr" },
    configVersion: { type: DataTypes.STRING(64), allowNull: true, field: "config_version" },
    idempotencyKey: { type: DataTypes.STRING, allowNull: false, unique: true, field: "idempotency_key" },
    effectiveAt: { type: DataTypes.DATE, allowNull: false, field: "effective_at" },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loan_drawdowns",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [{ fields: ["position_id"] }, { fields: ["core_id"] }],
  },
);

module.exports = LoanDrawdown;
