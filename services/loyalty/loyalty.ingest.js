/*
 * Event ingestion dari ledger produk (brief 2.1: product service = source of
 * truth; Loyalty hanya MEMBACA event valid). Produk frozen tidak diubah —
 * poller membaca tabel authoritative dengan cursor + overlap; dedupe by
 * (source_system, source_event_id) di engine.
 *
 * Sumber:
 *   topups (SUCCESS)                 -> DEPOSIT_CONFIRMED (IDR)
 *   Transactions (DEPOSIT, SUCCESS)  -> DEPOSIT_CONFIRMED (crypto)
 *   earn_positions ACTIVE / CLAIMED  -> POSITION_OPENED / POSITION_SETTLED
 *   loan_events                      -> POSITION_OPENED / FEE_RECOGNIZED / SETTLED / FAILED
 *   installment_events               -> POSITION_OPENED / SETTLED / FAILED
 *   swaps (SUCCESS)                  -> SWAP_SETTLED
 */

const Decimal = require("decimal.js");
const { Op } = require("sequelize");
const {
  TopUp,
  Transaction,
  EarnPosition,
  LoanEvent,
  LoanPosition,
  InstallmentEvent,
  InstallmentPlan,
  Swap,
  CronCheckpoint,
} = require("../../models");
const engine = require("./loyalty.engine");
const configSvc = require("./loyalty.config");
const pricing = require("./loyalty.pricing");
const { EVENT, FEATURE } = require("./loyalty.constants");
const { big } = require("./loyalty.errors");

const OVERLAP_MS = Number(
  process.env.LOYALTY_POLL_OVERLAP_MS || 10 * 60 * 1000,
);
const BATCH = Number(process.env.LOYALTY_POLL_BATCH || 200);
const EARN_TOKEN_DECIMALS = Number(
  process.env.LOYALTY_EARN_TOKEN_DECIMALS || 6,
);
const INITIAL_LOOKBACK_MS = Number(
  process.env.LOYALTY_INITIAL_LOOKBACK_MS || 0,
); // 0 = dari awal

async function readCursor(key) {
  const row = await CronCheckpoint.findOne({ where: { key } });
  if (row?.value) return new Date(row.value);
  return INITIAL_LOOKBACK_MS > 0
    ? new Date(Date.now() - INITIAL_LOOKBACK_MS)
    : new Date(0);
}
async function writeCursor(key, date) {
  await CronCheckpoint.upsert({ key, value: date.toISOString() });
}

const toDecStr = (v) => new Decimal(v || 0).toFixed();

async function run(label, envelopes) {
  const stats = { processed: 0, duplicate: 0, failed: 0 };
  for (const env of envelopes) {
    const r = await engine.ingest(env);
    if (r.status === "PROCESSED") stats.processed++;
    else if (r.status === "DUPLICATE") stats.duplicate++;
    else stats.failed++;
  }
  return { source: label, scanned: envelopes.length, ...stats };
}

// ---------------- Deposits ----------------

async function pollTopups(now) {
  const key = "loyalty:cursor:topups";
  const since = new Date((await readCursor(key)).getTime() - OVERLAP_MS);
  const rows = await TopUp.findAll({
    where: { status: "SUCCESS", updated_at: { [Op.gte]: since } },
    order: [["updated_at", "ASC"]],
    limit: BATCH,
  });
  const envs = rows.map((r) => ({
    source_system: "topup",
    source_event_id: `topup:${r.id}`,
    event_type: EVENT.DEPOSIT_CONFIRMED,
    core_id: r.coreId,
    occurred_at: r.paidAt || r.updated_at,
    asset: "IDR",
    amount: toDecStr(r.amountIdr),
    source_transaction_id: String(r.id),
    metadata: { provider: "MIDTRANS", payment_method: r.paymentMethod || null },
  }));
  const out = await run("topups", envs);
  if (rows.length)
    await writeCursor(key, new Date(rows[rows.length - 1].updated_at));
  else await writeCursor(key, now);
  return out;
}

