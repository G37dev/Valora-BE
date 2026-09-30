const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Price = sequelize.define(
  "Price",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    asset: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
    },
    priceIdr: {
      type: DataTypes.DECIMAL(20, 2),
      allowNull: false,
      field: "price_idr",
    },
    source: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    tableName: "prices",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
);

module.exports = Price;
