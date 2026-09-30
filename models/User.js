const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const User = sequelize.define(
  "User",
  {
    // coreId sebagai Primary Key yang nyambung ke tabel Customer
    coreId: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
      field: "core_id",
    },
    firstName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "first_name",
    },
    lastName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "last_name",
    },
    email: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: true,
    },
    phoneNumber: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: true,
      field: "phone_number",
    },
    avatarUrl: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "avatar_url",
    },
  },
  {
    tableName: "users",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
  },
);

module.exports = User;
