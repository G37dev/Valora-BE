/**
 * Activity detail — resolve satu row history (refId) menjadi payload
 * detail ter-normalisasi buat bottom sheet Activity.
 *
 * refId format (dikirim list /transactions/:coreId):
 *   tx-<uuid>    -> Transaction on-chain (crypto deposit/withdraw)
 *   swap-<id>    -> Swap
 *   itx-<id>     -> InternalTransaction (topup, installment, loan, dll)
 *   earn-<id>-c  -> EarnPosition create
 *   earn-<id>-r  -> EarnPosition claim / redemption
 */
const Decimal = require("decimal.js");
const {
  Transaction,
  Swap,
  InternalTransaction,
  TopUp,
  InstallmentPayment,
  InstallmentPlan,
  LoanRepayment,
  LoanCollateralRelease,
  LoanPosition,
  EarnPosition,
} = require("../../models");

const TOKEN_DECIMALS = { USDT: 6, USDC: 6, GOLD: 6, XAUT: 6, IDR: 2 };
const NETWORK_NAME = process.env.CHAIN_NAME || "Sepolia";
const CONFIRMATIONS_REQUIRED = 12;

const ASSET_NAMES = {
  USDT: "USDT",
  USDC: "USDC",
  XAUT: "XAUT",
  GOLD: "VVLR Gold",
  IDR: "IDR",
};

