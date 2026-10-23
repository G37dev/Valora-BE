/*
 * Loyalty & Referral Engine — data model (VIVALORA Loyalty & Referral
 * Developer Brief V1.1, section 12.1).
 *
 * Modul berdiri sendiri dari produk (Earn/Loan/Installment/Swap). Semua
 * tabel loyalty dikumpulkan di satu file agar boundary modul jelas.
 *
 * Invariants (brief 2.3 / 10.2):
 * - business_key UNIQUE pada grant   -> exactly-once reward
 * - idempotency_key UNIQUE pada jurnal -> exactly-once ledger effect
 * - (source_system, source_event_id) UNIQUE -> event replay aman
 * - Nilai uang: IDR integer rupiah (BIGINT), VP integer (BIGINT).
 */

const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

const ts = {
  timestamps: true,
  createdAt: "created_at",
  updatedAt: "updated_at",
};
const uuidPk = {
  type: DataTypes.UUID,
  defaultValue: DataTypes.UUIDV4,
  primaryKey: true,
};
const bigint = (field, extra = {}) => ({
  type: DataTypes.BIGINT,
  allowNull: false,
  defaultValue: 0,
  field,
  ...extra,
});
const str = (field, len = 64, extra = {}) => ({
  type: DataTypes.STRING(len),
  allowNull: true,
  field,
  ...extra,
});

// ---------------------------------------------------------------------------
// Identity / enrollment
// ---------------------------------------------------------------------------
const LoyaltyCustomer = sequelize.define(
  "LoyaltyCustomer",
  {
    coreId: { type: DataTypes.STRING, primaryKey: true, field: "core_id" },
    enrolledAt: { type: DataTypes.DATE, allowNull: false, field: "enrolled_at" },
    accountCreatedAt: { type: DataTypes.DATE, allowNull: true, field: "account_created_at" },
    // First Deposit opportunity (one-time, lintas IDR/crypto)
    firstDepositConsumedAt: { type: DataTypes.DATE, allowNull: true, field: "first_deposit_consumed_at" },
    firstDepositEventId: str("first_deposit_event_id", 160),
    firstDepositQualified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "first_deposit_qualified" },
    // First Qualified Transaction slot (one-time lintas Earn/Loan/Installment)
    fqtSlotState: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "UNUSED", field: "first_qualified_slot_state" },
    fqtFeature: str("first_qualified_feature", 32),
    fqtPositionRef: str("first_qualified_position_id", 160),
    fqtReservedAt: { type: DataTypes.DATE, allowNull: true, field: "first_qualified_reserved_at" },
    // Membership projection (sumber kebenaran = loyalty_twab_events)
    currentTier: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "CADET", field: "current_tier" },
    currentTwab30Idr: bigint("current_twab30_idr"),
    fullHistory: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "full_history" },
    historyStartAt: { type: DataTypes.DATE, allowNull: true, field: "history_start_at" },
    tierComputedAt: { type: DataTypes.DATE, allowNull: true, field: "tier_computed_at" },
    riskFlags: { type: DataTypes.JSONB, allowNull: true, field: "risk_flags" },
  },
  { tableName: "loyalty_customers", ...ts },
);

const LoyaltyReferralCode = sequelize.define(
  "LoyaltyReferralCode",
  {
    id: uuidPk,
    coreId: { type: DataTypes.STRING, allowNull: false, unique: true, field: "core_id" },
    code: { type: DataTypes.STRING(16), allowNull: false, unique: true },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { tableName: "loyalty_referral_codes", ...ts },
);

const LoyaltyReferralLink = sequelize.define(
  "LoyaltyReferralLink",
  {
    id: uuidPk,
    refereeCoreId: { type: DataTypes.STRING, allowNull: false, unique: true, field: "referee_customer_id" },
    referrerCoreId: { type: DataTypes.STRING, allowNull: false, field: "referrer_customer_id" },
    referralCodeId: { type: DataTypes.UUID, allowNull: true, field: "referral_code_id" },
    code: str("code", 16),
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "VALID" }, // VALID | REJECTED
    linkedAt: { type: DataTypes.DATE, allowNull: false, field: "linked_at" },
    validatedAt: { type: DataTypes.DATE, allowNull: true, field: "validated_at" },
    // Qualification referee
    depositQualified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "deposit_qualified" },
    depositQualifiedAt: { type: DataTypes.DATE, allowNull: true, field: "deposit_qualified_at" },
    depositOpportunityUsed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "deposit_opportunity_used" },
    activationState: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "NONE", field: "activation_state" }, // NONE | PENDING | GRANTED | VOID
    activationPositionRef: str("activation_position_id", 160),
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loyalty_referral_links",
    ...ts,
    indexes: [{ fields: ["referrer_customer_id"] }],
  },
);

