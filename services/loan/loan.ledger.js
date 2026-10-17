/*
 * Ledger adapter Loan: kas IDR (internal wallet = PG settlement account
 * user di app ini) + domain/revenue events. Semua fungsi WAJIB dalam
 * sequelize transaction. Kas selalu integer rupiah (roundIdr) — satu-satunya
 * boundary pembulatan.
 */

const crypto = require("crypto");
const Decimal = require("decimal.js");
const {
  InternalWallet,
  InternalTransaction,
  LoanEvent,
} = require("../../models");
const { LoanError, toJsonSafe } = require("./loan.errors");
const { roundIdr } = require("./loan.calc");

async function lockWallet(coreId, transaction, { createIfMissing = false } = {}) {
  let wallet = await InternalWallet.findOne({
    where: { coreId },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!wallet && createIfMissing) {
    wallet = await InternalWallet.create({ coreId, balanceIdr: 0 }, { transaction });
  }
  if (!wallet) {
    throw new LoanError("Internal wallet not found", {
      status: 404,
      code: "WALLET_NOT_FOUND",
    });
  }
  return wallet;
}

async function balance(coreId, transaction) {
  const w = await InternalWallet.findOne({ where: { coreId }, transaction });
  return new Decimal(w?.balanceIdr || 0);
}

/** Debit IDR (repayment). amount Decimal/BigInt -> dibulatkan ke rupiah. */
async function debitWallet({ coreId, amount, reference, description, metadata }, transaction) {
  const amt = new Decimal(roundIdr(amount).toString());
  const wallet = await lockWallet(coreId, transaction);
  const before = new Decimal(wallet.balanceIdr || 0);
  if (before.lt(amt)) {
    throw new LoanError("Insufficient IDR balance", {
      status: 402,
      code: "INSUFFICIENT_BALANCE",
      details: { balance_idr: before.toFixed(2), required_idr: amt.toFixed(0) },
    });
  }
  const after = before.minus(amt);
  await wallet.update({ balanceIdr: after.toFixed(2) }, { transaction });
  const tx = await InternalTransaction.create(
    {
      internalWalletId: wallet.id,
      coreId,
      type: "DEBIT",
      asset: "IDR",
      amount: amt.toFixed(2),
      balanceBefore: before.toFixed(2),
      balanceAfter: after.toFixed(2),
      reference,
      status: "SUCCESS",
      description,
      metadata: toJsonSafe(metadata),
    },
    { transaction },
  );
  return { tx, amount: amt };
}

/** Kredit IDR (disbursement / refund excess). */
async function creditWallet({ coreId, amount, reference, description, metadata }, transaction) {
  const amt = new Decimal(roundIdr(amount).toString());
  if (amt.lte(0)) return null;
  const wallet = await lockWallet(coreId, transaction, { createIfMissing: true });
  const before = new Decimal(wallet.balanceIdr || 0);
  const after = before.plus(amt);
  await wallet.update({ balanceIdr: after.toFixed(2) }, { transaction });
  const tx = await InternalTransaction.create(
    {
      internalWalletId: wallet.id,
      coreId,
      type: "CREDIT",
      asset: "IDR",
      amount: amt.toFixed(2),
      balanceBefore: before.toFixed(2),
      balanceAfter: after.toFixed(2),
      reference,
      status: "SUCCESS",
      description,
      metadata: toJsonSafe(metadata),
    },
    { transaction },
  );
  return { tx, amount: amt };
}

async function recordEvent(position, { eventType, effectiveAt, metadata, correlationId, amountIdr, amountQty, asset }, transaction) {
  return LoanEvent.create(
    {
      positionId: position?.id || null,
      coreId: position?.coreId || null,
      eventType,
      effectiveAt,
      amountIdr: amountIdr === undefined ? null : new Decimal(String(amountIdr)).toFixed(18),
      amountQty: amountQty === undefined ? null : new Decimal(String(amountQty)).toFixed(18),
      asset: asset || position?.collateralAsset || null,
      correlationId: correlationId || null,
      metadata: toJsonSafe(metadata),
    },
    { transaction },
  );
}

/**
 * Revenue/cost event (brief 18 registry). Satu revenue_event_id per
 * occurrence; sourceTxId = kunci idempoten (mis. drawdown id).
 */
async function recordRevenue(position, { revId, amountIdr, amountQty, asset, rateBps, baseIdr, sourceTxId, effectiveAt, status = "RECOGNIZED", metadata }, transaction) {
  return LoanEvent.create(
    {
      positionId: position?.id || null,
      coreId: position?.coreId || null,
      eventType: "loan.revenue",
      effectiveAt,
      revId,
      revenueEventId: crypto.randomUUID(),
      amountIdr: amountIdr === undefined ? null : new Decimal(String(amountIdr)).toFixed(18),
      amountQty: amountQty === undefined ? null : new Decimal(String(amountQty)).toFixed(18),
      asset: asset || position?.collateralAsset || null,
      rateBps: rateBps ?? null,
      calculationBaseIdr: baseIdr === undefined ? null : new Decimal(String(baseIdr)).toFixed(18),
      sourceTxId: sourceTxId || null,
      status,
      metadata: toJsonSafe(metadata),
    },
    { transaction },
  );
}

async function reverseRevenue(original, { effectiveAt, metadata }, transaction) {
  await original.update({ status: "REVERSED" }, { transaction });
  return LoanEvent.create(
    {
      positionId: original.positionId,
      coreId: original.coreId,
      eventType: "loan.revenue",
      effectiveAt,
      revId: original.revId,
      revenueEventId: crypto.randomUUID(),
      amountIdr: original.amountIdr ? new Decimal(original.amountIdr).neg().toFixed(18) : null,
      amountQty: original.amountQty ? new Decimal(original.amountQty).neg().toFixed(18) : null,
      asset: original.asset,
      status: "REVERSED",
      reversalOfEventId: original.id,
      metadata: toJsonSafe(metadata),
    },
    { transaction },
  );
}

module.exports = {
  lockWallet,
  balance,
  debitWallet,
  creditWallet,
  recordEvent,
  recordRevenue,
  reverseRevenue,
};
