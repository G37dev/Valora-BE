const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Observasi harga per aset (brief 10): dipakai 15-minute TWAP untuk
 * Borrowing Eligible Price + audit price snapshot (provider, observed_at,
 * fetched_at, freshness).
 */
const LoanPriceTick = sequelize.define(
  "LoanPriceTick",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    asset: { type: DataTypes.STRING(16), allowNull: false },
    priceIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: false, field: "price_idr" },
    source: { type: DataTypes.STRING(32), allowNull: false },
    observedAt: { type: DataTypes.DATE, allowNull: false, field: "observed_at" },
    fetchedAt: { type: DataTypes.DATE, allowNull: false, field: "fetched_at" },
    isOverride: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "is_override" },
  },
  {
    tableName: "loan_price_ticks",
    timestamps: false,
    indexes: [{ fields: ["asset", "observed_at"] }],
  },
);

module.exports = LoanPriceTick;