// ---------------------------------------------------------------------------
// Versioned admin configuration (brief 11)
// ---------------------------------------------------------------------------
const LoyaltyConfigVersion = sequelize.define(
  "LoyaltyConfigVersion",
  {
    id: uuidPk,
    version: { type: DataTypes.INTEGER, allowNull: false, unique: true },
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "DRAFT" }, // DRAFT|REVIEW|APPROVED|SCHEDULED|ACTIVE|SUPERSEDED|REJECTED
    config: { type: DataTypes.JSONB, allowNull: false },
    schemaVersion: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "1.1", field: "schema_version" },
    effectiveAt: { type: DataTypes.DATE, allowNull: true, field: "effective_at" },
    note: { type: DataTypes.TEXT, allowNull: true },
    ticketRef: str("ticket_ref", 128),
    createdBy: str("created_by", 128),
    reviewedBy: str("reviewed_by", 128),
    approvedBy: str("approved_by", 128),
    approvedAt: { type: DataTypes.DATE, allowNull: true, field: "approved_at" },
    previousVersionId: { type: DataTypes.UUID, allowNull: true, field: "previous_version_id" },
    diff: { type: DataTypes.JSONB, allowNull: true },
  },
  { tableName: "loyalty_config_versions", ...ts },
);

// ---------------------------------------------------------------------------
// Reward grants (entitlement) + append-only journals
// ---------------------------------------------------------------------------
const LoyaltyRewardGrant = sequelize.define(
  "LoyaltyRewardGrant",
  {
    id: uuidPk,
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    category: { type: DataTypes.STRING(32), allowNull: false }, // FIRST_DEPOSIT|FQT|REGULAR|MONTHLY|MONTHLY_BOOSTER|REFERRAL_DEPOSIT|REFERRAL_ACTIVATION
    unit: { type: DataTypes.STRING(4), allowNull: false }, // VP | IDR
    businessKey: { type: DataTypes.STRING(200), allowNull: false, unique: true, field: "business_key" },
    sourceSystem: str("source_system", 32),
    sourceEventId: str("source_event_id", 160),
    sourceTransactionId: str("source_transaction_id", 160),
    feature: str("feature", 16), // DEPOSIT|EARN|LOAN|INSTALLMENT|SWAP|MONTHLY
    positionRef: str("position_ref", 160),
    counterpartyCoreId: str("counterparty_core_id", 64), // referral: referee B
    // VP: PENDING|AVAILABLE|VOID|REVERSED   IDR: PENDING|CLAIMABLE|CLAIMING|CLAIMED|VOID
    state: { type: DataTypes.STRING(16), allowNull: false },
    vpAmount: bigint("vp_amount"),
    idrAmount: bigint("idr_amount"),
    // Snapshot perhitungan (brief 2.3 — rate, cap, tier, basis, fee deductions)
    tierSnapshot: str("tier_snapshot", 16),
    multiplierBps: { type: DataTypes.INTEGER, allowNull: true, field: "multiplier_bps" },
    rateBps: { type: DataTypes.INTEGER, allowNull: true, field: "rate_bps" },
    capApplied: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "cap_applied" },
    basisIdr: bigint("basis_idr", { allowNull: true, defaultValue: null }),
    feeGrossIdr: bigint("fee_gross_idr", { allowNull: true, defaultValue: null }),
    feeCostIdr: bigint("fee_cost_idr", { allowNull: true, defaultValue: null }),
    feeDiscountIdr: bigint("fee_discount_idr", { allowNull: true, defaultValue: null }),
    feeNetIdr: bigint("fee_net_idr", { allowNull: true, defaultValue: null }),
    configVersionId: { type: DataTypes.UUID, allowNull: true, field: "config_version_id" },
    configVersion: { type: DataTypes.INTEGER, allowNull: true, field: "config_version" },
    valuationSnapshot: { type: DataTypes.JSONB, allowNull: true, field: "valuation_snapshot" },
    occurredAt: { type: DataTypes.DATE, allowNull: false, field: "occurred_at" },
    availableAt: { type: DataTypes.DATE, allowNull: true, field: "available_at" }, // time-based hold
    availabilityTrigger: str("availability_trigger", 64), // HOLD_EXPIRY | POSITION_SETTLED | IMMEDIATE
    vestedAt: { type: DataTypes.DATE, allowNull: true, field: "vested_at" },
    voidedAt: { type: DataTypes.DATE, allowNull: true, field: "voided_at" },
    voidReason: str("void_reason", 128),
    claimId: { type: DataTypes.UUID, allowNull: true, field: "claim_id" },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loyalty_reward_grants",
    ...ts,
    indexes: [
      { fields: ["core_id", "state"] },
      { fields: ["core_id", "category"] },
      { fields: ["position_ref"] },
      { fields: ["state", "available_at"] },
    ],
  },
);

