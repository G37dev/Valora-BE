const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Posisi Loan (brief 18). Canonical debt IDR authoritative di sini;
 * token quantity authoritative di contract (dimirror locked_qty).
 *
 * Kolom IDR = NUMERIC(38,18) fixed-point (PO bisa pecahan sebelum posting
 * final, lih. Worked Example C). Token = NUMERIC(38,18) unit desimal.
 */
const MONEY = { type: DataTypes.DECIMAL(38, 18), allowNull: false, defaultValue: 0 };

const LoanPosition = sequelize.define(
  "LoanPosition",
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    coreId: { type: DataTypes.STRING, allowNull: false, field: "core_id" },
    collateralAsset: { type: DataTypes.STRING(16), allowNull: false, field: "collateral_asset" },
    tokenDecimals: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 6, field: "token_decimals" },

    // ---- Collateral ----
    lockedQty: { ...MONEY, field: "locked_qty" },
    originalQty: { ...MONEY, field: "original_qty" },
    toppedUpQty: { ...MONEY, field: "topped_up_qty" },
    releasedQty: { ...MONEY, field: "released_qty" },
    settledQty: { ...MONEY, field: "settled_qty" },

    // ---- Debt ----
    principalOutstandingIdr: { ...MONEY, field: "principal_outstanding_idr" },
    grossDisbursedIdr: { ...MONEY, field: "gross_disbursed_idr" },
    netDisbursedIdr: { ...MONEY, field: "net_disbursed_idr" },
    protocolFeeIdr: { ...MONEY, field: "protocol_fee_idr" },
    principalRepaidIdr: { ...MONEY, field: "principal_repaid_idr" },
    // Interest Pot: posted tapi belum dibayar
    unpaidInterestIdr: { ...MONEY, field: "unpaid_interest_idr" },
    interestPostedIdr: { ...MONEY, field: "interest_posted_idr" },
    interestPaidIdr: { ...MONEY, field: "interest_paid_idr" },
    pdpAccruedIdr: { ...MONEY, field: "pdp_accrued_idr" },
    pdpPaidIdr: { ...MONEY, field: "pdp_paid_idr" },
    pdpDaysCharged: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0, field: "pdp_days_charged" },
    poAtMaturityIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "po_at_maturity_idr" },

    // ---- Terms ----
    aprBps: { type: DataTypes.INTEGER, allowNull: false, field: "apr_bps" },
    tenorDays: { type: DataTypes.SMALLINT, allowNull: false, field: "tenor_days" },
    initialLtvBps: { type: DataTypes.INTEGER, allowNull: false, field: "initial_ltv_bps" },
    activatedAt: { type: DataTypes.DATE, allowNull: true, field: "activated_at" },
    maturityAt: { type: DataTypes.DATE, allowNull: true, field: "maturity_at" },
    // Cycle anniversary terakhir yang sudah di-post (0 = belum ada)
    lastAnniversaryIndex: { type: DataTypes.SMALLINT, allowNull: false, defaultValue: 0, field: "last_anniversary_index" },
    // Prorata cycle berjalan sudah dihitung sampai waktu ini (segment boundary)
    interestAccruedThroughAt: { type: DataTypes.DATE, allowNull: true, field: "interest_accrued_through_at" },
    // Prorata belum di-post (cycle >= 2), fixed-point
    unpostedInterestIdr: { ...MONEY, field: "unposted_interest_idr" },

    // ---- Risk state ----
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "PENDING_COLLATERAL" },
    riskState: { type: DataTypes.STRING(32), allowNull: true, field: "risk_state" },
    settlementStatus: { type: DataTypes.STRING(32), allowNull: false, defaultValue: "NONE", field: "settlement_status" },
    observationUsed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "observation_used" },
    observationStartedAt: { type: DataTypes.DATE, allowNull: true, field: "observation_started_at" },
    observationEndsAt: { type: DataTypes.DATE, allowNull: true, field: "observation_ends_at" },
    cureEligible: { type: DataTypes.BOOLEAN, allowNull: true, field: "cure_eligible" },
    cureStartedAt: { type: DataTypes.DATE, allowNull: true, field: "cure_started_at" },
    cureEndsAt: { type: DataTypes.DATE, allowNull: true, field: "cure_ends_at" },
    marginCallAt: { type: DataTypes.DATE, allowNull: true, field: "margin_call_at" },
    lastRecoveredAt: { type: DataTypes.DATE, allowNull: true, field: "last_recovered_at" },
    liquidationTrigger: { type: DataTypes.STRING(32), allowNull: true, field: "liquidation_trigger" },
    lastLtvBps: { type: DataTypes.DECIMAL(12, 2), allowNull: true, field: "last_ltv_bps" },
    lastHf: { type: DataTypes.DECIMAL(12, 4), allowNull: true, field: "last_hf" },
    lastPriceIdr: { type: DataTypes.DECIMAL(38, 18), allowNull: true, field: "last_price_idr" },
    lastPriceStatus: { type: DataTypes.STRING(32), allowNull: true, field: "last_price_status" },
    lastRiskCheckAt: { type: DataTypes.DATE, allowNull: true, field: "last_risk_check_at" },

    // ---- Pool / cycle ----
    borrowerCycleId: { type: DataTypes.UUID, allowNull: true, field: "borrower_cycle_id" },
    poolSnapshotId: { type: DataTypes.UUID, allowNull: true, field: "pool_snapshot_id" },

    // ---- On-chain ----
    onchainPositionId: { type: DataTypes.STRING(66), allowNull: true, field: "onchain_position_id" },
    ownerAddress: { type: DataTypes.STRING(64), allowNull: true, field: "owner_address" },
    lockTxHash: { type: DataTypes.STRING(80), allowNull: true, field: "lock_tx_hash" },
    settlementNonce: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: "settlement_nonce" },

    // ---- Lifecycle ----
    nextEventAt: { type: DataTypes.DATE, allowNull: true, field: "next_event_at" },
    settledThroughAt: { type: DataTypes.DATE, allowNull: true, field: "settled_through_at" },
    completedAt: { type: DataTypes.DATE, allowNull: true, field: "completed_at" },
    closedAt: { type: DataTypes.DATE, allowNull: true, field: "closed_at" },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    idempotencyKey: { type: DataTypes.STRING, allowNull: false, unique: true, field: "idempotency_key" },
    policyVersionId: { type: DataTypes.UUID, allowNull: true, field: "policy_version_id" },
    rulesVersion: { type: DataTypes.STRING(32), allowNull: false, field: "rules_version" },
    isTest: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false, field: "is_test" },
    openingSnapshot: { type: DataTypes.JSONB, allowNull: true, field: "opening_snapshot" },
  },
  {
    tableName: "loan_positions",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    version: true,
    indexes: [
      { fields: ["core_id"] },
      { fields: ["status"] },
      { fields: ["core_id", "status"] },
      { fields: ["next_event_at"] },
      { fields: ["borrower_cycle_id"] },
    ],
  },
);

module.exports = LoanPosition;
