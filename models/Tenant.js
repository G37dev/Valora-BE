const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Tenant = sequelize.define(
  "Tenant",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    code: { type: DataTypes.STRING, unique: true, allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.STRING, defaultValue: "ACTIVE" },

    apiKey: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: true,
      field: "api_key",
    },

    publicKey: { type: DataTypes.TEXT, field: "public_key" },
    config: { type: DataTypes.JSON, defaultValue: {} },
  },
  {
    tableName: "tenants",
    timestamps: true,
    createdAt: "created_at",
    updated_at: "updated_at",
  },
);

module.exports = Tenant;