const LoyaltyVpJournal = sequelize.define(
  "LoyaltyVpJournal",
  {
    id: uuidPk,
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    grantId: { type: DataTypes.UUID, allowNull: true, field: "grant_id" },
    redemptionId: { type: DataTypes.UUID, allowNull: true, field: "redemption_id" },
    bucket: { type: DataTypes.STRING(16), allowNull: false }, // PENDING|AVAILABLE|RESERVED|REDEEMED
    deltaVp: bigint("delta_vp"),
    reasonCode: { type: DataTypes.STRING(48), allowNull: false, field: "reason_code" },
    idempotencyKey: { type: DataTypes.STRING(200), allowNull: false, unique: true, field: "idempotency_key" },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loyalty_vp_journal",
    ...ts,
    indexes: [{ fields: ["core_id", "bucket"] }, { fields: ["grant_id"] }],
  },
);

const LoyaltyReferralIdrJournal = sequelize.define(
  "LoyaltyReferralIdrJournal",
  {
    id: uuidPk,
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" }, // referrer A
    grantId: { type: DataTypes.UUID, allowNull: true, field: "grant_id" },
    linkId: { type: DataTypes.UUID, allowNull: true, field: "link_id" },
    claimId: { type: DataTypes.UUID, allowNull: true, field: "claim_id" },
    sourcePositionRef: str("source_position_id", 160),
    bucket: { type: DataTypes.STRING(16), allowNull: false }, // PENDING|CLAIMABLE|CLAIMED
    deltaIdr: bigint("delta_idr"),
    reasonCode: { type: DataTypes.STRING(48), allowNull: false, field: "reason_code" },
    idempotencyKey: { type: DataTypes.STRING(200), allowNull: false, unique: true, field: "idempotency_key" },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loyalty_referral_idr_journal",
    ...ts,
    indexes: [{ fields: ["core_id", "bucket"] }],
  },
);

const LoyaltyRewardClaim = sequelize.define(
  "LoyaltyRewardClaim",
  {
    id: uuidPk,
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    amountIdr: bigint("amount_idr"),
    state: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "CLAIMING" }, // CLAIMING|CLAIMED|FAILED
    clientIdempotencyKey: { type: DataTypes.STRING(200), allowNull: false, unique: true, field: "client_idempotency_key" },
    walletPostingId: { type: DataTypes.UUID, allowNull: true, unique: true, field: "wallet_posting_id" },
    grantIds: { type: DataTypes.JSONB, allowNull: true, field: "grant_ids" },
    failureReason: { type: DataTypes.TEXT, allowNull: true, field: "failure_reason" },
    claimedAt: { type: DataTypes.DATE, allowNull: true, field: "claimed_at" },
  },
  { tableName: "loyalty_reward_claims", ...ts, indexes: [{ fields: ["core_id"] }] },
);

