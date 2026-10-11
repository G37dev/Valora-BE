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
    uuid: {
      type: DataTypes.STRING(6),
      unique: true,
      allowNull: true,
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
    hooks: {
      beforeValidate: async (user, options) => {
        // Generate kode unik 6 digit sebelum data divalidasi/disimpan
        if (!user.uuid) {
          user.uuid = await generateUserUuid(options.transaction);
        }
      },
    },
  },
);

async function generateUserUuid(transaction) {
  let isUnique = false;
  let newUuid = "";

  while (!isUnique) {
    // 6 digit angka acak (100000-999999, tanpa leading zero)
    newUuid = String(Math.floor(100000 + Math.random() * 900000));

    const existing = await User.findOne({
      where: { uuid: newUuid },
      transaction,
    });

    if (!existing) {
      isUnique = true;
    }
  }

  return newUuid;
}

module.exports = User;
