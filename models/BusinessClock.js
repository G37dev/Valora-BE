const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Business Clock — satu sumber waktu untuk financial engines.
 * (VIVALORA Business Clock & Time Simulation Developer Guide v1.0, Step 2)
 *
 * Satu row singleton per environment (id=1). Production tidak boleh
 * SIMULATED — enforcement ada di services/businessClock.js.
 */
const BusinessClock = sequelize.define(
  "BusinessClock",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      defaultValue: 1,
    },
    environment: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "development",
    },
    clockMode: {
      type: DataTypes.STRING, // 'REAL' | 'SIMULATED'
      allowNull: false,
      defaultValue: "REAL",
      field: "clock_mode",
    },
    simulatedNow: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "simulated_now",
    },
    businessTimezone: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: "Asia/Jakarta",
      field: "business_timezone",
    },
    updatedBy: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "updated_by",
    },
  },
  {
    tableName: "business_clock",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
);

module.exports = BusinessClock;
