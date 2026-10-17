/*
 * Risk policy versions (CONFIGURABLE, brief 19/21).
 *
 * Policy efektif = versi APPROVED terbaru dengan effective_at <= now.
 * Jika belum ada, seed otomatis dari default brief (LOAN-1.0).
 * Posisi existing menyimpan APR snapshot sendiri; threshold berlaku dari
 * policy aktif (admin wajib pakai impact simulation sebelum approve).
 */

const { Op } = require("sequelize");
const { LoanRiskPolicyVersion } = require("../../models");
const { RULES_VERSION, APR_BPS, RISK, RULES } = require("./loan.constants");
const { LoanError, toJsonSafe } = require("./loan.errors");

const CACHE_TTL_MS = 5000;
let cache = { at: 0, now: 0, policy: null };

const DEFAULTS = Object.freeze({
  version: RULES_VERSION,
  aprBps: APR_BPS,
  risk: RISK,
  rules: RULES,
});

function materialize(row) {
  const merge = (base, over) => ({ ...base, ...(over || {}) });
  const risk = {};
  for (const asset of Object.keys(RISK)) {
    risk[asset] = merge(RISK[asset], row.risk?.[asset]);
  }
  const aprBps = {};
  for (const asset of Object.keys(APR_BPS)) {
    aprBps[asset] = merge(APR_BPS[asset], row.aprBps?.[asset]);
  }
  return {
    id: row.id,
    version: row.version,
    effectiveAt: row.effectiveAt,
    aprBps,
    risk,
    rules: merge(RULES, row.rules),
  };
}

async function seedDefault(transaction) {
  const [row] = await LoanRiskPolicyVersion.findOrCreate({
    where: { version: DEFAULTS.version },
    defaults: {
      version: DEFAULTS.version,
      aprBps: toJsonSafe(DEFAULTS.aprBps),
      risk: toJsonSafe(DEFAULTS.risk),
      rules: toJsonSafe(DEFAULTS.rules),
      effectiveAt: new Date(0),
      approvedBy: "brief-v1.0",
      status: "APPROVED",
      note: "Seeded from Loan Developer Brief V1.0 FINAL",
    },
    transaction,
  });
  return row;
}

async function getActivePolicy(now = new Date(), { transaction } = {}) {
  const t = now.getTime();
  if (
    !transaction &&
    cache.policy &&
    Date.now() - cache.at < CACHE_TTL_MS &&
    Math.abs(cache.now - t) < CACHE_TTL_MS
  ) {
    return cache.policy;
  }
  let row = await LoanRiskPolicyVersion.findOne({
    where: { status: "APPROVED", effectiveAt: { [Op.lte]: now } },
    order: [["effective_at", "DESC"]],
    transaction,
  });
  if (!row) row = await seedDefault(transaction);
  const policy = materialize(row);
  if (!transaction) cache = { at: Date.now(), now: t, policy };
  return policy;
}

function invalidate() {
  cache = { at: 0, now: 0, policy: null };
}

/** Admin: buat versi baru (approved, effective_at). Validasi dasar. */
async function createPolicyVersion(body, actor) {
  const version = String(body.version || "").trim();
  if (!version) {
    throw new LoanError("version is required", { code: "INVALID_POLICY" });
  }
  const effectiveAt = body.effective_at ? new Date(body.effective_at) : new Date();
  if (Number.isNaN(effectiveAt.getTime())) {
    throw new LoanError("effective_at invalid", { code: "INVALID_POLICY" });
  }
  // Sanity: thresholds harus monoton initial < margin < liquidation (< emergency)
  for (const [asset, r] of Object.entries(body.risk || {})) {
    const base = { ...RISK[asset], ...r };
    if (!RISK[asset]) {
      throw new LoanError(`Unknown asset in risk: ${asset}`, { code: "INVALID_POLICY" });
    }
    const chain = [base.initialLtvBps, base.marginCallBps, base.liquidationBps];
    if (base.emergencyBps) chain.push(base.emergencyBps);
    for (let i = 1; i < chain.length; i += 1) {
      if (!(Number(chain[i]) > Number(chain[i - 1]))) {
        throw new LoanError(
          `${asset}: initial < margin < liquidation (< emergency) must hold`,
          { code: "INVALID_POLICY" },
        );
      }
    }
    if (Number(base.postReleaseMaxBps) > Number(base.initialLtvBps)) {
      throw new LoanError(`${asset}: postReleaseMaxBps must be <= initialLtvBps`, {
        code: "INVALID_POLICY",
      });
    }
  }
  const row = await LoanRiskPolicyVersion.create({
    version,
    aprBps: body.apr_bps || {},
    risk: body.risk || {},
    rules: body.rules || {},
    effectiveAt,
    approvedBy: body.approved_by || actor || null,
    updatedBy: actor || null,
    note: body.note || null,
    status: body.status === "DRAFT" ? "DRAFT" : "APPROVED",
  });
  invalidate();
  return materialize(row);
}

async function listPolicyVersions() {
  const rows = await LoanRiskPolicyVersion.findAll({
    order: [["effective_at", "DESC"]],
  });
  return rows.map(materialize);
}

module.exports = {
  DEFAULTS,
  getActivePolicy,
  createPolicyVersion,
  listPolicyVersions,
  invalidate,
};
