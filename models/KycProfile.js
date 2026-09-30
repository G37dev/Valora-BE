const { DataTypes } = require("sequelize");
const sequelize = require("../config/database"); // Sesuaikan path ini
const Customer = require("./Customer"); // Sesuaikan path model Customer

const KycProfile = sequelize.define(
  "KycProfile",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    core_id: {
      type: DataTypes.STRING,
      allowNull: false,
      references: {
        model: Customer,
        key: "core_id",
      },
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: "UNVERIFIED", // UNVERIFIED, PENDING, VERIFIED, REJECTED
    },
    assurance_level: DataTypes.STRING,
    verification_source: DataTypes.STRING,
    provider_id: DataTypes.STRING,
    provider_reference: DataTypes.STRING,
    verified_at: DataTypes.DATE,
    expires_at: DataTypes.DATE,
    metadata: {
      type: DataTypes.JSON,
      defaultValue: {},
    },
  },
  {
    tableName: "kyc_profiles",
    timestamps: true, // Akan otomatis membuat created_at dan updated_at
  },
);

// Definisikan Relasi
Customer.hasOne(KycProfile, { foreignKey: "core_id" });
KycProfile.belongsTo(Customer, { foreignKey: "core_id" });

module.exports = KycProfile;
