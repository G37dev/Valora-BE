const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Checkpoint kecil untuk cron ticks serverless — mis. last processed
 * block per contract untuk chain-events polling. Key/value sederhana;
 * dibuat via sequelize.sync() seperti tabel lain.
 */
const CronCheckpoint = sequelize.define(
  "CronCheckpoint",
  {
    key: {
      type: DataTypes.STRING,
      primaryKey: true,
    },
    value: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
  },
  {
    tableName: "cron_checkpoints",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
);

module.exports = CronCheckpoint;
