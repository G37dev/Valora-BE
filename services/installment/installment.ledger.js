/*
 * Ledger adapter: internal wallet IDR + installment events.
 * Semua fungsi WAJIB dipanggil dalam sequelize transaction.
 * Mengikuti pola debit/credit yang dipakai swap.worker.js.
 */

const crypto = require("crypto");
const Decimal = require("decimal.js");
const {
  InternalWallet,
  InternalTransaction,
  InstallmentEvent,
} = require("../../models");
const { InstallmentError, toJsonSafe } = require("./installment.errors");
const { EVENT } = require("./installment.constants");

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
    throw new InstallmentError("Internal wallet tidak ditemukan", {
      status: 404,
      code: "WALLET_NOT_FOUND",
    });
  }

  return wallet;
}

/**
 * Debit IDR dari internal wallet user.
 * amount: bigint (integer rupiah)
 */
async function debitWallet({ coreId, amount, reference, description, metadata }, transaction) {
  const wallet = await lockWallet(coreId, transaction);
  const amountDec = new Decimal(amount.toString());
  const before = new Decimal(wallet.balanceIdr || 0);

  if (before.lt(amountDec)) {
    throw new InstallmentError("Saldo IDR tidak mencukupi", {
      status: 402,
      code: "INSUFFICIENT_BALANCE",
      details: { balance_idr: before.toFixed(2), required_idr: amount.toString() },
    });
  }

  const after = before.minus(amountDec);
  await wallet.update({ balanceIdr: after.toFixed(2) }, { transaction });

  return InternalTransaction.create(
    {
      internalWalletId: wallet.id,
      coreId,
      type: "DEBIT",
      asset: "IDR",
      amount: amountDec.toFixed(2),
      balanceBefore: before.toFixed(2),
      balanceAfter: after.toFixed(2),
      reference,
      status: "SUCCESS",
      description,
      metadata: toJsonSafe(metadata),
    },
    { transaction },
  );
}

/**
 * Kredit IDR ke internal wallet user (refund). Wallet dibuat jika belum ada.
 */
async function creditWallet({ coreId, amount, reference, description, metadata }, transaction) {
  if (amount <= 0n) return null;

  const wallet = await lockWallet(coreId, transaction, { createIfMissing: true });
  const amountDec = new Decimal(amount.toString());
  const before = new Decimal(wallet.balanceIdr || 0);
  const after = before.plus(amountDec);

  await wallet.update({ balanceIdr: after.toFixed(2) }, { transaction });

  return InternalTransaction.create(
    {
      internalWalletId: wallet.id,
      coreId,
      type: "CREDIT",
      asset: "IDR",
      amount: amountDec.toFixed(2),
      balanceBefore: before.toFixed(2),
      balanceAfter: after.toFixed(2),
      reference,
      status: "SUCCESS",
      description,
      metadata: toJsonSafe(metadata),
    },
    { transaction },
  );
}

async function recordEvent(plan, { eventType, effectiveAt, metadata }, transaction) {
  return InstallmentEvent.create(
    {
      planId: plan.id,
      coreId: plan.coreId,
      eventType,
      effectiveAt,
      metadata: toJsonSafe(metadata),
    },
    { transaction },
  );
}

/**
 * Revenue event: setiap occurrence punya revenue_event_id unik (brief 17).
 * amount 0 tidak dicatat.
 */
async function recordRevenue(
  plan,
  { revId, amount, rateBps = null, base = null, effectiveAt, sourceTransactionId = null, metadata },
  transaction,
) {
  if (!amount || amount <= 0n) return null;

  return InstallmentEvent.create(
    {
      planId: plan.id,
      coreId: plan.coreId,
      eventType: EVENT.REVENUE,
      effectiveAt,
      revId,
      revenueEventId: crypto.randomUUID(),
      amountIdr: amount.toString(),
      rateBps,
      calculationBaseIdr: base === null ? null : base.toString(),
      sourceTransactionId,
      destinationAccount: "VIVALORA_REVENUE",
      status: "RECOGNIZED",
      metadata: toJsonSafe(metadata),
    },
    { transaction },
  );
}

module.exports = {
  debitWallet,
  creditWallet,
  recordEvent,
  recordRevenue,
};
