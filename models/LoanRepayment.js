const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/* Pembayaran IDR + alokasi waterfall PDP / interest / principal (brief 07). */
const LoanRepayment = sequelize.define(
  "LoanRepayment",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    positionId: { type: DataTypes.UUID, allowNull: false, field: "position_id" },
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    kind: { type: DataTypes.ENUM("PARTIAL", "FULL_SETTLEMENT"), allowNull: false },
    requestedIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "requested_idr" },
    debitedIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "debited_idr" },
    pdpIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "pdp_idr" },
    interestIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "interest_idr" },
    principalIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "principal_idr" },
    excessIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0, field: "excess_idr" },
    principalBeforeIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "principal_before_idr" },
    principalAfterIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "principal_after_idr" },
    releaseId: { type: DataTypes.UUID, allowNull: true, field: "release_id" },
    pgReference: { type: DataTypes.STRING, allowNull: true, field: "pg_reference" },
    idempotencyKey: { type: DataTypes.STRING, allowNull: false, unique: true, field: "idempotency_key" },
    effectiveAt: { type: DataTypes.DATE, allowNull: false, field: "effective_at" },
    statusBefore: { type: DataTypes.STRING(32), allowNull: true, field: "status_before" },
    statusAfter: { type: DataTypes.STRING(32), allowNull: true, field: "status_after" },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loan_repayments",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
    indexes: [{ fields: ["position_id"] }, { fields: ["core_id"] }],
  },
);

module.exports = LoanRepayment;