async function pollChainDeposits(now) {
  const key = "loyalty:cursor:deposits";
  const since = new Date((await readCursor(key)).getTime() - OVERLAP_MS);
  const rows = await Transaction.findAll({
    where: {
      type: "DEPOSIT",
      status: "SUCCESS",
      updatedAt: { [Op.gte]: since },
    },
    order: [["updatedAt", "ASC"]],
    limit: BATCH,
  });
  const envs = rows.map((r) => ({
    source_system: "chain-deposit",
    source_event_id: `tx:${r.tx_hash}`,
    event_type: EVENT.DEPOSIT_CONFIRMED,
    core_id: r.core_id,
    occurred_at: r.createdAt, // waktu deposit masuk (konfirmasi menyusul)
    asset: pricing.normalizeAsset(r.asset),
    amount: toDecStr(r.amount),
    source_transaction_id: r.tx_hash,
    metadata: { block_number: r.tx_block_number },
  }));
  const out = await run("chain-deposits", envs);
  if (rows.length)
    await writeCursor(key, new Date(rows[rows.length - 1].updatedAt));
  else await writeCursor(key, now);
  return out;
}

// ---------------- Earn ----------------

async function pollEarn(now) {
  const key = "loyalty:cursor:earn";
  const since = new Date((await readCursor(key)).getTime() - OVERLAP_MS);
  const { config } = await configSvc.resolve(now);
  const rows = await EarnPosition.findAll({
    where: {
      status: { [Op.in]: ["ACTIVE", "CLAIMING", "CLAIMED"] },
      updated_at: { [Op.gte]: since },
    },
    order: [["updated_at", "ASC"]],
    limit: BATCH,
  });
  const envs = [];
  for (const e of rows) {
    const amount = pricing.fromRaw(e.principal, EARN_TOKEN_DECIMALS);
    const openedAt =
      e.completedAt && e.status === "ACTIVE" ? e.completedAt : e.created_at;
    const v = await pricing.valueIdr(e.asset, amount, {
      now: new Date(openedAt),
      config,
    });
    const feeBps = Number(config.regular?.earn_fee_fallback_bps ?? 35);
    const feeIdr = (v.idr * BigInt(feeBps)) / 10000n;
    envs.push({
      source_system: "earn",
      source_event_id: `earn:${e.id}:opened`,
      event_type: EVENT.POSITION_OPENED,
      core_id: e.coreId,
      occurred_at: openedAt,
      feature: FEATURE.EARN,
      position_ref: `earn:${e.id}`,
      source_transaction_id: e.txHash || String(e.id),
      qualified_amount_idr: v.idr.toString(),
      platform_fee_idr: feeIdr.toString(),
      external_cost_idr: "0",
      fee_code: "EARN_PROTOCOL",
      metadata: {
        asset: e.asset,
        amount,
        apr_bps: e.aprBps,
        term_code: e.termCode,
        price_status: v.status,
      },
    });
    if (e.status === "CLAIMED") {
      envs.push({
        source_system: "earn",
        source_event_id: `earn:${e.id}:settled`,
        event_type: EVENT.POSITION_SETTLED,
        core_id: e.coreId,
        occurred_at: e.completedAt || e.updated_at,
        feature: FEATURE.EARN,
        position_ref: `earn:${e.id}`,
        source_transaction_id: e.txHash || String(e.id),
      });
    }
  }
  const out = await run("earn", envs);
  if (rows.length)
    await writeCursor(key, new Date(rows[rows.length - 1].updated_at));
  else await writeCursor(key, now);
  return out;
}

// ---------------- Loan ----------------

const LOAN_MAP = {
  "loan.disbursement_confirmed": "OPENED",
  "loan.additional_drawdown": "FEE",
  "loan.completed": "SETTLED",
  "loan.auto_liquidated": "FAILED",
};

