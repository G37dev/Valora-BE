const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const Customer = sequelize.define(
  "Customer",
  {
    coreId: {
      type: DataTypes.STRING,
      primaryKey: true, // coreId sekarang menjadi Primary Key utama
      field: "core_id",
    },
    status: { type: DataTypes.STRING, defaultValue: "ACTIVE" },
    provisioningStatus: {
      type: DataTypes.STRING,
      defaultValue: "PROVISIONED",
      field: "provisioning_status",
    },
    mergedIntoCustomerId: {
      type: DataTypes.STRING, // Tipe datanya harus sama dengan coreId (STRING)
      allowNull: true,
      field: "merged_into_customer_id",
    },
  },
  {
    tableName: "customers",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    hooks: {
      beforeValidate: async (customer, options) => {
        // Generate format CR... sebelum data divalidasi/disimpan
        if (!customer.coreId) {
          customer.coreId = await generateCoreId(options.transaction);
        }
      },
    },
  },
);

async function generateCoreId(transaction) {
  let isUnique = false;
  let newCoreId = "";

  // Kumpulan karakter yang diizinkan (kecuali i, o, 0, I, O)
  const chars = "abcdefghjklmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ123456789";

  while (!isUnique) {
    let result = "";
    // Generate 8 digit karakter secara acak
    for (let i = 0; i < 8; i++) {
      const randomIndex = Math.floor(Math.random() * chars.length);
      result += chars[randomIndex];
    }
    newCoreId = result;

    // Cek apakah ID sudah ada di database
    const existing = await Customer.findOne({
      where: { coreId: newCoreId },
      transaction,
    });

    if (!existing) {
      isUnique = true;
    }
  }

  return newCoreId;
}

module.exports = Customer;