const LoyaltyRewardRedemption = sequelize.define(
  "LoyaltyRewardRedemption",
  {
    id: uuidPk,
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    amountVp: bigint("amount_vp"),
    targetType: { type: DataTypes.STRING(16), allowNull: false, field: "target_type" }, // FEE_DISCOUNT | CATALOG
    targetId: str("target_id", 160),
    feeCode: str("fee_code", 48),
    quoteSnapshot: { type: DataTypes.JSONB, allowNull: true, field: "quote_snapshot" },
    state: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "RESERVED" }, // RESERVED|COMMITTED|RELEASED|FAILED
    idempotencyKey: { type: DataTypes.STRING(200), allowNull: false, unique: true, field: "idempotency_key" },
    fulfillmentId: str("fulfillment_id", 160),
    fulfillmentState: str("fulfillment_state", 32),
    expiresAt: { type: DataTypes.DATE, allowNull: true, field: "expires_at" },
    committedAt: { type: DataTypes.DATE, allowNull: true, field: "committed_at" },
    releasedAt: { type: DataTypes.DATE, allowNull: true, field: "released_at" },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  {
    tableName: "loyalty_reward_redemptions",
    ...ts,
    indexes: [{ fields: ["core_id", "state"] }, { fields: ["state", "expires_at"] }],
  },
);

const LoyaltyCatalogItem = sequelize.define(
  "LoyaltyCatalogItem",
  {
    id: uuidPk,
    sku: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    title: { type: DataTypes.STRING(160), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    vpPrice: bigint("vp_price"),
    rewardType: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "ASSET", field: "reward_type" }, // ASSET|VOUCHER|PRIVILEGE
    rewardAsset: str("reward_asset", 16),
    rewardAmount: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "reward_amount" },
    stock: { type: DataTypes.INTEGER, allowNull: true }, // null = unlimited
    perUserLimit: { type: DataTypes.INTEGER, allowNull: true, field: "per_user_limit" },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    startsAt: { type: DataTypes.DATE, allowNull: true, field: "starts_at" },
    endsAt: { type: DataTypes.DATE, allowNull: true, field: "ends_at" },
    metadata: { type: DataTypes.JSONB, allowNull: true },
  },
  { tableName: "loyalty_catalog_items", ...ts },
);

// ---------------------------------------------------------------------------
// Membership time series
// ---------------------------------------------------------------------------
const LoyaltyTwabEvent = sequelize.define(
  "LoyaltyTwabEvent",
  {
    id: uuidPk,
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    eventAt: { type: DataTypes.DATE, allowNull: false, field: "event_at" },
    eligibleAssetsIdr: bigint("eligible_assets_idr"),
    liabilitiesIdr: bigint("liabilities_idr"),
    qualifiedBalanceIdr: bigint("qualified_balance_idr"),
    priceStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "VALID", field: "price_status" },
    breakdown: { type: DataTypes.JSONB, allowNull: true },
    sourceEventId: { type: DataTypes.STRING(200), allowNull: false, unique: true, field: "source_event_id" },
  },
  {
    tableName: "loyalty_twab_events",
    ...ts,
    indexes: [{ fields: ["core_id", "event_at"] }],
  },
);

const LoyaltyTierHistory = sequelize.define(
  "LoyaltyTierHistory",
  {
    id: uuidPk,
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    effectiveAt: { type: DataTypes.DATE, allowNull: false, field: "effective_at" },
    tier: { type: DataTypes.STRING(16), allowNull: false },
    previousTier: str("previous_tier", 16),
    twab30Idr: bigint("twab30_idr"),
    fullHistory: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "full_history" },
    configVersionId: { type: DataTypes.UUID, allowNull: true, field: "threshold_config_version" },
    decisionReason: str("decision_reason", 128),
  },
  {
    tableName: "loyalty_membership_tier_history",
    ...ts,
    indexes: [{ fields: ["core_id", "effective_at"] }],
  },
);