async function pollLoan(now) {
  const key = "loyalty:cursor:loan";
  const since = new Date((await readCursor(key)).getTime() - OVERLAP_MS);
  const rows = await LoanEvent.findAll({
    where: {
      eventType: { [Op.in]: Object.keys(LOAN_MAP) },
      created_at: { [Op.gte]: since },
    },
    order: [["created_at", "ASC"]],
    limit: BATCH,
  });
  const positions = {};
  for (const ev of rows) {
    if (!positions[ev.positionId])
      positions[ev.positionId] = await LoanPosition.findByPk(ev.positionId);
  }
  const envs = rows
    .map((ev) => {
      const p = positions[ev.positionId];
      if (!p) return null;
      const m = ev.metadata || {};
      const base = {
        source_system: "loan",
        source_event_id: `loanevt:${ev.id}`,
        core_id: ev.coreId || p.coreId,
        occurred_at: ev.effectiveAt,
        feature: FEATURE.LOAN,
        position_ref: `loan:${p.id}`,
        source_transaction_id: ev.sourceTxId || m.drawdown_id || String(ev.id),
        is_test: Boolean(p.isTest),
        collateral_asset: pricing.normalizeAsset(p.collateralAsset),
        fee_code: "LOAN_PROTOCOL",
      };
      switch (LOAN_MAP[ev.eventType]) {
        case "OPENED":
          return {
            ...base,
            event_type: EVENT.POSITION_OPENED,
            qualified_amount_idr: toDecStr(m.gross_idr ?? p.grossDisbursedIdr),
            platform_fee_idr: toDecStr(m.fee_idr ?? p.protocolFeeIdr),
            external_cost_idr: "0",
            initial_ltv_bps: p.initialLtvBps,
            metadata: { apr_bps: m.apr_bps, maturity_at: m.maturity_at },
          };
        case "FEE":
          return {
            ...base,
            event_type: EVENT.FEE_RECOGNIZED,
            platform_fee_idr: toDecStr(m.fee_idr),
            external_cost_idr: "0",
            metadata: {
              gross_idr: toDecStr(ev.amountIdr),
              drawdown_id: m.drawdown_id,
            },
          };
        case "SETTLED":
          return {
            ...base,
            event_type: EVENT.POSITION_SETTLED,
            metadata: { repayment_id: m.repayment_id },
          };
        case "FAILED":
          return {
            ...base,
            event_type: EVENT.POSITION_FAILED,
            reason: "LOAN_LIQUIDATED",
          };
        default:
          return null;
      }
    })
    .filter(Boolean);
  const out = await run("loan", envs);
  if (rows.length)
    await writeCursor(key, new Date(rows[rows.length - 1].created_at));
  else await writeCursor(key, now);
  return out;
}

// ---------------- Gold Installment ----------------

const INST_MAP = {
  "installment.activated": "OPENED",
  "installment.asset_released": "SETTLED",
  "installment.auto_liquidated": "FAILED",
  "installment.cancelled": "FAILED",
  "installment.cancellation_closed": "FAILED",
};

async function pollInstallment(now) {
  const key = "loyalty:cursor:installment";
  const since = new Date((await readCursor(key)).getTime() - OVERLAP_MS);
  const rows = await InstallmentEvent.findAll({
    where: {
      eventType: { [Op.in]: Object.keys(INST_MAP) },
      created_at: { [Op.gte]: since },
    },
    order: [["created_at", "ASC"]],
    limit: BATCH,
  });
  const plans = {};
  for (const ev of rows) {
    if (!plans[ev.planId])
      plans[ev.planId] = await InstallmentPlan.findByPk(ev.planId);
  }
  const envs = rows
    .map((ev) => {
      const pl = plans[ev.planId];
      if (!pl) return null;
      const base = {
        source_system: "installment",
        source_event_id: `instevt:${ev.id}`,
        core_id: ev.coreId || pl.coreId,
        occurred_at: ev.effectiveAt,
        feature: FEATURE.INSTALLMENT,
        position_ref: `installment:${pl.id}`,
        source_transaction_id: String(pl.id),
        is_test: Boolean(pl.isTest),
        fee_code: "INSTALLMENT_PROTOCOL",
      };
      switch (INST_MAP[ev.eventType]) {
        case "OPENED":
          return {
            ...base,
            event_type: EVENT.POSITION_OPENED,
            qualified_amount_idr: toDecStr(
              pl.assetValueIdr ?? pl.lockedPlanValueIdr,
            ),
            platform_fee_idr: "0", // fee dibayar saat gold claim
            metadata: {
              plan_type: pl.planType,
              asset: pl.assetCode,
              gold_amount: String(pl.goldAmount),
            },
          };
        case "SETTLED":
          return {
            ...base,
            event_type: EVENT.POSITION_SETTLED,
            final_qualified_amount_idr: toDecStr(
              pl.standardEligiblePaidIdr ??
                pl.grossCashPaidIdr ??
                pl.assetValueIdr,
            ),
            platform_fee_idr:
              pl.protocolFeeStatus === "CHARGED"
                ? toDecStr(pl.protocolFeeIdr)
                : "0",
            external_cost_idr: "0", // claim network fee = pass-through user
            metadata: { tx_hash: ev.metadata?.tx_hash },
          };
        case "FAILED":
          return {
            ...base,
            event_type: EVENT.POSITION_FAILED,
            reason: ev.eventType.toUpperCase(),
          };
        default:
          return null;
      }
    })
    .filter(Boolean);
  const out = await run("installment", envs);
  if (rows.length)
    await writeCursor(key, new Date(rows[rows.length - 1].created_at));
  else await writeCursor(key, now);
  return out;
}

