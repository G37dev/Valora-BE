/*
 * Loyalty & Referral Engine — approved commercial baseline
 * (VIVALORA Loyalty & Referral Developer Brief V1.1, 22 Oct 2026).
 *
 * Nilai di sini adalah IMPLEMENTATION DEFAULT yang di-seed sebagai config
 * version 1. Nilai efektif SELALU dibaca dari loyalty_config_versions
 * (versioned, effective_at) — jangan pakai konstanta ini langsung di engine.
 *
 * Rate disimpan dalam BPS (0,10% = 10 bps; 2% = 200 bps). Uang = integer IDR.
 */

const RULES_VERSION = "LOYALTY-1.1";

const TIER = Object.freeze({
  CADET: "CADET",
  JUNIOR: "JUNIOR",
  SENIOR: "SENIOR",
  COMMANDER: "COMMANDER",
});
const TIER_ORDER = Object.freeze([TIER.CADET, TIER.JUNIOR, TIER.SENIOR, TIER.COMMANDER]);

const FEATURE = Object.freeze({
  DEPOSIT: "DEPOSIT",
  EARN: "EARN",
  LOAN: "LOAN",
  INSTALLMENT: "INSTALLMENT",
  SWAP: "SWAP",
  MONTHLY: "MONTHLY",
});

const CATEGORY = Object.freeze({
  FIRST_DEPOSIT: "FIRST_DEPOSIT",
  FQT: "FQT",
  REGULAR: "REGULAR",
  MONTHLY: "MONTHLY",
  MONTHLY_BOOSTER: "MONTHLY_BOOSTER",
  REFERRAL_DEPOSIT: "REFERRAL_DEPOSIT",
  REFERRAL_ACTIVATION: "REFERRAL_ACTIVATION",
});

// Acquisition budget vs transaction rewards dilaporkan terpisah (brief 10.3)
const ACQUISITION_CATEGORIES = Object.freeze([
  CATEGORY.FIRST_DEPOSIT,
  CATEGORY.FQT,
  CATEGORY.REFERRAL_DEPOSIT,
  CATEGORY.REFERRAL_ACTIVATION,
]);

const VP_STATE = Object.freeze({
  PENDING: "PENDING",
  AVAILABLE: "AVAILABLE",
  VOID: "VOID",
  REVERSED: "REVERSED",
});
const IDR_STATE = Object.freeze({
  PENDING: "PENDING",
  CLAIMABLE: "CLAIMABLE",
  CLAIMING: "CLAIMING",
  CLAIMED: "CLAIMED",
  VOID: "VOID",
});
const BUCKET = Object.freeze({
  PENDING: "PENDING",
  AVAILABLE: "AVAILABLE",
  RESERVED: "RESERVED",
  REDEEMED: "REDEEMED",
  CLAIMABLE: "CLAIMABLE",
  CLAIMED: "CLAIMED",
});
const FQT_SLOT = Object.freeze({
  UNUSED: "UNUSED",
  CONSUMED_PENDING: "CONSUMED_PENDING",
  CONSUMED_AVAILABLE: "CONSUMED_AVAILABLE",
  CONSUMED_VOID: "CONSUMED_VOID",
});

// Event taxonomy yang diterima engine (brief 12.2, dinormalisasi)
const EVENT = Object.freeze({
  CUSTOMER_REGISTERED: "CUSTOMER_REGISTERED",
  DEPOSIT_CONFIRMED: "DEPOSIT_CONFIRMED",
  DEPOSIT_REVERSED: "DEPOSIT_REVERSED",
  POSITION_OPENED: "POSITION_OPENED", // EARN | LOAN | INSTALLMENT
  FEE_RECOGNIZED: "FEE_RECOGNIZED", // Loan Add Debt (fee tambahan di posisi yang sama)
  POSITION_SETTLED: "POSITION_SETTLED", // healthy completion
  POSITION_FAILED: "POSITION_FAILED", // liquidated / cancelled / default
  SWAP_SETTLED: "SWAP_SETTLED",
  SWAP_REVERSED: "SWAP_REVERSED",
});

// Fee codes yang boleh didiskon VP (brief 9.1)
const FEE_CODE = Object.freeze({
  EARN_PROTOCOL: "EARN_PROTOCOL",
  LOAN_PROTOCOL: "LOAN_PROTOCOL",
  INSTALLMENT_PROTOCOL: "INSTALLMENT_PROTOCOL",
  SWAP_PLATFORM: "SWAP_PLATFORM",
});

