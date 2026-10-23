/*
 * Versioned admin configuration (brief 11).
 *
 * Workflow: DRAFT -> REVIEW -> APPROVED -> SCHEDULED (effective_at) -> ACTIVE
 * -> SUPERSEDED. Versi sebelumnya tidak pernah diubah/dihapus.
 *
 * resolve(now) mengembalikan versi dengan effective_at <= now yang paling
 * baru (status APPROVED/SCHEDULED/ACTIVE/SUPERSEDED). Reward yang sudah
 * diterbitkan menyimpan config_version-nya sendiri (snapshot) sehingga
 * perubahan config hanya prospektif.
 */

const { Op } = require("sequelize");
const { LoyaltyConfigVersion } = require("../../models");
const { DEFAULT_CONFIG } = require("./loyalty.constants");
const { LoyaltyError } = require("./loyalty.errors");

const EFFECTIVE_STATUSES = ["APPROVED", "SCHEDULED", "ACTIVE", "SUPERSEDED"];
const CACHE_TTL_MS = 5000;
let cache = { at: 0, rows: null };

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch.slice();
  if (patch && typeof patch === "object") {
    const out = { ...(base && typeof base === "object" ? base : {}) };
    for (const [k, v] of Object.entries(patch)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return patch === undefined ? base : patch;
}

function validate(config) {
  const errors = [];
  const num = (path, v, { min = 0, max = Infinity } = {}) => {
    if (v === null || v === undefined) return;
    if (typeof v !== "number" || Number.isNaN(v) || v < min || v > max) {
      errors.push(`${path} harus angka ${min}..${max === Infinity ? "∞" : max}`);
    }
  };
  num("referral.deposit_rate_bps", config.referral?.deposit_rate_bps, { max: 10000 });
  num("referral.activation_rate_bps", config.referral?.activation_rate_bps, { max: 10000 });
  num("first_deposit.rate_bps", config.first_deposit?.rate_bps, { max: 10000 });
  num("first_qualified.rate_bps", config.first_qualified?.rate_bps, { max: 10000 });
  num("regular.base_rate_bps", config.regular?.base_rate_bps, { max: 10000 });
  num("redemption.global_fee_discount_cap_bps", config.redemption?.global_fee_discount_cap_bps, { max: 10000 });
  num("budgets.transaction_reward_guardrail_bps", config.budgets?.transaction_reward_guardrail_bps, { max: 10000 });
  const tiers = config.membership?.tiers;
  if (!Array.isArray(tiers) || tiers.length < 1) errors.push("membership.tiers wajib array");
  else {
    let prev = -1;
    for (const t of tiers) {
      if (!t.code || typeof t.threshold_idr !== "number" || typeof t.multiplier_bps !== "number") {
        errors.push(`tier ${t.code || "?"} tidak lengkap`);
      } else if (t.threshold_idr <= prev) {
        errors.push("membership.tiers threshold harus menaik");
      }
      prev = t.threshold_idr;
    }
  }
  if (errors.length) {
    throw new LoyaltyError("Config tidak valid", { code: "CONFIG_INVALID", details: { errors } });
  }
}

/** Seed versi 1 (approved baseline) kalau tabel kosong. */
async function ensureSeed() {
  const count = await LoyaltyConfigVersion.count();
  if (count > 0) return;
  await LoyaltyConfigVersion.findOrCreate({
    where: { version: 1 },
    defaults: {
      version: 1,
      status: "ACTIVE",
      config: DEFAULT_CONFIG,
      effectiveAt: new Date("2026-10-22T00:00:00Z"),
      note: "Approved commercial baseline — Developer Brief V1.1 (22 Oct 2026)",
      createdBy: "system",
      approvedBy: "client-approval:brief-v1.1",
      approvedAt: new Date("2026-10-22T00:00:00Z"),
    },
  });
}

async function loadRows() {
  if (cache.rows && Date.now() - cache.at < CACHE_TTL_MS) return cache.rows;
  await ensureSeed();
  const rows = await LoyaltyConfigVersion.findAll({
    where: { status: { [Op.in]: EFFECTIVE_STATUSES } },
    order: [["effective_at", "DESC"], ["version", "DESC"]],
  });
  cache = { at: Date.now(), rows };
  return rows;
}

function invalidate() {
  cache = { at: 0, rows: null };
}

/**
 * Config efektif pada `now`. Return { row, config } — config sudah
 * di-merge di atas DEFAULT agar key baru selalu ada.
 */
async function resolve(now = new Date()) {
  const rows = await loadRows();
  const row =
    rows.find((r) => r.effectiveAt && new Date(r.effectiveAt).getTime() <= now.getTime()) ||
    rows[rows.length - 1];
  const config = deepMerge(DEFAULT_CONFIG, row?.config || {});
  return { row, config, version: row?.version ?? 0, versionId: row?.id ?? null };
}

function tierTable(config) {
  return (config.membership?.tiers || DEFAULT_CONFIG.membership.tiers)
    .slice()
    .sort((a, b) => a.threshold_idr - b.threshold_idr);
}

function tierMultiplierBps(config, tierCode) {
  const t = tierTable(config).find((x) => x.code === tierCode);
  return t ? t.multiplier_bps : 10000;
}

function tierRank(config, tierCode) {
  return tierTable(config).findIndex((x) => x.code === tierCode);
}

// ---------------- Admin workflow ----------------

async function listVersions() {
  return LoyaltyConfigVersion.findAll({ order: [["version", "DESC"]] });
}

async function createDraft({ patch, note, createdBy, ticketRef, baseVersion }) {
  const base = baseVersion
    ? await LoyaltyConfigVersion.findOne({ where: { version: baseVersion } })
    : (await resolve()).row;
  const merged = deepMerge(deepMerge(DEFAULT_CONFIG, base?.config || {}), patch || {});
  validate(merged);
  const maxVersion = (await LoyaltyConfigVersion.max("version")) || 0;
  return LoyaltyConfigVersion.create({
    version: maxVersion + 1,
    status: "DRAFT",
    config: merged,
    note,
    ticketRef,
    createdBy,
    previousVersionId: base?.id || null,
    diff: patch || null,
  });
}

async function transition({ version, action, actor, effectiveAt }) {
  const row = await LoyaltyConfigVersion.findOne({ where: { version } });
  if (!row) throw new LoyaltyError("Config version tidak ditemukan", { status: 404, code: "CONFIG_NOT_FOUND" });
  const allowed = {
    DRAFT: { submit: "REVIEW", reject: "REJECTED" },
    REVIEW: { approve: "APPROVED", reject: "REJECTED" },
    APPROVED: { schedule: "SCHEDULED", reject: "REJECTED" },
    SCHEDULED: { rollback: "REJECTED" },
  };
  const next = allowed[row.status]?.[action];
  if (!next) {
    throw new LoyaltyError(`Aksi ${action} tidak diizinkan dari status ${row.status}`, {
      code: "CONFIG_TRANSITION_INVALID",
    });
  }
  const patch = { status: next };
  if (action === "submit") patch.reviewedBy = actor;
  if (action === "approve") {
    if (row.createdBy && actor && row.createdBy === actor) {
      throw new LoyaltyError("Approver harus berbeda dari pembuat draft (segregation of duties)", {
        code: "CONFIG_SOD",
      });
    }
    patch.approvedBy = actor;
    patch.approvedAt = new Date();
  }
  if (action === "schedule") {
    const eff = new Date(effectiveAt);
    if (!effectiveAt || Number.isNaN(eff.getTime())) {
      throw new LoyaltyError("effective_at wajib datetime valid", { code: "CONFIG_EFFECTIVE_AT" });
    }
    if (eff.getTime() < Date.now() - 60_000) {
      throw new LoyaltyError("effective_at tidak boleh di masa lalu (perubahan hanya prospektif)", {
        code: "CONFIG_RETROACTIVE",
      });
    }
    patch.effectiveAt = eff;
  }
  if (action === "rollback" && row.effectiveAt && new Date(row.effectiveAt).getTime() <= Date.now()) {
    throw new LoyaltyError("Versi yang sudah efektif tidak bisa di-rollback; buat versi baru", {
      code: "CONFIG_ALREADY_EFFECTIVE",
    });
  }
  await row.update(patch);
  invalidate();
  return row;
}

/** Scheduler: tandai SCHEDULED yang sudah lewat effective_at sebagai ACTIVE, yang lama SUPERSEDED. */
async function promoteScheduled(now = new Date()) {
  const due = await LoyaltyConfigVersion.findAll({
    where: { status: "SCHEDULED", effectiveAt: { [Op.lte]: now } },
  });
  if (!due.length) return 0;
  await LoyaltyConfigVersion.update(
    { status: "SUPERSEDED" },
    { where: { status: "ACTIVE" } },
  );
  const latest = due.sort((a, b) => b.effectiveAt - a.effectiveAt)[0];
  await latest.update({ status: "ACTIVE" });
  for (const d of due) if (d.id !== latest.id) await d.update({ status: "SUPERSEDED" });
  invalidate();
  return due.length;
}

module.exports = {
  resolve,
  invalidate,
  validate,
  deepMerge,
  tierTable,
  tierMultiplierBps,
  tierRank,
  listVersions,
  createDraft,
  transition,
  promoteScheduled,
  ensureSeed,
};
