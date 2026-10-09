const service = require("../services/installment/installment.service");
const clock = require("../services/installment/installment.clock");
const {
  InstallmentError,
  toJsonSafe,
} = require("../services/installment/installment.errors");
const {
  RULES,
  RULES_VERSION,
  STANDARD_MARKUP_BPS,
  PRICE_LOCK_MARGIN_BPS,
  RESTRUCTURE_EXTENSION_MONTHS,
  TENOR_MONTHS,
} = require("../services/installment/installment.constants");

function handleError(res, error, context) {
  if (error instanceof InstallmentError) {
    return res.status(error.status).json({
      success: false,
      code: error.code,
      message: error.message,
      details: toJsonSafe(error.details),
    });
  }

  console.error(`[Installment] ${context} error:`, error);
  return res.status(500).json({
    success: false,
    message: `Failed while ${context}`,
    error: error.message,
  });
}

function requireCoreId(req, res) {
  const coreId = req.user?.coreId;
  if (!coreId) {
    res
      .status(401)
      .json({ success: false, message: "coreId not found in token" });
    return null;
  }
  return coreId;
}

/**
 * @route GET /api/installments/config
 * Rate & rule yang berlaku (untuk UI).
 */
const getConfig = (req, res) =>
  res.status(200).json({
    success: true,
    data: toJsonSafe({
      rules_version: RULES_VERSION,
      tenor_months: TENOR_MONTHS,
      standard_markup_bps: STANDARD_MARKUP_BPS,
      price_lock_margin_bps: PRICE_LOCK_MARGIN_BPS,
      restructure_extension_months: RESTRUCTURE_EXTENSION_MONTHS,
      rules: RULES,
    }),
  });

/**
 * @route POST /api/installments/quote
 * body: plan_type, asset, gold_amount, tenor_months, installment_gap | dp_bps/dp_percent
 */
const quote = async (req, res) => {
  try {
    const data = await service.quote(req.body || {}, {
      now: await clock.now(req),
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "calculating quote");
  }
};

/**
 * @route POST /api/installments
 * body: quote fields + idempotency_key
 */
const createRequest = async (req, res) => {
  try {
    const coreId = requireCoreId(req, res);
    if (!coreId) return;

    const { plan, created } = await service.createRequest({
      coreId,
      body: req.body || {},
      now: await clock.now(req),
      isTest: await clock.isTest(req),
    });
    return res.status(created ? 201 : 200).json({
      success: true,
      message: !created
        ? "Request already created (idempotent)."
        : plan.status === "ACTIVE"
          ? "Plan active. First installment is due at the first interval."
          : "Installment request created. Pay the down payment before it expires.",
      data: service.serializePlan(plan, { at: await clock.now(req) }),
    });
  } catch (error) {
    return handleError(res, error, "creating installment request");
  }
};

/**
 * @route POST /api/installments/:plan_id/pay
 * body: amount_idr, idempotency_key
 */
const pay = async (req, res) => {
  try {
    const coreId = requireCoreId(req, res);
    if (!coreId) return;

    const { plan, payment, duplicate, excess } = await service.pay({
      coreId,
      planId: req.params.plan_id,
      body: req.body || {},
      now: await clock.now(req),
    });

    return res.status(200).json({
      success: true,
      message: duplicate
        ? "Payment already processed (idempotent)."
        : "Payment successful.",
      data: toJsonSafe({
        payment: {
          id: payment.id,
          kind: payment.kind,
          requested_amount_idr: payment.requestedAmountIdr,
          amount_idr: payment.amountIdr,
          excess_not_debited_idr: excess ?? 0n,
          allocation: payment.allocation,
          status_before: payment.statusBefore,
          status_after: payment.statusAfter,
        },
        plan: service.serializePlan(plan, { at: await clock.now(req) }),
      }),
    });
  } catch (error) {
    return handleError(res, error, "processing payment");
  }
};

/** @route POST /api/installments/:plan_id/cancel */
const cancel = async (req, res) => {
  try {
    const coreId = requireCoreId(req, res);
    if (!coreId) return;

    const { plan, result } = await service.cancel({
      coreId,
      planId: req.params.plan_id,
      now: await clock.now(req),
    });
    return res.status(200).json({
      success: true,
      message: "Plan cancelled. Refund credited to your internal wallet.",
      data: toJsonSafe({
        cancellation: {
          rate_bps: result.rateBps,
          compensation_idr: result.compensation,
          raw_refund_idr: result.rawRefund,
          final_refund_idr: result.finalRefund,
        },
        plan: service.serializePlan(plan, { at: await clock.now(req) }),
      }),
    });
  } catch (error) {
    return handleError(res, error, "cancelling plan");
  }
};

/** @route POST /api/installments/:plan_id/restructure */
const restructure = async (req, res) => {
  try {
    const coreId = requireCoreId(req, res);
    if (!coreId) return;

    const { plan, result } = await service.restructure({
      coreId,
      planId: req.params.plan_id,
      now: await clock.now(req),
    });
    return res.status(200).json({
      success: true,
      message: "Restructure aktif.",
      data: toJsonSafe({
        restructure: {
          fee_idr: result.fee,
          extension_months: result.extension,
          new_maturity_at: result.restructureMaturityAt,
        },
        plan: service.serializePlan(plan, { at: await clock.now(req) }),
      }),
    });
  } catch (error) {
    return handleError(res, error, "restructuring plan");
  }
};

/** @route GET /api/installments?status= */
const listPlans = async (req, res) => {
  try {
    const coreId = requireCoreId(req, res);
    if (!coreId) return;

    const data = await service.listPlans({
      coreId,
      status: req.query.status,
      includeTest:
        (await clock.isTest(req)) ||
        req.query.include_test === "1" ||
        req.query.include_test === "true",
      now: await clock.now(req),
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "loading installment list");
  }
};

/** @route GET /api/installments/:plan_id */
const getPlanDetail = async (req, res) => {
  try {
    const coreId = requireCoreId(req, res);
    if (!coreId) return;

    const data = await service.getPlanDetail({
      coreId,
      planId: req.params.plan_id,
      now: await clock.now(req),
    });
    return res.status(200).json({ success: true, data });
  } catch (error) {
    return handleError(res, error, "loading installment detail");
  }
};

module.exports = {
  getConfig,
  quote,
  createRequest,
  pay,
  cancel,
  restructure,
  listPlans,
  getPlanDetail,
};
