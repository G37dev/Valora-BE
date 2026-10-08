const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");

/*
 * Posisi Gold Installment (Standard + Flexible).
 *
 * Semua bucket finansial disimpan TERPISAH (brief 14.2):
 * principal, carrying, late penalty, past-due penalty, restructure fee,
 * cancellation compensation, ALC, protocol fee, claim network fee, refund.
 *
 * Kolom *_idr bertipe BIGINT (integer rupiah) -> pg mengembalikan string,
 * service selalu mengonversi via calc.big().
 */
const InstallmentPlan = sequelize.define(
  "InstallmentPlan",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    coreId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "core_id",
    },

    planType: {
      type: DataTypes.ENUM("STANDARD", "FLEXIBLE"),
      allowNull: false,
      field: "plan_type",
    },

    assetCode: {
      type: DataTypes.STRING(16),
      allowNull: false,
      field: "asset_code",
    },

    // gram (NUMERIC(38,18))
    goldAmount: {
      type: DataTypes.DECIMAL(38, 18),
      allowNull: false,
      field: "gold_amount",
    },

    // IDR per gram, snapshot saat request
    lockedPriceIdr: {
      type: DataTypes.DECIMAL(38, 18),
      allowNull: false,
      field: "locked_price_idr",
    },

    priceSource: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "price_source",
    },

    assetValueIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: "asset_value_idr",
    },

    tenorMonths: {
      type: DataTypes.SMALLINT,
      allowNull: false,
      field: "tenor_months",
    },

    // ---------- Standard ----------
    installmentGap: {
      type: DataTypes.ENUM("WEEKLY", "MONTHLY"),
      allowNull: true,
      field: "installment_gap",
    },

    markupBps: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "markup_bps",
    },

    scheduleCount: {
      type: DataTypes.SMALLINT,
      allowNull: true,
      field: "schedule_count",
    },

    standardTotalPaymentIdr: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "standard_total_payment_idr",
    },

    // SEPA
    standardEligiblePaidIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "standard_eligible_paid_idr",
    },

    // ---------- Flexible ----------
    priceLockMarginBps: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "price_lock_margin_bps",
    },

    lockedPlanValueIdr: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "locked_plan_value_idr",
    },

    dpBps: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "dp_bps",
    },

    // EPP
    eligiblePlanPaymentIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "eligible_plan_payment_idr",
    },

    // ---------- Shared balances ----------
    // Pembayaran awal yang wajib untuk aktivasi (DP / installment pertama)
    initialPaymentIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: "initial_payment_idr",
    },

    principalOutstandingIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: "principal_outstanding_idr",
    },

    // Unpaid accrued carrying (Flexible)
    accruedCarryingIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "accrued_carrying_idr",
    },

    carryingPaidIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "carrying_paid_idr",
    },

    // Unpaid late penalty (Standard)
    latePenaltyIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "late_penalty_idr",
    },

    latePenaltyPaidIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "late_penalty_paid_idr",
    },

    // Unpaid PDP
    pastDuePenaltyIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "past_due_penalty_idr",
    },

    pastDuePenaltyPaidIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "past_due_penalty_paid_idr",
    },

    // Unpaid RF
    restructureFeeIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "restructure_fee_idr",
    },

    restructureFeePaidIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "restructure_fee_paid_idr",
    },

    paymentCompletionBps: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "payment_completion_bps",
    },

    grossCashPaidIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "gross_cash_paid_idr",
    },

    // ---------- Settlement outputs ----------
    cancellationRateBps: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "cancellation_rate_bps",
    },

    cancellationCompensationIdr: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "cancellation_compensation_idr",
    },

    alcRateBps: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "alc_rate_bps",
    },

    alcAmountIdr: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "alc_amount_idr",
    },

    // "Applicable Actual Cost" - default 0, admin-settable
    actualCostIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: "actual_cost_idr",
    },

    rawRefundIdr: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "raw_refund_idr",
    },

    finalRefundIdr: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "final_refund_idr",
    },

    // ---------- Claim ----------
    protocolFeeBps: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 25,
      field: "protocol_fee_bps",
    },

    protocolFeeIdr: {
      type: DataTypes.BIGINT,
      allowNull: false,
      field: "protocol_fee_idr",
    },

    protocolFeeStatus: {
      type: DataTypes.ENUM("NOT_CHARGED", "PENDING", "CHARGED", "REVERSED"),
      allowNull: false,
      defaultValue: "NOT_CHARGED",
      field: "protocol_fee_status",
    },

    claimNetworkFeeIdr: {
      type: DataTypes.BIGINT,
      allowNull: true,
      field: "claim_network_fee_idr",
    },

    releaseTxHash: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "release_tx_hash",
    },

    // ---------- State ----------
    status: {
      type: DataTypes.ENUM(
        "REQUEST_CREATED",
        "REQUEST_EXPIRED",
        "ACTIVE",
        "CANCELLATION_CLOSED",
        "PAST_DUE",
        "RESTRUCTURED",
        "COMPLETE_PENDING_CLAIM",
        "CLAIMABLE",
        "AUTO_LIQUIDATED",
        "CANCELLED",
        "CLOSED",
      ),
      allowNull: false,
      defaultValue: "REQUEST_CREATED",
    },

    requestCreatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "request_created_at",
    },

    requestExpiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "request_expires_at",
    },

    activatedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "activated_at",
    },

    maturityAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "maturity_at",
    },

    // Anniversary berikutnya (index ke-k dari activation) untuk carrying
    nextCarryingIndex: {
      type: DataTypes.SMALLINT,
      allowNull: true,
      field: "next_carrying_index",
    },

    nextCarryingAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "next_carrying_at",
    },

    cancellationClosedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "cancellation_closed_at",
    },

    pastDueAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "past_due_at",
    },

    cureEndsAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "cure_ends_at",
    },

    restructureStartedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "restructure_started_at",
    },

    restructureMaturityAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "restructure_maturity_at",
    },

    restructureExtensionMonths: {
      type: DataTypes.SMALLINT,
      allowNull: true,
      field: "restructure_extension_months",
    },

    h3NotifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "h3_notified_at",
    },

    fullySettledAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "fully_settled_at",
    },

    claimableAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "claimable_at",
    },

    closedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "closed_at",
    },

    // Waktu event terjadwal berikutnya (untuk query scheduler yang murah)
    nextEventAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "next_event_at",
    },

    // Waktu efektif terakhir settleToNow dijalankan
    settledThroughAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "settled_through_at",
    },

    idempotencyKey: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      field: "idempotency_key",
    },

    rulesVersion: {
      type: DataTypes.STRING(32),
      allowNull: false,
      field: "rules_version",
    },

    // Plan yang dibuat di bawah test clock (bukan data asli)
    isTest: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: "is_test",
    },

    calculationSnapshot: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: "calculation_snapshot",
    },
  },
  {
    tableName: "installment_plans",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: "updated_at",
    indexes: [
      { fields: ["core_id"] },
      { fields: ["status"] },
      { fields: ["core_id", "status"] },
      { fields: ["next_event_at"] },
    ],
  },
);

module.exports = InstallmentPlan;
