const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const PartnerIdentityLink = sequelize.define(
  "PartnerIdentityLink",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    tenantId: { type: DataTypes.UUID, allowNull: false, field: "tenant_id" },
    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "core_id", // <-- UBAH NAMA FIELD DB JADI core_id
    },
    externalUserId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "external_user_id",
    },
    partnerSub: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
      field: "partner_sub",
    },
    linkStatus: {
      type: DataTypes.STRING,
      defaultValue: "LINKED",
      field: "link_status",
    },
    metadata: { type: DataTypes.JSON, defaultValue: {} },
  },
  {
    tableName: "partner_identity_links",
    timestamps: true,
    createdAt: "linked_at",
    updatedAt: "last_verified_at",
  },
);

module.exports = PartnerIdentityLink;
