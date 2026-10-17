const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Posting bunga per segmen (brief 06). FIRST_ANNIVERSARY di-post sekali
 * berbasis PO snapshot; PRORATA per segmen cycle >= 2. Idempotent via
 * (position_id, cycle_index, period_start).
 */
const LoanInterestEvent = sequelize.define(
  "LoanInterestEvent",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    positionId: { type: DataTypes.UUID, allowNull: false, field: "position_id" },
    kind: { type: DataTypes.ENUM("FIRST_ANNIVERSARY", "PRORATA", "PDP"), allowNull: false },
    cycleIndex: { type: DataTypes.SMALLINT, allowNull: false, field: "cycle_index" },
    cycleAnchorAt: { type: DataTypes.DATE, allowNull: false, field: "cycle_anchor_at" },
    periodStartAt: { type: DataTypes.DATE, allowNull: false, field: "period_start_at" },
    periodEndAt: { type: DataTypes.DATE, allowNull: false, field: "period_end_at" },
    principalBasisIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "principal_basis_idr" },
    aprBps: { type: DataTypes.INTEGER, allowNull: false, field: "apr_bps" },
    accrualIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "accrual_idr" },
    paidIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "paid_idr" },
    idempotencyKey: { type: DataTypes.STRING, allowNull: false, unique: true, field: "idempotency_key" },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loan_interest_events",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
    indexes: [{ fields: ["position_id"] }, { fields: ["position_id", "cycle_index"] }],
  },
);

module.exports = LoanInterestEvent;
