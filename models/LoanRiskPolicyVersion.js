const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Versi policy risk (brief 19/21): APR matrix, LTV matrix, haircut, fee,
 * effective_at, approver. Posisi existing menyimpan APR snapshot sendiri;
 * perubahan threshold berlaku lewat versi baru (impact simulation di admin).
 */
const LoanRiskPolicyVersion = sequelize.define(
  "LoanRiskPolicyVersion",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    version: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    aprBps: { type: DataTypes.JSONB, allowNull: false, field: "apr_bps" },
    risk: { type: DataTypes.JSONB, allowNull: false },
    rules: { type: DataTypes.JSONB, allowNull: false },
    effectiveAt: { type: DataTypes.DATE, allowNull: false, field: "effective_at" },
    approvedBy: { type: DataTypes.STRING, allowNull: true, field: "approved_by" },
    updatedBy: { type: DataTypes.STRING, allowNull: true, field: "updated_by" },
    note: { type: DataTypes.STRING, allowNull: true },
    status: { type: DataTypes.ENUM("DRAFT", "APPROVED", "RETIRED"), allowNull: false, defaultValue: "APPROVED" },
  },
  {
    tableName: "loan_risk_policy_versions",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [{ fields: ["effective_at"] }, { fields: ["status"] }],
  },
);

module.exports = LoanRiskPolicyVersion;
