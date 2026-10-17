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

// Swap
const Swap = require("./Swap");
const SwapRefund = require("./SwapRefund");
const SwapEvent = require("./SwapEvent");

// Gold Installment
const InstallmentPlan = require("./InstallmentPlan");
const InstallmentSchedule = require("./InstallmentSchedule");
const InstallmentPayment = require("./InstallmentPayment");
const InstallmentEvent = require("./InstallmentEvent");

// Push Notifications
const UserPushToken = require("./UserPushToken");

// Business Clock (time simulation)
const BusinessClock = require("./BusinessClock");

// WhatsApp OTP
const WaOtpToken = require("./WaOtpToken");

// Loan V1
const LoanPosition = require("./LoanPosition");
const LoanDrawdown = require("./LoanDrawdown");
const LoanInterestEvent = require("./LoanInterestEvent");
const LoanRepayment = require("./LoanRepayment");
const LoanCollateralRelease = require("./LoanCollateralRelease");
const LoanRiskSnapshot = require("./LoanRiskSnapshot");
const LoanLiquidation = require("./LoanLiquidation");
const LoanTreasuryLot = require("./LoanTreasuryLot");
const LoanPool = require("./LoanPool");
const LoanBorrowerCycle = require("./LoanBorrowerCycle");
const LoanPoolSnapshot = require("./LoanPoolSnapshot");
const LoanPgAllocation = require("./LoanPgAllocation");
const LoanEvent = require("./LoanEvent");
const LoanRiskPolicyVersion = require("./LoanRiskPolicyVersion");
const LoanPriceTick = require("./LoanPriceTick");

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
// Customer & Swap
// ==========================================

Customer.hasMany(Swap, {
  foreignKey: "coreId",
  sourceKey: "coreId",
  as: "swaps",
});

Swap.belongsTo(Customer, {
  foreignKey: "coreId",
  targetKey: "coreId",
  as: "customer",
});

// ==========================================
// Swap & Internal Transactions
// ==========================================

Swap.hasMany(InternalTransaction, {
  foreignKey: "swapId",
  as: "internalTransactions",
});

InternalTransaction.belongsTo(Swap, {
  foreignKey: "swapId",
  as: "swap",
});

// ==========================================
// Swap & Refunds
// ==========================================

Swap.hasMany(SwapRefund, {
  foreignKey: "swapId",
  as: "refunds",
});

SwapRefund.belongsTo(Swap, {
  foreignKey: "swapId",
  as: "swap",
});

// ==========================================
// Swap & Events
// ==========================================

Swap.hasMany(SwapEvent, {
  foreignKey: "swapId",
  as: "events",
});

SwapEvent.belongsTo(Swap, {
  foreignKey: "swapId",
  as: "swap",
});

// ==========================================
// Customer & Swap Refund
// ==========================================

Customer.hasMany(SwapRefund, {
  foreignKey: "coreId",
  sourceKey: "coreId",
  as: "swapRefunds",
});

SwapRefund.belongsTo(Customer, {
  foreignKey: "coreId",
  targetKey: "coreId",
  as: "customer",
});

// ==========================================
// Customer & Swap Events
// ==========================================

Customer.hasMany(SwapEvent, {
  foreignKey: "coreId",
  sourceKey: "coreId",
  as: "swapEvents",
});

SwapEvent.belongsTo(Customer, {
  foreignKey: "coreId",
  targetKey: "coreId",
  as: "customer",
});

// ==========================================
// Gold Installment
// ==========================================

Customer.hasMany(InstallmentPlan, {
  foreignKey: "coreId",
  sourceKey: "coreId",
  as: "installmentPlans",
});

InstallmentPlan.belongsTo(Customer, {
  foreignKey: "coreId",
  targetKey: "coreId",
  as: "customer",
});

InstallmentPlan.hasMany(InstallmentSchedule, {
  foreignKey: "planId",
  as: "schedules",
});

InstallmentSchedule.belongsTo(InstallmentPlan, {
  foreignKey: "planId",
  as: "plan",
});

InstallmentPlan.hasMany(InstallmentPayment, {
  foreignKey: "planId",
  as: "payments",
});

InstallmentPayment.belongsTo(InstallmentPlan, {
  foreignKey: "planId",
  as: "plan",
});

InstallmentPlan.hasMany(InstallmentEvent, {
  foreignKey: "planId",
  as: "events",
});

InstallmentEvent.belongsTo(InstallmentPlan, {
  foreignKey: "planId",
  as: "plan",
});

// ==========================================
// Loan V1
// ==========================================

Customer.hasMany(LoanPosition, {
  foreignKey: "coreId",
  sourceKey: "coreId",
  as: "loanPositions",
});
LoanPosition.belongsTo(Customer, {
  foreignKey: "coreId",
  targetKey: "coreId",
  as: "customer",
});

for (const [Model, alias] of [
  [LoanDrawdown, "drawdowns"],
  [LoanInterestEvent, "interestEvents"],
  [LoanRepayment, "repayments"],
  [LoanCollateralRelease, "releases"],
  [LoanRiskSnapshot, "riskSnapshots"],
  [LoanLiquidation, "liquidations"],
  [LoanPgAllocation, "pgAllocations"],
  [LoanEvent, "events"],
]) {
  LoanPosition.hasMany(Model, { foreignKey: "positionId", as: alias });
  Model.belongsTo(LoanPosition, { foreignKey: "positionId", as: "position" });
}

LoanLiquidation.hasMany(LoanTreasuryLot, {
  foreignKey: "liquidationId",
  as: "lots",
});
LoanTreasuryLot.belongsTo(LoanLiquidation, {
  foreignKey: "liquidationId",
  as: "liquidation",
});

// ==========================================
// User & Push Tokens
// ==========================================

User.hasMany(UserPushToken, {
  foreignKey: "coreId",
  sourceKey: "coreId",
  as: "pushTokens",
});

UserPushToken.belongsTo(User, {
  foreignKey: "coreId",
  targetKey: "coreId",
  as: "user",
});

// ==========================================
// Exports
// ==========================================

module.exports = {
  sequelize,

  // Core
  Customer,
  User,
  AuthIdentity,
  Tenant,
  PartnerIdentityLink,
  KycProfile,

  // Wallet
  Wallet,
  InternalWallet,

  // Transactions
  Transaction,
  InternalTransaction,

  // Payments
  TopUp,

  // Pricing
  Price,

  // Authentication
  Passkey,

  // Earn
  EarnPosition,

  // Swap
  Swap,
  SwapRefund,
  SwapEvent,

  // Gold Installment
  InstallmentPlan,
  InstallmentSchedule,
  InstallmentPayment,
  InstallmentEvent,

  // Push Notifications
  UserPushToken,

  // Business Clock
  BusinessClock,

  // WhatsApp OTP
  WaOtpToken,

  // Loan V1
  LoanPosition,
  LoanDrawdown,
  LoanInterestEvent,
  LoanRepayment,
  LoanCollateralRelease,
  LoanRiskSnapshot,
  LoanLiquidation,
  LoanTreasuryLot,
  LoanPool,
  LoanBorrowerCycle,
  LoanPoolSnapshot,
  LoanPgAllocation,
  LoanEvent,
  LoanRiskPolicyVersion,
  LoanPriceTick,
};
