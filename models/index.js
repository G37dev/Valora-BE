const sequelize = require("../config/database");

const Customer = require("./Customer");
const AuthIdentity = require("./AuthIdentity");
const Tenant = require("./Tenant");
const PartnerIdentityLink = require("./PartnerIdentityLink");
const User = require("./User");
const KycProfile = require("./KycProfile");
const Wallet = require("./Wallet");
const Transaction = require("./Transaction");
const Price = require("./Price");
const InternalWallet = require("./InternalWallet");
const InternalTransaction = require("./InternalTransaction");
const TopUp = require("./TopUp");
const Passkey = require("./Passkey");
const EarnPosition = require("./EarnPosition");

// ==========================================
// Customer & User
// ==========================================

Customer.hasOne(User, {
  foreignKey: "coreId",
  as: "userData",
});

User.belongsTo(Customer, {
  foreignKey: "coreId",
});

// ==========================================
// Customer & Auth
// ==========================================

Customer.hasMany(AuthIdentity, {
  foreignKey: "coreId",
  as: "authIdentities",
});

AuthIdentity.belongsTo(Customer, {
  foreignKey: "coreId",
});

// ==========================================
// Multi Tenant
// ==========================================

Tenant.hasMany(PartnerIdentityLink, {
  foreignKey: "tenantId",
  as: "identityLinks",
});

PartnerIdentityLink.belongsTo(Tenant, {
  foreignKey: "tenantId",
});

Customer.hasMany(PartnerIdentityLink, {
  foreignKey: "coreId",
  as: "partnerLinks",
});

PartnerIdentityLink.belongsTo(Customer, {
  foreignKey: "coreId",
});

// ==========================================
// User & KYC
// ==========================================

User.hasOne(KycProfile, {
  foreignKey: "core_id",
  as: "KycProfile",
});

KycProfile.belongsTo(User, {
  foreignKey: "core_id",
});

// ==========================================
// User & Blockchain Wallet
// ==========================================

User.hasOne(Wallet, {
  foreignKey: "core_id",
  as: "Wallet",
});

Wallet.belongsTo(User, {
  foreignKey: "core_id",
});

// ==========================================
// Customer & Internal Wallet
// ==========================================

Customer.hasOne(InternalWallet, {
  foreignKey: "coreId",
  sourceKey: "coreId",
  as: "InternalWallet",
});

InternalWallet.belongsTo(Customer, {
  foreignKey: "coreId",
  targetKey: "coreId",
  as: "Customer",
});

// ==========================================
// Internal Wallet & Internal Transactions
// ==========================================

InternalWallet.hasMany(InternalTransaction, {
  foreignKey: "internalWalletId",
  as: "transactions",
});

InternalTransaction.belongsTo(InternalWallet, {
  foreignKey: "internalWalletId",
  as: "wallet",
});

// ==========================================
// TopUp & Internal Wallet
// ==========================================

InternalWallet.hasMany(TopUp, {
  foreignKey: "internalWalletId",
  as: "topUps",
});

TopUp.belongsTo(InternalWallet, {
  foreignKey: "internalWalletId",
  as: "internalWallet",
});

// ==========================================
// Customer & TopUp
// ==========================================

Customer.hasMany(TopUp, {
  foreignKey: "coreId",
  sourceKey: "coreId",
  as: "topUps",
});

TopUp.belongsTo(Customer, {
  foreignKey: "coreId",
  targetKey: "coreId",
  as: "customer",
});

// ==========================================
// TopUp & Internal Transaction
// ==========================================

TopUp.hasOne(InternalTransaction, {
  foreignKey: "topUpId",
  as: "internalTransaction",
});

InternalTransaction.belongsTo(TopUp, {
  foreignKey: "topUpId",
  as: "topUp",
});

// ==========================================

module.exports = {
  sequelize,

  Customer,
  User,
  AuthIdentity,
  Tenant,
  PartnerIdentityLink,
  KycProfile,

  Wallet,
  Transaction,

  Price,

  InternalWallet,
  InternalTransaction,
  TopUp,

  Passkey,
  EarnPosition,
};