const LoyaltyMonthlyProgress = sequelize.define(
  "LoyaltyMonthlyProgress",
  {
    id: uuidPk,
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    monthKey: { type: DataTypes.STRING(7), allowNull: false, field: "month_key" }, // YYYY-MM (business tz)
    txCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "tx_count" },
    netFeeIdr: bigint("net_fee_idr"),
    txRefs: { type: DataTypes.JSONB, allowNull: false, defaultValue: [], field: "tx_refs" },
    milestoneState: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "IN_PROGRESS", field: "milestone_state" },
    achievedAt: { type: DataTypes.DATE, allowNull: true, field: "achieved_at" },
    tierSnapshot: str("tier_snapshot", 16),
    boosterGranted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "booster_granted" },
  },
  {
    tableName: "loyalty_monthly_reward_progress",
    ...ts,
    indexes: [{ unique: true, fields: ["core_id", "month_key"] }],
  },
);

const LoyaltyBudgetLedger = sequelize.define(
  "LoyaltyBudgetLedger",
  {
    id: uuidPk,
    campaignId: { type: DataTypes.STRING(64), allowNull: false, unique: true, field: "campaign_id" }, // ACQUISITION:YYYY-MM | TRANSACTION:YYYY-MM
    budgetCeilingIdr: bigint("budget_ceiling_idr", { allowNull: true, defaultValue: null }),
    committedIdrEq: bigint("committed_idr_eq"),
    consumedIdrEq: bigint("consumed_idr_eq"),
    status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "OPEN" },
    approvedConfigVersion: { type: DataTypes.INTEGER, allowNull: true, field: "approved_config_version" },
  },
  { tableName: "loyalty_budget_ledger", ...ts },
);

const LoyaltyProcessedEvent = sequelize.define(
  "LoyaltyProcessedEvent",
  {
    id: uuidPk,
    sourceSystem: { type: DataTypes.STRING(32), allowNull: false, field: "source_system" },
    sourceEventId: { type: DataTypes.STRING(160), allowNull: false, field: "source_event_id" },
    eventType: { type: DataTypes.STRING(48), allowNull: false, field: "event_type" },
    coreId: str("core_id", 64),
    payloadHash: str("payload_hash", 64),
    processingStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: "PROCESSED", field: "processing_status" }, // PROCESSED|SKIPPED|FAILED
    attemptCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, field: "attempt_count" },
    result: { type: DataTypes.JSONB, allowNull: true },
    error: { type: DataTypes.TEXT, allowNull: true },
    occurredAt: { type: DataTypes.DATE, allowNull: true, field: "occurred_at" },
    processedAt: { type: DataTypes.DATE, allowNull: true, field: "processed_at" },
  },
  {
    tableName: "loyalty_processed_events",
    ...ts,
    indexes: [
      { unique: true, fields: ["source_system", "source_event_id"] },
      { fields: ["core_id"] },
    ],
  },
);

// FK order untuk sync()
const LOYALTY_MODELS = [
  LoyaltyConfigVersion,
  LoyaltyCustomer,
  LoyaltyReferralCode,
  LoyaltyReferralLink,
  LoyaltyRewardGrant,
  LoyaltyVpJournal,
  LoyaltyReferralIdrJournal,
  LoyaltyRewardClaim,
  LoyaltyRewardRedemption,
  LoyaltyCatalogItem,
  LoyaltyTwabEvent,
  LoyaltyTierHistory,
  LoyaltyMonthlyProgress,
  LoyaltyBudgetLedger,
  LoyaltyProcessedEvent,
];

module.exports = {
  LoyaltyCustomer,
  LoyaltyReferralCode,
  LoyaltyReferralLink,
  LoyaltyConfigVersion,
  LoyaltyRewardGrant,
  LoyaltyVpJournal,
  LoyaltyReferralIdrJournal,
  LoyaltyRewardClaim,
  LoyaltyRewardRedemption,
  LoyaltyCatalogItem,
  LoyaltyTwabEvent,
  LoyaltyTierHistory,
  LoyaltyMonthlyProgress,
  LoyaltyBudgetLedger,
  LoyaltyProcessedEvent,
  LOYALTY_MODELS,
};