// ---------------- Swap ----------------

async function pollSwap(now) {
  const key = "loyalty:cursor:swap";
  const since = new Date((await readCursor(key)).getTime() - OVERLAP_MS);
  const rows = await Swap.findAll({
    where: {
      status: { [Op.in]: ["SUCCESS", "COMPLETED"] },
      updated_at: { [Op.gte]: since },
    },
    order: [["updated_at", "ASC"]],
    limit: BATCH,
  });
  const envs = rows.map((s) => ({
    source_system: "swap",
    source_event_id: `swap:${s.id}`,
    event_type: EVENT.SWAP_SETTLED,
    core_id: s.coreId,
    occurred_at: s.completedAt || s.updated_at,
    feature: FEATURE.SWAP,
    source_transaction_id: String(s.id),
    position_ref: `swap:${s.id}`,
    platform_fee_idr: toDecStr(s.feeAmountIdr),
    external_cost_idr: "0",
    fee_code: "SWAP_PLATFORM",
    metadata: {
      from: s.fromAsset,
      to: s.toAsset,
      gross_value_idr: toDecStr(s.grossValueIdr),
      fee_rate: s.feeRate,
    },
  }));
  const out = await run("swap", envs);
  if (rows.length)
    await writeCursor(key, new Date(rows[rows.length - 1].updated_at));
  else await writeCursor(key, now);
  return out;
}

/** Retry event FAILED (retryable) — mis. harga belum valid saat first deposit. */
async function retryFailed(now) {
  const { LoyaltyProcessedEvent } = require("../../models");
  const rows = await LoyaltyProcessedEvent.findAll({
    where: { processingStatus: "FAILED", attemptCount: { [Op.lt]: 20 } },
    order: [["updated_at", "ASC"]],
    limit: 50,
  });
  // Envelope disimpan di result.envelope saat gagal -> replay langsung.
  let n = 0;
  for (const r of rows) {
    const age = now.getTime() - new Date(r.updated_at).getTime();
    if (age < 60_000) continue;
    const env = r.result?.envelope;
    if (!env || r.result?.retryable === false) continue;
    const out = await engine.ingest(env);
    if (out.status === "PROCESSED") n++;
  }
  return n;
}

async function pollAll(now = new Date()) {
  const report = {};
  for (const [name, fn] of Object.entries({
    topups: pollTopups,
    deposits: pollChainDeposits,
    earn: pollEarn,
    loan: pollLoan,
    installment: pollInstallment,
    swap: pollSwap,
  })) {
    try {
      report[name] = await fn(now);
    } catch (error) {
      console.error(`[Loyalty] poll ${name} error:`, error.message);
      report[name] = { error: error.message };
    }
  }
  report.retried_failed = await retryFailed(now).catch(() => 0);
  return report;
}

module.exports = {
  pollAll,
  pollTopups,
  pollChainDeposits,
  pollEarn,
  pollLoan,
  pollInstallment,
  pollSwap,
  big,
};
