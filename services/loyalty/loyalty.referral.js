/*
 * Referral Service (brief 04): direct A->B only, IDR cashback, manual claim.
 *
 * - Satu referrer per B; relasi immutable setelah valid.
 * - Self-referral, circular (A<-B), dan multi-hop dilarang.
 * - Claim All: server-side amount, row lock, idempotency key, satu posting
 *   financial ledger (InternalTransaction) per claim. Retry dengan key sama
 *   mengembalikan hasil claim sebelumnya (exactly-once effect).
 */

const crypto = require("crypto");
const Decimal = require("decimal.js");
const { Op } = require("sequelize");
const {
  sequelize,
  User,
  KycProfile,
  InternalWallet,
  InternalTransaction,
  LoyaltyCustomer,
  LoyaltyReferralCode,
  LoyaltyReferralLink,
  LoyaltyRewardGrant,
  LoyaltyRewardClaim,
} = require("../../models");
const configSvc = require("./loyalty.config");
const ledger = require("./loyalty.ledger");
const { LoyaltyError, big, toJsonSafe } = require("./loyalty.errors");
const { IDR_STATE, BUCKET, CATEGORY } = require("./loyalty.constants");

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // tanpa 0/O/1/I
const REQUIRE_KYC = String(process.env.LOYALTY_CLAIM_REQUIRE_KYC || "1") !== "0";