const dec = (v) => {
  try {
    const d = new Decimal(String(v ?? 0));
    return d.isFinite() ? d : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
};

// Raw smallest unit -> human token amount (untuk EarnPosition.principal).
const rawToToken = (raw, asset) =>
  dec(raw).div(new Decimal(10).pow(TOKEN_DECIMALS[asset] ?? 6)).toFixed();

// Kode pendek ala "666FXY" — 6 char terakhir alfanumerik UUID.
const shortId = (id) =>
  String(id || "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-6)
    .toUpperCase() || null;

const upper = (s) => String(s || "").toUpperCase();

const STATUS_LABEL = {
  PENDING: "PENDING",
  PROCESSING: "PENDING",
  SUCCESS: "COMPLETED",
  COMPLETED: "COMPLETED",
  ACTIVE: "COMPLETED",
  CLAIMED: "COMPLETED",
  SETTLEMENT: "COMPLETED",
  CONFIRMED: "COMPLETED",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  REFUNDED: "REFUNDED",
};
const normStatus = (s) => STATUS_LABEL[upper(s)] || upper(s) || "PENDING";

const base = (row, extra) => ({
  txId: shortId(row.id),
  orderDate: row.created_at || row.createdAt || null,
  status: normStatus(extra?.status ?? row.status),
  ...extra,
});

// ---------------------------------------------------------------------
// On-chain Transaction -> crypto deposit / withdraw
// ---------------------------------------------------------------------
async function buildCryptoDetail(tx, currentBlock) {
  const txType = upper(tx.type);
  const isDeposit = txType !== "WITHDRAW";
  const amount = dec(tx.amount);
  const fee = dec(tx.fee || 0);

  const TYPE_TITLE = {
    DEPOSIT: "Deposit",
    WITHDRAW: "Withdraw",
    COLLATERAL_RELEASE: "Collateral Release",
    LIQUIDATION_REFUND: "Liquidation Refund",
    EARN_DEPOSIT: "Earn",
    EARN_CLAIM: "Redemption",
  };

  let confirmations = { current: 0, required: CONFIRMATIONS_REQUIRED };
  if (tx.tx_block_number && currentBlock > 0) {
    confirmations.current = Math.max(
      0,
      Math.min(
        CONFIRMATIONS_REQUIRED,
        currentBlock - Number(tx.tx_block_number),
      ),
    );
  }
  if (normStatus(tx.status) === "COMPLETED") {
    confirmations.current = CONFIRMATIONS_REQUIRED;
  }

  const status = normStatus(tx.status);
  const title = TYPE_TITLE[txType] || (isDeposit ? "Deposit" : "Withdraw");
  const LABELS = {
    DEPOSIT: { cp: "Deposit from", amount: "Deposit Amount", total: "Total Credited" },
    COLLATERAL_RELEASE: {
      cp: "Released From",
      amount: "Released Amount",
      total: "Total Released",
    },
    LIQUIDATION_REFUND: {
      cp: "Refund From",
      amount: "Refund Amount",
      total: "Total Refunded",
    },
  };
  const labels = LABELS[txType] || {
    cp: isDeposit ? "Deposit from" : "Withdraw To",
    amount: isDeposit ? "Deposit Amount" : "Withdraw Amount",
    total: isDeposit ? "Total Credited" : "Total Debited",
  };
  return base(tx, {
    kind: "CRYPTO",
    subKind: isDeposit ? "DEPOSIT" : "WITHDRAW",
    title,
    statusText: isDeposit
      ? status === "COMPLETED"
        ? `Your ${title.toLowerCase()} completed`
        : `Your ${title.toLowerCase()} is in progress`
      : status === "COMPLETED"
        ? "Your withdraw completed"
        : "Your withdraw is in progress",
    asset: tx.asset,
    assetName: ASSET_NAMES[upper(tx.asset)] || tx.asset,
    network: NETWORK_NAME,
    amount: amount.toFixed(),
    fee: isDeposit ? "0" : fee.toFixed(),
    counterparty: {
      label: labels.cp,
      value: isDeposit ? tx.from_address || null : tx.destination_address,
    },
    amountLabel: labels.amount,
    totalLabel: labels.total,
    total: isDeposit ? amount.toFixed() : amount.plus(fee).toFixed(),
    confirmations,
    txHash: tx.tx_hash,
    refNumber: null,
    status,
  });
}

// ---------------------------------------------------------------------
// Swap
// ---------------------------------------------------------------------
function buildSwapDetail(s) {
  const rate =
    dec(s.receiveAmount).gt(0) && dec(s.fromAmount).gt(0)
      ? dec(s.receiveAmount).div(dec(s.fromAmount))
      : null;

  const feeFromAsset =
    dec(s.feeAmountIdr).gt(0) && dec(s.fromPriceIdr).gt(0)
      ? dec(s.feeAmountIdr).div(dec(s.fromPriceIdr))
      : dec(0);

  return base(s, {
    kind: "SWAP",
    title: "Swap",
    statusText:
      normStatus(s.status) === "COMPLETED"
        ? "Your swap completed"
        : "Your swap is in progress",
    fromAsset: s.fromAsset,
    fromAmount: dec(s.fromAmount).toFixed(),
    toAsset: s.toAsset,
    toAssetName: ASSET_NAMES[upper(s.toAsset)] || s.toAsset,
    toAmount: dec(s.receiveAmount || s.toAmount).toFixed(),
    rate: rate ? rate.toFixed() : null,
    fee: feeFromAsset.toFixed(),
    feeAsset: s.fromAsset,
    settlementStatus: normStatus(s.status),
    txHash: s.withdrawalTxHash || s.depositTxHash || null,
    status: normStatus(s.status),
  });
}

// ---------------------------------------------------------------------
// InternalTransaction -> topup / installment / loan / generic
// ---------------------------------------------------------------------
function topupBankInfo(itx, topup) {
  const notif =
    itx?.metadata?.notification || topup?.raw_response?.notification || {};
  const va = Array.isArray(notif.va_numbers) ? notif.va_numbers[0] : null;
  const bank = (va?.bank || notif.bank || "").toUpperCase() || null;
  const vaNumber = va?.va_number || notif.va_number || null;
  const method =
    topup?.payment_method ||
    (notif.payment_type === "bank_transfer"
      ? "Virtual Account"
      : notif.payment_type) ||
    "Virtual Account";
  return { bank, vaNumber, method };
}

async function buildTopupDetail(itx, topup) {
  const { bank, vaNumber, method } = topupBankInfo(itx, topup);
  const amount = dec(topup?.amount_idr ?? itx.amount);
  return base(itx, {
    kind: "IDR_DEPOSIT",
    title: "Deposit",
    statusText:
      normStatus(itx.status) === "COMPLETED"
        ? "Your deposit completed"
        : "Your deposit is in progress",
    refNumber: topup?.ref_no || topup?.provider_payment_id || null,
    asset: "IDR",
    assetName: "IDR",
    amount: amount.toFixed(0),
    bank,
    method,
    vaNumber,
    fee: "0",
    totalLabel: "Total Credited",
    total: amount.toFixed(0),
    status: normStatus(itx.status),
  });
}

async function buildInstallmentDetail(itx, payment) {
  if (!payment) return buildGenericDetail(itx, "Installment Payment");

  const alloc = payment.allocation || {};
  const snap = payment.calculationSnapshot || {};
  const plan = payment.plan || payment.InstallmentPlan || null;

  const interestApplied = dec(
    alloc.interest_idr ?? alloc.interest ?? alloc.carrying_idr ?? 0,
  );
  const penaltyApplied = dec(
    alloc.penalty_idr ?? alloc.pdp_idr ?? alloc.past_due_idr ?? 0,
  );
  const priorityApplied = interestApplied.plus(penaltyApplied);
  const principalApplied = dec(
    alloc.principal_idr ?? alloc.principal ?? 0,
  );

  const newOutstanding = dec(
    snap.principal_outstanding_idr ?? plan?.principal_outstanding_idr ?? 0,
  );

  // Plan completion = paid schedule / total schedule
  let completionPct = null;
  let nextDue = null;
  if (plan?.id) {
    const { InstallmentSchedule } = require("../../models");
    const { Op } = require("sequelize");
    const [total, paid] = await Promise.all([
      InstallmentSchedule.count({ where: { planId: plan.id } }),
      InstallmentSchedule.count({
        where: { planId: plan.id, status: "PAID" },
      }),
    ]);
    if (total > 0) completionPct = Math.round((paid / total) * 100);
    const next = await InstallmentSchedule.findOne({
      where: { planId: plan.id, status: { [Op.in]: ["PENDING", "PARTIAL"] } },
      order: [["dueAt", "ASC"]],
    });
    nextDue = next?.dueAt || null;
  }

  return base(itx, {
    kind: "INSTALLMENT_PAYMENT",
    title: "Installment",
    statusText:
      normStatus(itx.status) === "COMPLETED"
        ? "Your installment payment completed"
        : "Your installment payment is in progress",
    asset: "IDR",
    assetName: "IDR",
    amount: dec(payment.amount_idr ?? itx.amount).toFixed(0),
    priorityApplied: priorityApplied.toFixed(0),
    principalApplied: principalApplied.toFixed(0),
    newOutstanding: newOutstanding.toFixed(0),
    planType: plan?.plan_type || null,
    completionPct,
    nextDueDate: nextDue,
    status: normStatus(itx.status),
  });
}

async function buildLoanRepayDetail(itx, repayment) {
  if (!repayment) return buildGenericDetail(itx, "Pawn Repayment");

  const position = repayment.positionId
    ? await LoanPosition.findByPk(repayment.positionId)
    : null;

  const wf = itx.metadata?.waterfall || {};
  const priorityApplied = dec(wf.pdp).plus(dec(wf.interest));
  const principalApplied = dec(wf.principal || 0);

  const prevDebt = dec(repayment.principal_before_idr);
  const newDebt = dec(repayment.principal_after_idr);

  let collateral = null;
  if (repayment.releaseId) {
    const rel = await LoanCollateralRelease.findByPk(repayment.releaseId);
    if (rel) {
      const remaining = dec(position?.lockedQty ?? 0);
      const released = dec(rel.tokenQty);
      collateral = {
        asset: position?.collateralAsset || "GOLD",
        released: released.toFixed(),
        lockedBefore: remaining.plus(released).toFixed(),
        remaining: remaining.toFixed(),
        txHash: rel.txHash || null,
      };
    }
  }

  return base(itx, {
    kind: "PAWN_REPAYMENT",
    title: "Pawn",
    statusText:
      normStatus(itx.status) === "COMPLETED"
        ? "Your pawn repayment completed"
        : "Your pawn repayment is in progress",
    asset: "IDR",
    assetName: "IDR",
    previousDebt: prevDebt.toFixed(0),
    amount: dec(repayment.debited_idr ?? itx.amount).toFixed(0),
    priorityApplied: priorityApplied.toFixed(0),
    principalApplied: principalApplied.toFixed(0),
    newDebt: newDebt.toFixed(0),
    collateral,
    status: normStatus(itx.status),
  });
}

function buildGenericDetail(itx, title) {
  return base(itx, {
    kind: "GENERIC",
    title: title || itx.description || "Transaction",
    statusText: itx.description || "Transaction",
    asset: itx.asset || "IDR",
    assetName: ASSET_NAMES[upper(itx.asset)] || itx.asset || "IDR",
    amount: dec(itx.amount).toFixed(0),
    direction: itx.type,
    status: normStatus(itx.status),
  });
}

// ---------------------------------------------------------------------
// EarnPosition -> create / claim
// ---------------------------------------------------------------------
function buildEarnDetail(pos, mode) {
  const principal = rawToToken(pos.principal, pos.asset);
  const aprPct = pos.aprBps != null ? dec(pos.aprBps).div(100).toFixed(2) : null;
  const isClaim = mode === "claim";

  return base(pos, {
    kind: isClaim ? "EARN_CLAIM" : "EARN_CREATE",
    title: isClaim ? "Redemption" : "Earn",
    statusText: isClaim
      ? pos.status === "CLAIMED"
        ? "Your earn redemption completed"
        : "Your redemption request is in progress"
      : "Your earn position has been created",
    asset: pos.asset,
    assetName: ASSET_NAMES[upper(pos.asset)] || pos.asset,
    principal,
    aprPct,
    termDays: pos.termCode,
    startDate: pos.completedAt || pos.created_at || pos.createdAt,
    maturityAt: pos.maturityAt || null,
    claimMode: "At Maturity",
    positionStatus: pos.status,
    txHash: isClaim ? pos.claimTxHash : pos.txHash,
    status: isClaim
      ? pos.status === "CLAIMED"
        ? "COMPLETED"
        : "PENDING"
      : pos.status === "ACTIVE" || pos.status === "CLAIMED"
        ? "COMPLETED"
        : pos.status === "FAILED"
          ? "FAILED"
          : "PENDING",
    orderDate:
      (isClaim ? pos.completedAt : pos.created_at) || pos.createdAt,
  });
}

// ---------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------
async function resolveActivityDetail({ coreId, refId, currentBlock = 0 }) {
  const ref = String(refId || "");

  if (ref.startsWith("tx-")) {
    const tx = await Transaction.findOne({
      where: { id: ref.slice(3), core_id: coreId },
    });
    if (!tx) throw new Error("Transaksi tidak ditemukan");

    const txType = upper(tx.type);
    if (txType === "EARN_DEPOSIT" || txType === "EARN_CLAIM") {
      const pos = await EarnPosition.findOne({
        where: {
          coreId,
          [require("sequelize").Op.or]: [
            { txHash: tx.tx_hash },
            { claimTxHash: tx.tx_hash },
          ],
        },
      });
      if (pos) {
        const isClaim =
          txType === "EARN_CLAIM" ||
          String(pos.claimTxHash || "").toLowerCase() ===
            String(tx.tx_hash).toLowerCase();
        return buildEarnDetail(pos, isClaim ? "claim" : "create");
      }
    }

    return buildCryptoDetail(tx, currentBlock);
  }

  if (ref.startsWith("swap-")) {
    const s = await Swap.findOne({
      where: { id: ref.slice(5), coreId },
    });
    if (!s) throw new Error("Swap tidak ditemukan");
    return buildSwapDetail(s);
  }

  if (ref.startsWith("earn-")) {
    const m = ref.match(/^earn-(.+)-(c|r)$/);
    const pos = await EarnPosition.findOne({
      where: { id: m ? m[1] : ref.slice(5), coreId },
    });
    if (!pos) throw new Error("Posisi earn tidak ditemukan");
    return buildEarnDetail(pos, m && m[2] === "r" ? "claim" : "create");
  }

  if (ref.startsWith("itx-")) {
    const itx = await InternalTransaction.findOne({
      where: { id: ref.slice(4), coreId },
    });
    if (!itx) throw new Error("Transaksi tidak ditemukan");

    if (itx.topUpId) {
      const topup = await TopUp.findByPk(itx.topUpId);
      return buildTopupDetail(itx, topup);
    }

    const refUp = upper(itx.reference);

    if (refUp.startsWith("LOAN-REPAY-")) {
      // reference: LOAN-REPAY-<positionId>-<idempotencyKey>
      const m = String(itx.reference).match(
        /^LOAN-REPAY-([0-9a-fA-F-]{36})-(.+)$/,
      );
      const repayment = m
        ? await LoanRepayment.findOne({
            where: { positionId: m[1], idempotencyKey: m[2] },
          })
        : null;
      return buildLoanRepayDetail(itx, repayment);
    }

    if (refUp.includes("INSTALLMENT")) {
      const payment = await InstallmentPayment.findOne({
        where: { internal_transaction_id: itx.id },
        include: [{ model: InstallmentPlan, as: "plan", required: false }],
      });
      return buildInstallmentDetail(itx, payment);
    }

    return buildGenericDetail(itx);
  }

  throw new Error("refId tidak dikenal");
}

module.exports = {
  resolveActivityDetail,
  ASSET_NAMES,
  rawToToken,
  shortId,
  normStatus,
};