const DEFAULT_CONFIG = Object.freeze({
  referral: {
    enabled: true,
    deposit_rate_bps: 10, // 0,10% first qualifying deposit B
    deposit_cap_idr: 20000,
    activation_rate_bps: 5, // 0,05% first qualified Earn/Loan/Installment B
    activation_cap_idr: 10000,
    first_deposit_window_hours: 168, // 7 x 24h dari account_created_at
    validation_hold_hours: 168, // PENDING_VALIDATION -> CLAIMABLE (reversal/fraud window)
    allow_bind_after_signup_hours: 168, // kode boleh di-bind setelah daftar selama belum deposit & masih dalam window
  },
  first_deposit: {
    enabled: true,
    rate_bps: 5, // 0,05%
    cap_vp: 10000,
    min_deposit_idr: 200000,
    pending_hold_hours: 168, // 7 hari setelah successful deposit
    accepted_assets: ["IDR", "USDT", "USDC", "XAUT", "GOLD"],
    allow_external_crypto: true,
  },
  first_qualified: {
    enabled: true,
    rate_bps: 10, // 0,10% x qualified amount x tier multiplier
    cap_vp: 15000,
    min_qualified_amount_idr: 2000000,
    supported_features: ["EARN", "LOAN", "INSTALLMENT"],
    loan_xaut_min_ltv_bps: 3250, // LOYALTY filter saja — bukan aturan Loan
    loan_vvlr_min_ltv_bps: 3000,
    vesting_rule: "PRODUCT_COMPLETION",
  },
  regular: {
    enabled: true,
    base_rate_bps: 200, // 2% x eligible net platform fee x tier multiplier
    eligible_features: ["EARN", "LOAN", "INSTALLMENT", "SWAP"],
    vp_discount_deduction: true, // cash-paid fee = gross - VP discount
    // Fee basis per produk dibaca dari event produk (authoritative); nilai ini
    // hanya fallback untuk Earn yang fee-nya dipotong on-chain (platformFeeBps).
    earn_fee_fallback_bps: 35,
    platform_cost_categories: ["GAS", "RELAYER", "GATEWAY", "DEX", "EXECUTION"],
    settlement_event_mapping: {
      EARN: "EARN_CLAIM_SETTLED",
      LOAN: "LOAN_FULLY_SETTLED",
      INSTALLMENT: "GOLD_CLAIM_SETTLED",
      SWAP: "SWAP_SETTLED",
    },
  },
  monthly: {
    enabled: true,
    min_tx_count: 3,
    min_net_fee_idr: 30000,
    base_bonus_vp: 3000,
    junior_plus_booster_vp: 500,
    period_timezone: "Asia/Jakarta",
  },
  membership: {
    twab_window_hours: 720, // 30 x 24h rolling
    full_initial_history: true,
    tiers: [
      { code: "CADET", threshold_idr: 0, multiplier_bps: 10000, benefits: ["STARTER_REWARDS"] },
      { code: "JUNIOR", threshold_idr: 1000000, multiplier_bps: 12500, benefits: ["MONTHLY_BOOSTER"] },
      { code: "SENIOR", threshold_idr: 25000000, multiplier_bps: 15000, benefits: ["MONTHLY_BOOSTER", "PRIORITY_SUPPORT"] },
      { code: "COMMANDER", threshold_idr: 100000000, multiplier_bps: 20000, benefits: ["MONTHLY_BOOSTER", "PRIORITY_SUPPORT", "PRIVATE_CIRCLE"] },
    ],
    price_max_age_ms: 24 * 60 * 60 * 1000, // di atas ini valuation DEFERRED (tidak minting value)
    snapshot_min_interval_ms: 6 * 60 * 60 * 1000, // anchor time-series minimal tiap 6 jam walau saldo tak berubah
    xaut_grams_per_token: "31.1035",
  },
  redemption: {
    enabled: true,
    global_fee_discount_cap_bps: 4000, // 40% semua tier
    vp_idr_value: 1, // 1 VP = Rp1 (face value fee discount)
    eligible_fee_codes: ["EARN_PROTOCOL", "LOAN_PROTOCOL", "INSTALLMENT_PROTOCOL", "SWAP_PLATFORM"],
    quote_ttl_seconds: 120,
    reservation_ttl_seconds: 900,
    catalog_enabled: true,
  },
  budgets: {
    acquisition_budget_monthly_idr: null, // null = belum di-set (warn only)
    transaction_reward_guardrail_bps: 2000, // 20% eligible contribution (design guardrail)
    campaign_ceiling_idr: null,
    pause_issuance: false, // Emergency Pause: stop grant baru
    pause_redemption: false, // Emergency Pause: stop redeem baru (claimable tetap ada)
  },
});

module.exports = {
  RULES_VERSION,
  TIER,
  TIER_ORDER,
  FEATURE,
  CATEGORY,
  ACQUISITION_CATEGORIES,
  VP_STATE,
  IDR_STATE,
  BUCKET,
  FQT_SLOT,
  EVENT,
  FEE_CODE,
  DEFAULT_CONFIG,
};