function randomCode(len = 8) {
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

const normalizeCode = (c) => String(c || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

async function getOrCreateCode(coreId, { transaction } = {}) {
  let row = await LoyaltyReferralCode.findOne({ where: { coreId }, transaction });
  if (row) return row;
  for (let i = 0; i < 5; i++) {
    try {
      row = await LoyaltyReferralCode.create({ coreId, code: randomCode() }, { transaction });
      return row;
    } catch (error) {
      row = await LoyaltyReferralCode.findOne({ where: { coreId }, transaction });
      if (row) return row;
    }
  }
  throw new LoyaltyError("Gagal membuat kode referral", { status: 500, code: "REFERRAL_CODE_GEN" });
}

/** Validasi kode tanpa binding (preflight registrasi). */
async function resolveCode(code, { transaction } = {}) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  return LoyaltyReferralCode.findOne({ where: { code: normalized, active: true }, transaction });
}

/**
 * Bind B (referee) ke A via kode. Dipanggil saat registrasi (dalam
 * transaction yang sama) atau via POST /referrals/bind sesudahnya selama
 * B belum deposit dan masih dalam window.
 */
async function bind({ refereeCoreId, code, now = new Date(), transaction, source = "SIGNUP" }) {
  const run = async (t) => {
    const { config } = await configSvc.resolve(now);
    if (config.referral?.enabled === false) {
      throw new LoyaltyError("Program referral sedang tidak aktif", { code: "REFERRAL_DISABLED" });
    }
    const codeRow = await resolveCode(code, { transaction: t });
    if (!codeRow) {
      throw new LoyaltyError("Kode referral tidak valid", { status: 404, code: "REFERRAL_CODE_INVALID" });
    }
    const referrerCoreId = codeRow.coreId;
    if (referrerCoreId === refereeCoreId) {
      throw new LoyaltyError("Tidak bisa memakai kode referral sendiri", { code: "REFERRAL_SELF" });
    }
    const existing = await LoyaltyReferralLink.findOne({ where: { refereeCoreId }, transaction: t });
    if (existing) {
      if (existing.referrerCoreId === referrerCoreId) return { link: existing, created: false };
      throw new LoyaltyError("Akun sudah terhubung ke referrer lain", { status: 409, code: "REFERRAL_ALREADY_BOUND" });
    }
    // Circular: A adalah referee dari B
    const reverse = await LoyaltyReferralLink.findOne({
      where: { refereeCoreId: referrerCoreId, referrerCoreId: refereeCoreId },
      transaction: t,
    });
    if (reverse) throw new LoyaltyError("Referral melingkar tidak diizinkan", { code: "REFERRAL_CIRCULAR" });

    const cust = await ledger.ensureCustomer(refereeCoreId, { now, transaction: t, lock: true });
    if (source !== "SIGNUP") {
      if (cust.firstDepositConsumedAt) {
        throw new LoyaltyError("Kode referral harus dipakai sebelum deposit pertama", { code: "REFERRAL_AFTER_DEPOSIT" });
      }
      const hours = Number(config.referral?.allow_bind_after_signup_hours ?? 168);
      const created = new Date(cust.accountCreatedAt || cust.enrolledAt).getTime();
      if (now.getTime() - created > hours * 3600 * 1000) {
        throw new LoyaltyError("Masa berlaku penggunaan kode referral sudah lewat", { code: "REFERRAL_WINDOW_EXPIRED" });
      }
    }
    await ledger.ensureCustomer(referrerCoreId, { now, transaction: t });
    const link = await LoyaltyReferralLink.create(
      {
        refereeCoreId,
        referrerCoreId,
        referralCodeId: codeRow.id,
        code: codeRow.code,
        status: "VALID",
        linkedAt: now,
        validatedAt: now,
        metadata: { source },
      },
      { transaction: t },
    );
    return { link, created: true };
  };
  return transaction ? run(transaction) : sequelize.transaction(run);
}

// ---------------------------------------------------------------------------
// Summary & history
// ---------------------------------------------------------------------------

function maskName(user) {
  const first = (user?.firstName || "").trim();
  if (!first) return "Invitee";
  return `${first[0]}${"*".repeat(Math.max(2, first.length - 1))}`;
}

async function summary(coreId, { now = new Date() } = {}) {
  const { config } = await configSvc.resolve(now);
  const codeRow = await getOrCreateCode(coreId);
  const links = await LoyaltyReferralLink.findAll({ where: { referrerCoreId: coreId }, order: [["linked_at", "DESC"]] });
  const balances = await ledger.idrBalances(coreId);
  const grants = await LoyaltyRewardGrant.findAll({
    where: { coreId, unit: "IDR", category: { [Op.in]: [CATEGORY.REFERRAL_DEPOSIT, CATEGORY.REFERRAL_ACTIVATION] } },
    order: [["occurred_at", "DESC"]],
  });
  const users = await User.findAll({ where: { coreId: { [Op.in]: links.map((l) => l.refereeCoreId) } } });
  const userMap = Object.fromEntries(users.map((u) => [u.coreId, u]));
  const byReferee = {};
  for (const g of grants) {
    const b = g.counterpartyCoreId || "unknown";
    byReferee[b] = byReferee[b] || { pending: 0n, claimable: 0n, claimed: 0n, void: 0n };
    const amt = big(g.idrAmount);
    if (g.state === IDR_STATE.PENDING) byReferee[b].pending += amt;
    else if (g.state === IDR_STATE.CLAIMABLE || g.state === IDR_STATE.CLAIMING) byReferee[b].claimable += amt;
    else if (g.state === IDR_STATE.CLAIMED) byReferee[b].claimed += amt;
    else byReferee[b].void += amt;
  }
  const claims = await LoyaltyRewardClaim.findAll({ where: { coreId }, order: [["created_at", "DESC"]], limit: 20 });
  const windowHours = Number(config.referral?.first_deposit_window_hours ?? 168);
  const myLink = await LoyaltyReferralLink.findOne({ where: { refereeCoreId: coreId } });

  return toJsonSafe({
    code: codeRow.code,
    share_link: `${process.env.REFERRAL_LINK_BASE || "https://valora-be.vercel.app/r"}/${codeRow.code}`,
    program: {
      deposit_rate_bps: config.referral.deposit_rate_bps,
      deposit_cap_idr: config.referral.deposit_cap_idr,
      activation_rate_bps: config.referral.activation_rate_bps,
      activation_cap_idr: config.referral.activation_cap_idr,
      first_deposit_window_hours: windowHours,
      min_qualifying_deposit_idr: config.first_deposit.min_deposit_idr,
      claimable_expiry: null,
    },
    referred_by: myLink ? { code: myLink.code, linked_at: myLink.linkedAt } : null,
    totals: {
      invited: links.length,
      deposit_qualified: links.filter((l) => l.depositQualified).length,
      activated: links.filter((l) => l.activationState === "GRANTED").length,
      pending_idr: balances.pending,
      claimable_idr: balances.claimable,
      claimed_idr: balances.claimed,
    },
    invitees: links.map((l) => {
      const u = userMap[l.refereeCoreId];
      const agg = byReferee[l.refereeCoreId] || { pending: 0n, claimable: 0n, claimed: 0n, void: 0n };
      const deadline = new Date(new Date(u?.createdAt || l.linkedAt).getTime() + windowHours * 3600 * 1000);
      return {
        display_name: maskName(u),
        joined_at: u?.createdAt || l.linkedAt,
        deposit_status: l.depositQualified
          ? "QUALIFIED"
          : l.depositOpportunityUsed
            ? "NOT_QUALIFIED"
            : now > deadline
              ? "WINDOW_EXPIRED"
              : "WAITING_DEPOSIT",
        deposit_deadline: l.depositQualified || l.depositOpportunityUsed ? null : deadline,
        activation_status: l.activationState,
        rewards: agg,
      };
    }),
    claims: claims.map((c) => ({
      claim_id: c.id,
      amount_idr: c.amountIdr,
      state: c.state,
      wallet_posting_id: c.walletPostingId,
      claimed_at: c.claimedAt,
      created_at: c.createdAt,
      failure_reason: c.failureReason,
    })),
  });
}

// ---------------------------------------------------------------------------
// Claim All — atomic, idempotent
// ---------------------------------------------------------------------------

async function assertClaimEligible(coreId, transaction) {
  if (!REQUIRE_KYC) return;
  const kyc = await KycProfile.findOne({ where: { core_id: coreId }, transaction }).catch(() => null);
  if (!kyc || String(kyc.status).toUpperCase() !== "VERIFIED") {
    throw new LoyaltyError("KYC harus terverifikasi sebelum klaim referral", {
      status: 403,
      code: "KYC_REQUIRED",
    });
  }
}

async function claimAll({ coreId, idempotencyKey, now = new Date() }) {
  if (!idempotencyKey || String(idempotencyKey).length < 8) {
    throw new LoyaltyError("idempotency_key wajib (min 8 karakter)", { code: "IDEMPOTENCY_KEY_REQUIRED" });
  }
  const key = `${coreId}:${idempotencyKey}`;
  const { config } = await configSvc.resolve(now);

  return sequelize.transaction(async (t) => {
    // 1. Replay? kembalikan hasil sebelumnya
    const prior = await LoyaltyRewardClaim.findOne({ where: { clientIdempotencyKey: key }, transaction: t });
    if (prior) return { claim: prior, replay: true };

    // 2. Lock customer row -> serialisasi claim concurrent per user
    await ledger.ensureCustomer(coreId, { now, transaction: t, lock: true });
    await assertClaimEligible(coreId, t);

    // 3. Lock grant CLAIMABLE
    const grants = await LoyaltyRewardGrant.findAll({
      where: { coreId, unit: "IDR", state: IDR_STATE.CLAIMABLE },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const amount = grants.reduce((s, g) => s + big(g.idrAmount), 0n);
    if (amount <= 0n) {
      throw new LoyaltyError("Tidak ada referral cashback yang bisa diklaim", { status: 409, code: "NOTHING_TO_CLAIM" });
    }

    // 4. Buat claim CLAIMING + tandai grants CLAIMING
    const claim = await LoyaltyRewardClaim.create(
      { coreId, amountIdr: amount.toString(), state: "CLAIMING", clientIdempotencyKey: key, grantIds: grants.map((g) => g.id) },
      { transaction: t },
    );
    await LoyaltyRewardGrant.update(
      { state: IDR_STATE.CLAIMING, claimId: claim.id },
      { where: { id: { [Op.in]: grants.map((g) => g.id) } }, transaction: t },
    );

    // 5. Posting financial ledger (satu credit) — lock wallet
    let wallet = await InternalWallet.findOne({ where: { coreId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!wallet) wallet = await InternalWallet.create({ coreId, balanceIdr: 0 }, { transaction: t });
    const before = new Decimal(wallet.balanceIdr || 0);
    const after = before.plus(amount.toString());
    await wallet.update({ balanceIdr: after.toFixed(2) }, { transaction: t });
    const posting = await InternalTransaction.create(
      {
        internalWalletId: wallet.id,
        coreId,
        type: "CREDIT",
        asset: "IDR",
        amount: new Decimal(amount.toString()).toFixed(2),
        balanceBefore: before.toFixed(2),
        balanceAfter: after.toFixed(2),
        reference: `LOYALTY-REFERRAL-CLAIM-${claim.id}`,
        status: "SUCCESS",
        description: `Referral cashback claim (${grants.length} reward)`,
        metadata: { loyalty_claim_id: claim.id, grant_ids: grants.map((g) => g.id) },
      },
      { transaction: t },
    );

    // 6. Jurnal CLAIMABLE -> CLAIMED per grant + grants CLAIMED
    for (const g of grants) {
      const amt = big(g.idrAmount);
      const linkId = g.metadata?.link_id || null;
      await ledger.postIdr(
        { coreId, grantId: g.id, linkId, claimId: claim.id, bucket: BUCKET.CLAIMABLE, deltaIdr: -amt, reasonCode: "REFERRAL_CLAIM", idempotencyKey: `claim:${claim.id}:${g.id}:claimable` },
        t,
      );
      await ledger.postIdr(
        { coreId, grantId: g.id, linkId, claimId: claim.id, bucket: BUCKET.CLAIMED, deltaIdr: amt, reasonCode: "REFERRAL_CLAIM", idempotencyKey: `claim:${claim.id}:${g.id}:claimed` },
        t,
      );
      await g.update({ state: IDR_STATE.CLAIMED, claimId: claim.id }, { transaction: t });
    }
    await claim.update({ state: "CLAIMED", walletPostingId: posting.id, claimedAt: now }, { transaction: t });

    return { claim, posting, replay: false, config };
  });
  // Catatan: bila transaction gagal di tengah (wallet posting error/timeout),
  // seluruh perubahan di-rollback -> grant kembali CLAIMABLE, claim tidak
  // tercatat; client retry dengan key yang sama tanpa double credit.
}

async function claimHistory(coreId, { limit = 50 } = {}) {
  const claims = await LoyaltyRewardClaim.findAll({ where: { coreId }, order: [["created_at", "DESC"]], limit });
  return claims.map((c) => toJsonSafe({
    claim_id: c.id,
    amount_idr: c.amountIdr,
    state: c.state,
    wallet_posting_id: c.walletPostingId,
    claimed_at: c.claimedAt,
    created_at: c.createdAt,
    grant_count: Array.isArray(c.grantIds) ? c.grantIds.length : 0,
  }));
}

module.exports = {
  getOrCreateCode,
  resolveCode,
  normalizeCode,
  bind,
  summary,
  claimAll,
  claimHistory,
  LoyaltyCustomer,
};
