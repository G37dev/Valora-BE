const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

// Satu user bisa punya banyak device token (multi-device).
// push_token unique — token yang sama di-upsert, bukan diduplikasi.
const UserPushToken = sequelize.define(
  "UserPushToken",
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "core_id",
    },
    pushToken: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      field: "push_token",
    },
    platform: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    lastSeenAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "last_seen_at",
    },
  },
  {
    tableName: "user_push_tokens",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
);

module.exports = UserPushToken;
