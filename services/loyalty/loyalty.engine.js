/*
 * Loyalty Rules Engine — konsumen event produk (brief 02, 04-08, 10, 12).
 *
 * ingest(envelope) idempotent by (source_system, source_event_id). Semua
 * efek satu event berjalan dalam SATU DB transaction: processed_events +
 * grant + jurnal + slot/link state. Gagal di tengah -> rollback total,
 * event dicatat FAILED dan akan di-retry poller.
 *
 * Envelope (dinormalisasi oleh loyalty.ingest / hooks):
 * {
 *   source_system, source_event_id, event_type, core_id, occurred_at,
 *   feature?, position_ref?, source_transaction_id?,
 *   asset?, amount?,                          // DEPOSIT_CONFIRMED
 *   qualified_amount_idr?, final_qualified_amount_idr?,
 *   platform_fee_idr?, external_cost_idr?, vp_discount_idr?,
 *   initial_ltv_bps?, collateral_asset?, reason?, is_test?, metadata?
 * }
 */

const crypto = require("crypto");
const { Op } = require("sequelize");
const {
  sequelize,
  LoyaltyCustomer,
  LoyaltyReferralLink,
  LoyaltyRewardGrant,
  LoyaltyMonthlyProgress,
  LoyaltyProcessedEvent,
} = require("../../models");
const configSvc = require("./loyalty.config");
const ledger = require("./loyalty.ledger");
const pricing = require("./loyalty.pricing");
const {
  LoyaltyError,
  big,
  max0,
  min,
  applyBps,
  toJsonSafe,
} = require("./loyalty.errors");
const {
  EVENT,
  FEATURE,
  CATEGORY,
  VP_STATE,
  IDR_STATE,
  FQT_SLOT,
  TIER,
} = require("./loyalty.constants");

const HOUR = 3600 * 1000;

function requireFields(env, fields) {
  for (const f of fields) {
    if (env[f] === undefined || env[f] === null || env[f] === "") {
      throw new LoyaltyError(`Envelope field '${f}' wajib`, {
        code: "ENVELOPE_INVALID",
      });
    }
  }
}

function payloadHash(env) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(toJsonSafe(env)))
    .digest("hex");
}

/** Bulan kalender di business timezone (default Asia/Jakarta). */
function monthKey(date, tz = "Asia/Jakarta") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  return `${y}-${m}`;
}

/** FLOOR(basis x rate_bps x multiplier_bps / 1e8), lalu cap. */
function rewardVp(basisIdr, rateBps, multiplierBps, capVp) {
  const raw =
    (big(basisIdr) * BigInt(rateBps) * BigInt(multiplierBps)) / 100000000n;
  const cap = BigInt(capVp);
  return { vp: min(raw, cap), capApplied: raw > cap };
}

function eligibleNetFee(env) {
  const gross = big(env.platform_fee_idr || 0);
  const discount = big(env.vp_discount_idr || 0);
  const cost = big(env.external_cost_idr || 0);
  const cashPaid = max0(gross - discount);
  return { gross, discount, cost, cashPaid, net: max0(cashPaid - cost) };
}

const isPaused = (config) => Boolean(config.budgets?.pause_issuance);

// ---------------------------------------------------------------------------
// Handlers (semua menerima ctx = { env, now, config, version, versionId, t, cust })
// ---------------------------------------------------------------------------

async function onCustomerRegistered(ctx) {
  return { enrolled: true };
}

async function onDepositConfirmed(ctx) {
  const { env, now, config, t, cust } = ctx;
  requireFields(env, ["asset", "amount"]);
  const result = { first_deposit: false };

  if (cust.firstDepositConsumedAt) {
    result.reason = "NOT_FIRST_DEPOSIT";
    return result;
  }
  // Valuation (crypto: harga tervalidasi; stale -> retry nanti, jangan minting)
  const valuation = await pricing.valueIdr(env.asset, env.amount, {
    now,
    config,
    transaction: t,
  });
  if (valuation.status !== "VALID") {
    throw new LoyaltyError(
      `Harga ${env.asset} ${valuation.status}; first deposit ditunda`,
      {
        code: "PRICE_UNAVAILABLE",
        details: { retryable: true },
      },
    );
  }
  const idr = valuation.idr;
  const fd = config.first_deposit;
  const accountCreatedAt = new Date(cust.accountCreatedAt || cust.enrolledAt);
  const deadline = new Date(
    accountCreatedAt.getTime() +
      Number(config.referral.first_deposit_window_hours) * HOUR,
  );
  const withinWindow = now.getTime() <= deadline.getTime(); // <= valid tepat di boundary
  const meetsMin = idr >= BigInt(fd.min_deposit_idr);
  const assetOk = (fd.accepted_assets || []).includes(valuation.asset);
  const externalOk =
    valuation.asset === "IDR" || fd.allow_external_crypto !== false;
  const qualified =
    Boolean(fd.enabled) && withinWindow && meetsMin && assetOk && externalOk;

  // Opportunity one-time: dikonsumsi walau tidak qualified
  await cust.update(
    {
      firstDepositConsumedAt: now,
      firstDepositEventId: env.source_event_id,
      firstDepositQualified: qualified,
    },
    { transaction: t },
  );
  Object.assign(result, {
    first_deposit: true,
    idr_equivalent: idr,
    within_window: withinWindow,
    meets_minimum: meetsMin,
    qualified,
    deadline,
  });

  const link = await LoyaltyReferralLink.findOne({
    where: { refereeCoreId: cust.coreId, status: "VALID" },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });

  if (!qualified) {
    if (link)
      await link.update({ depositOpportunityUsed: true }, { transaction: t });
    result.reason = !withinWindow
      ? "WINDOW_EXPIRED"
      : !meetsMin
        ? "BELOW_MINIMUM"
        : "NOT_ELIGIBLE";
    return result;
  }
  if (isPaused(config)) {
    result.paused = true;
    return result;
  }

  // B: First Deposit VP (no multiplier), hold 7 hari
  const { vp, capApplied } = rewardVp(idr, fd.rate_bps, 10000, fd.cap_vp);
  const { grant } = await ledger.createVpGrant(
    {
      coreId: cust.coreId,
      category: CATEGORY.FIRST_DEPOSIT,
      businessKey: `FIRST_DEPOSIT:${cust.coreId}`,
      vpAmount: vp,
      availableAt: new Date(
        now.getTime() + Number(fd.pending_hold_hours) * HOUR,
      ),
      availabilityTrigger: "HOLD_EXPIRY",
      sourceSystem: env.source_system,
      sourceEventId: env.source_event_id,
      sourceTransactionId: env.source_transaction_id || null,
      feature: FEATURE.DEPOSIT,
      rateBps: fd.rate_bps,
      multiplierBps: 10000,
      capApplied,
      basisIdr: idr,
      tierSnapshot: cust.currentTier,
      valuationSnapshot: toJsonSafe({ ...valuation, amount: env.amount }),
      now,
      config,
      configVersion: ctx.version,
      configVersionId: ctx.versionId,
      metadata: { is_test: Boolean(env.is_test) },
    },
    t,
  );
  result.first_deposit_vp = vp;
  result.grant_id = grant.id;

  // A: Referral Deposit Cashback (IDR), PENDING_VALIDATION -> CLAIMABLE
  if (link && config.referral.enabled !== false) {
    const rawIdr = applyBps(idr, config.referral.deposit_rate_bps);
    const cashback = min(rawIdr, BigInt(config.referral.deposit_cap_idr));
    const { grant: aGrant } = await ledger.createIdrGrant(
      {
        coreId: link.referrerCoreId,
        category: CATEGORY.REFERRAL_DEPOSIT,
        businessKey: `REFERRAL_DEPOSIT:${link.id}`,
        idrAmount: cashback,
        availableAt: new Date(
          now.getTime() +
            Number(config.referral.validation_hold_hours ?? 0) * HOUR,
        ),
        linkId: link.id,
        counterpartyCoreId: cust.coreId,
        sourceSystem: env.source_system,
        sourceEventId: env.source_event_id,
        feature: FEATURE.DEPOSIT,
        rateBps: config.referral.deposit_rate_bps,
        capApplied: rawIdr > cashback,
        basisIdr: idr,
        now,
        config,
        configVersion: ctx.version,
        configVersionId: ctx.versionId,
      },
      t,
    );
    await link.update(
      {
        depositQualified: true,
        depositQualifiedAt: now,
        depositOpportunityUsed: true,
      },
      { transaction: t },
    );
    await ledger.ensureCustomer(link.referrerCoreId, { now, transaction: t });
    result.referral_deposit_idr = cashback;
    result.referrer_grant_id = aGrant.id;
  }
  return result;
}

async function onDepositReversed(ctx) {
  const { env, now, config, t, cust } = ctx;
  requireFields(env, ["deposit_event_id"]);
  const result = { reversed: [] };
  if (cust.firstDepositEventId !== env.deposit_event_id) {
    result.reason = "NOT_FIRST_DEPOSIT_EVENT";
    return result;
  }
  const grants = await LoyaltyRewardGrant.findAll({
    where: {
      sourceEventId: env.deposit_event_id,
      category: {
        [Op.in]: [CATEGORY.FIRST_DEPOSIT, CATEGORY.REFERRAL_DEPOSIT],
      },
    },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  for (const g of grants) {
    if (g.unit === "VP") {
      if (g.state === VP_STATE.PENDING)
        await ledger.voidGrant(
          g,
          { now, reason: "DEPOSIT_REVERSED", config },
          t,
        );
      else if (g.state === VP_STATE.AVAILABLE)
        await ledger.reverseGrant(
          g,
          { now, reason: "DEPOSIT_REVERSED", config },
          t,
        );
    } else if (g.state === IDR_STATE.PENDING) {
      await ledger.voidIdrGrant(
        g,
        { now, reason: "DEPOSIT_REVERSED", config },
        t,
      );
    } else {
      // CLAIMABLE/CLAIMED: masuk review queue (tidak auto-debit wallet user)
      await cust.update(
        {
          riskFlags: {
            ...(cust.riskFlags || {}),
            deposit_reversed_after_claimable: g.id,
          },
        },
        { transaction: t },
      );
    }
    result.reversed.push({ grant_id: g.id, state: g.state });
  }
  await cust.update({ firstDepositQualified: false }, { transaction: t });
  return result;
}

function fqtEligible(env, config) {
  const fq = config.first_qualified;
  if (!fq.enabled) return { ok: false, reason: "FQT_DISABLED" };
  if (!(fq.supported_features || []).includes(env.feature))
    return { ok: false, reason: "FEATURE_NOT_SUPPORTED" };
  const amount = big(env.qualified_amount_idr || 0);
  if (amount < BigInt(fq.min_qualified_amount_idr))
    return { ok: false, reason: "BELOW_MIN_QUALIFIED_AMOUNT" };
  if (env.feature === FEATURE.LOAN) {
    const asset = pricing.normalizeAsset(env.collateral_asset);
    const minLtv =
      asset === "XAUT" ? fq.loan_xaut_min_ltv_bps : fq.loan_vvlr_min_ltv_bps;
    const ltv = Number(env.initial_ltv_bps || 0);
    if (!ltv || ltv < Number(minLtv))
      return {
        ok: false,
        reason: "LOAN_LTV_BELOW_LOYALTY_MIN",
        min_ltv_bps: minLtv,
        ltv_bps: ltv,
      };
  }
  return { ok: true };
}

async function grantRegular(ctx, { immediate, businessKey, tier }) {
  const { env, now, config, t } = ctx;
  const reg = config.regular;
  if (!reg.enabled || !(reg.eligible_features || []).includes(env.feature))
    return null;
  const fee = eligibleNetFee(env);
  if (fee.gross <= 0n) return null;
  const mult = configSvc.tierMultiplierBps(config, tier);
  const vp = (fee.net * BigInt(reg.base_rate_bps) * BigInt(mult)) / 100000000n;
  const { grant, created } = await ledger.createVpGrant(
    {
      coreId: env.core_id,
      category: CATEGORY.REGULAR,
      businessKey,
      vpAmount: vp,
      immediate,
      availabilityTrigger: immediate ? "IMMEDIATE" : "POSITION_SETTLED",
      sourceSystem: env.source_system,
      sourceEventId: env.source_event_id,
      sourceTransactionId: env.source_transaction_id || null,
      feature: env.feature,
      positionRef: env.position_ref || env.source_transaction_id || null,
      tierSnapshot: tier,
      multiplierBps: mult,
      rateBps: reg.base_rate_bps,
      feeGrossIdr: fee.gross,
      feeCostIdr: fee.cost,
      feeDiscountIdr: fee.discount,
      feeNetIdr: fee.net,
      basisIdr: fee.net,
      now,
      config,
      configVersion: ctx.version,
      configVersionId: ctx.versionId,
      metadata: {
        is_test: Boolean(env.is_test),
        fee_code: env.fee_code || null,
      },
    },
    t,
  );
  return { grant, created, vp, fee };
}

async function onPositionOpened(ctx) {
  const { env, now, config, t, cust } = ctx;
  requireFields(env, ["feature", "position_ref"]);
  const result = {
    feature: env.feature,
    position_ref: env.position_ref,
    tier_snapshot: cust.currentTier,
  };
  if (isPaused(config)) {
    result.paused = true;
    return result;
  }
  const tier = cust.currentTier || TIER.CADET;
  const mult = configSvc.tierMultiplierBps(config, tier);

  // --- First Qualified Transaction slot (atomic: cust row sudah FOR UPDATE)
  const elig = fqtEligible(env, config);
  result.fqt = {
    eligible: elig.ok,
    reason: elig.reason || null,
    slot_before: cust.fqtSlotState,
  };
  if (elig.ok && cust.fqtSlotState === FQT_SLOT.UNUSED) {
    const fq = config.first_qualified;
    const { vp, capApplied } = rewardVp(
      env.qualified_amount_idr,
      fq.rate_bps,
      mult,
      fq.cap_vp,
    );
    const { grant } = await ledger.createVpGrant(
      {
        coreId: cust.coreId,
        category: CATEGORY.FQT,
        businessKey: `FQT:${cust.coreId}`,
        vpAmount: vp,
        availabilityTrigger: "POSITION_SETTLED",
        sourceSystem: env.source_system,
        sourceEventId: env.source_event_id,
        sourceTransactionId: env.source_transaction_id || null,
        feature: env.feature,
        positionRef: env.position_ref,
        tierSnapshot: tier,
        multiplierBps: mult,
        rateBps: fq.rate_bps,
        capApplied,
        basisIdr: big(env.qualified_amount_idr),
        valuationSnapshot: toJsonSafe({
          initial_ltv_bps: env.initial_ltv_bps,
          collateral_asset: env.collateral_asset,
        }),
        now,
        config,
        configVersion: ctx.version,
        configVersionId: ctx.versionId,
        metadata: { is_test: Boolean(env.is_test) },
      },
      t,
    );
    await cust.update(
      {
        fqtSlotState: FQT_SLOT.CONSUMED_PENDING,
        fqtFeature: env.feature,
        fqtPositionRef: env.position_ref,
        fqtReservedAt: now,
      },
      { transaction: t },
    );
    result.fqt.granted_vp = vp;
    result.fqt.grant_id = grant.id;
    result.fqt.slot_after = FQT_SLOT.CONSUMED_PENDING;

    // Referral Activation (A) — mengikuti posisi FQT B; butuh deposit qualified
    const link = await LoyaltyReferralLink.findOne({
      where: { refereeCoreId: cust.coreId, status: "VALID" },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (
      link &&
      link.depositQualified &&
      link.activationState === "NONE" &&
      config.referral.enabled !== false
    ) {
      const rawIdr = applyBps(
        env.qualified_amount_idr,
        config.referral.activation_rate_bps,
      );
      const bonus = min(rawIdr, BigInt(config.referral.activation_cap_idr));
      const { grant: aGrant } = await ledger.createIdrGrant(
        {
          coreId: link.referrerCoreId,
          category: CATEGORY.REFERRAL_ACTIVATION,
          businessKey: `REFERRAL_ACTIVATION:${link.id}`,
          idrAmount: bonus,
          linkId: link.id,
          counterpartyCoreId: cust.coreId,
          sourceSystem: env.source_system,
          sourceEventId: env.source_event_id,
          feature: env.feature,
          positionRef: env.position_ref,
          rateBps: config.referral.activation_rate_bps,
          capApplied: rawIdr > bonus,
          basisIdr: big(env.qualified_amount_idr),
          now,
          config,
          configVersion: ctx.version,
          configVersionId: ctx.versionId,
        },
        t,
      );
      await link.update(
        { activationState: "PENDING", activationPositionRef: env.position_ref },
        { transaction: t },
      );
      result.referral_activation = {
        referrer: link.referrerCoreId,
        idr: bonus,
        grant_id: aGrant.id,
      };
    }
  } else if (elig.ok) {
    result.fqt.reason = "SLOT_ALREADY_CONSUMED";
  }

  // --- Regular VP dari fee yang diakui saat open (Earn create / Loan initial draw)
  // Installment: fee baru dibayar saat gold claim -> tidak ada grant di sini.
  if (env.feature !== FEATURE.INSTALLMENT) {
    const reg = await grantRegular(ctx, {
      immediate: false,
      businessKey: `REGULAR:${env.feature}:${env.position_ref}:${env.source_event_id}`,
      tier,
    });
    if (reg)
      result.regular = {
        vp: reg.vp,
        grant_id: reg.grant.id,
        net_fee_idr: reg.fee.net,
      };
  }
  return result;
}

async function onFeeRecognized(ctx) {
  const { env, config, cust } = ctx;
  requireFields(env, ["feature", "position_ref"]);
  if (isPaused(config)) return { paused: true };
  const reg = await grantRegular(ctx, {
    immediate: false,
    businessKey: `REGULAR:${env.feature}:${env.position_ref}:${env.source_event_id}`,
    tier: cust.currentTier || TIER.CADET,
  });
  return reg
    ? {
        regular: {
          vp: reg.vp,
          grant_id: reg.grant.id,
          net_fee_idr: reg.fee.net,
        },
      }
    : { regular: null };
}

/** Sesuaikan vp grant PENDING ke basis final (Installment realized principal). */
async function adjustPendingVp(grant, newVp, { config }, t) {
  const old = big(grant.vpAmount);
  if (old === newVp) return grant;
  await ledger.postVp(
    {
      coreId: grant.coreId,
      grantId: grant.id,
      bucket: "PENDING",
      deltaVp: newVp - old,
      reasonCode: `${grant.category}_FINAL_BASIS`,
      idempotencyKey: `grant:${grant.id}:adjust:final`,
    },
    t,
  );
  await ledger.budgetApply(
    grant,
    { committedDelta: newVp - old, config, configVersion: grant.configVersion },
    t,
  );
  await grant.update(
    {
      vpAmount: newVp.toString(),
      metadata: { ...(grant.metadata || {}), original_vp: old.toString() },
    },
    { transaction: t },
  );
  return grant;
}

async function applyMonthlyProgress(ctx, { txRef, netFeeIdr }) {
  const { now, config, t, cust } = ctx;
  const m = config.monthly;
  if (!m.enabled) return { skipped: "DISABLED" };
  const key = monthKey(now, m.period_timezone || "Asia/Jakarta");
  const [progress] = await LoyaltyMonthlyProgress.findOrCreate({
    where: { coreId: cust.coreId, monthKey: key },
    defaults: { coreId: cust.coreId, monthKey: key, txRefs: [] },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  const refs = Array.isArray(progress.txRefs) ? progress.txRefs : [];
  if (refs.includes(txRef)) return { month: key, duplicate: true };
  const txCount = progress.txCount + 1;
  const netFee = big(progress.netFeeIdr) + big(netFeeIdr);
  const patch = {
    txCount,
    netFeeIdr: netFee.toString(),
    txRefs: [...refs, txRef],
  };
  const out = { month: key, tx_count: txCount, net_fee_idr: netFee };

  if (
    progress.milestoneState === "IN_PROGRESS" &&
    txCount >= Number(m.min_tx_count) &&
    netFee >= BigInt(m.min_net_fee_idr) &&
    !isPaused(config)
  ) {
    const tier = cust.currentTier || TIER.CADET;
    const { grant } = await ledger.createVpGrant(
      {
        coreId: cust.coreId,
        category: CATEGORY.MONTHLY,
        businessKey: `MONTHLY:${cust.coreId}:${key}`,
        vpAmount: BigInt(m.base_bonus_vp),
        immediate: true,
        sourceSystem: "loyalty",
        sourceEventId: `monthly:${cust.coreId}:${key}`,
        feature: FEATURE.MONTHLY,
        tierSnapshot: tier,
        multiplierBps: 10000,
        basisIdr: netFee,
        now,
        config,
        configVersion: ctx.version,
        configVersionId: ctx.versionId,
        metadata: { tx_count: txCount, tx_refs: patch.txRefs },
      },
      t,
    );
    Object.assign(patch, {
      milestoneState: "ACHIEVED",
      achievedAt: now,
      tierSnapshot: tier,
    });
    out.milestone = {
      achieved: true,
      vp: m.base_bonus_vp,
      grant_id: grant.id,
      tier,
    };
    if (
      configSvc.tierRank(config, tier) >=
      configSvc.tierRank(config, TIER.JUNIOR)
    ) {
      const { grant: booster } = await ledger.createVpGrant(
        {
          coreId: cust.coreId,
          category: CATEGORY.MONTHLY_BOOSTER,
          businessKey: `MONTHLY_BOOSTER:${cust.coreId}:${key}`,
          vpAmount: BigInt(m.junior_plus_booster_vp),
          immediate: true,
          sourceSystem: "loyalty",
          sourceEventId: `monthly-booster:${cust.coreId}:${key}`,
          feature: FEATURE.MONTHLY,
          tierSnapshot: tier,
          multiplierBps: 10000,
          now,
          config,
          configVersion: ctx.version,
          configVersionId: ctx.versionId,
        },
        t,
      );
      patch.boosterGranted = true;
      out.milestone.booster_vp = m.junior_plus_booster_vp;
      out.milestone.booster_grant_id = booster.id;
    }
  }
  await progress.update(patch, { transaction: t });
  return out;
}

async function onPositionSettled(ctx) {
  const { env, now, config, t, cust } = ctx;
  requireFields(env, ["feature", "position_ref"]);
  const result = {
    feature: env.feature,
    position_ref: env.position_ref,
    vested: [],
    regular: null,
  };

  // Installment: fee diakui & VP granted saat gold claim sukses (langsung AVAILABLE)
  if (env.feature === FEATURE.INSTALLMENT) {
    const reg = isPaused(config)
      ? null
      : await grantRegular(ctx, {
          immediate: true,
          businessKey: `REGULAR:${env.feature}:${env.position_ref}:${env.source_event_id}`,
          tier: cust.currentTier || TIER.CADET,
        });
    if (reg)
      result.regular = {
        vp: reg.vp,
        grant_id: reg.grant.id,
        net_fee_idr: reg.fee.net,
      };
  }

  const pending = await ledger.pendingGrantsForPosition(env.position_ref, t);
  for (const g of pending) {
    if (g.coreId !== cust.coreId && g.unit === "VP") continue;
    if (g.unit === "VP") {
      if (
        g.category === CATEGORY.FQT &&
        env.final_qualified_amount_idr !== undefined &&
        env.final_qualified_amount_idr !== null
      ) {
        // Installment: basis final = principal yang benar-benar dibayar
        const finalBasis = big(env.final_qualified_amount_idr);
        if (
          finalBasis < BigInt(config.first_qualified.min_qualified_amount_idr)
        ) {
          await ledger.voidGrant(
            g,
            { now, reason: "FINAL_BASIS_BELOW_MINIMUM", config },
            t,
          );
          await cust.update(
            { fqtSlotState: FQT_SLOT.CONSUMED_VOID },
            { transaction: t },
          );
          result.vested.push({
            grant_id: g.id,
            category: g.category,
            void: true,
          });
          continue;
        }
        const { vp } = rewardVp(
          finalBasis,
          g.rateBps,
          g.multiplierBps,
          config.first_qualified.cap_vp,
        );
        await adjustPendingVp(g, vp, { config }, t);
      }
      await ledger.vestGrant(
        g,
        { now, trigger: "POSITION_SETTLED", config },
        t,
      );
      if (g.category === CATEGORY.FQT) {
        await cust.update(
          { fqtSlotState: FQT_SLOT.CONSUMED_AVAILABLE },
          { transaction: t },
        );
      }
      result.vested.push({
        grant_id: g.id,
        category: g.category,
        vp: g.vpAmount,
      });
    } else {
      // Referral Activation (A) -> CLAIMABLE
      await ledger.makeClaimable(
        g,
        { now, trigger: "POSITION_SETTLED", config },
        t,
      );
      await LoyaltyReferralLink.update(
        { activationState: "GRANTED" },
        {
          where: {
            id: g.metadata?.link_id || null,
            activationState: "PENDING",
          },
          transaction: t,
        },
      );
      result.vested.push({
        grant_id: g.id,
        category: g.category,
        idr: g.idrAmount,
        claimable: true,
      });
    }
  }

  // Monthly milestone: satu settled economic transaction + total eligible net fee posisi
  const feeRows = await LoyaltyRewardGrant.findAll({
    where: {
      coreId: cust.coreId,
      category: CATEGORY.REGULAR,
      positionRef: env.position_ref,
      state: { [Op.in]: [VP_STATE.AVAILABLE, VP_STATE.PENDING] },
    },
    transaction: t,
  });
  const netFee = feeRows.reduce((s, g) => s + big(g.feeNetIdr || 0), 0n);
  result.monthly = await applyMonthlyProgress(ctx, {
    txRef: `${env.feature}:${env.position_ref}`,
    netFeeIdr: netFee,
  });
  return result;
}

async function onPositionFailed(ctx) {
  const { env, now, config, t, cust } = ctx;
  requireFields(env, ["feature", "position_ref"]);
  const result = {
    feature: env.feature,
    position_ref: env.position_ref,
    voided: [],
  };
  const pending = await ledger.pendingGrantsForPosition(env.position_ref, t);
  for (const g of pending) {
    if (g.unit === "VP") {
      await ledger.voidGrant(
        g,
        { now, reason: env.reason || "POSITION_FAILED", config },
        t,
      );
      if (g.category === CATEGORY.FQT) {
        // Slot tetap CONSUMED — tidak ada replacement untuk posisi berikutnya
        await cust.update(
          { fqtSlotState: FQT_SLOT.CONSUMED_VOID },
          { transaction: t },
        );
      }
    } else {
      await ledger.voidIdrGrant(
        g,
        { now, reason: env.reason || "POSITION_FAILED", config },
        t,
      );
      await LoyaltyReferralLink.update(
        { activationState: "VOID" },
        { where: { id: g.metadata?.link_id || null }, transaction: t },
      );
    }
    result.voided.push({ grant_id: g.id, category: g.category });
  }
  return result;
}

async function onSwapSettled(ctx) {
  const { env, config, cust } = ctx;
  requireFields(env, ["source_transaction_id"]);
  env.feature = FEATURE.SWAP;
  const result = {
    feature: FEATURE.SWAP,
    source_transaction_id: env.source_transaction_id,
  };
  if (isPaused(config)) {
    result.paused = true;
    return result;
  }
  const reg = await grantRegular(ctx, {
    immediate: true,
    businessKey: `REGULAR:SWAP:${env.source_transaction_id}`,
    tier: cust.currentTier || TIER.CADET,
  });
  result.regular = reg
    ? { vp: reg.vp, grant_id: reg.grant.id, net_fee_idr: reg.fee.net }
    : null;
  result.monthly = await applyMonthlyProgress(ctx, {
    txRef: `SWAP:${env.source_transaction_id}`,
    netFeeIdr: reg ? reg.fee.net : eligibleNetFee(env).net,
  });
  return result;
}

async function onSwapReversed(ctx) {
  const { env, now, config, t } = ctx;
  requireFields(env, ["source_transaction_id"]);
  const g = await LoyaltyRewardGrant.findOne({
    where: { businessKey: `REGULAR:SWAP:${env.source_transaction_id}` },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!g) return { reversed: false };
  if (g.state === VP_STATE.AVAILABLE)
    await ledger.reverseGrant(g, { now, reason: "SWAP_REVERSED", config }, t);
  else if (g.state === VP_STATE.PENDING)
    await ledger.voidGrant(g, { now, reason: "SWAP_REVERSED", config }, t);
  return { reversed: true, grant_id: g.id, state: g.state };
}

const HANDLERS = {
  [EVENT.CUSTOMER_REGISTERED]: onCustomerRegistered,
  [EVENT.DEPOSIT_CONFIRMED]: onDepositConfirmed,
  [EVENT.DEPOSIT_REVERSED]: onDepositReversed,
  [EVENT.POSITION_OPENED]: onPositionOpened,
  [EVENT.FEE_RECOGNIZED]: onFeeRecognized,
  [EVENT.POSITION_SETTLED]: onPositionSettled,
  [EVENT.POSITION_FAILED]: onPositionFailed,
  [EVENT.SWAP_SETTLED]: onSwapSettled,
  [EVENT.SWAP_REVERSED]: onSwapReversed,
};

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Proses satu event. Return { status: PROCESSED|DUPLICATE|FAILED, result }.
 * Tidak pernah throw untuk error bisnis — dicatat FAILED (retryable) agar
 * poller produk tidak terganggu.
 */
async function ingest(envelope) {
  const env = { ...envelope };
  try {
    requireFields(env, [
      "source_system",
      "source_event_id",
      "event_type",
      "core_id",
      "occurred_at",
    ]);
  } catch (error) {
    return { status: "FAILED", error: error.message, retryable: false };
  }
  const handler = HANDLERS[env.event_type];
  if (!handler)
    return {
      status: "FAILED",
      error: `event_type ${env.event_type} tidak dikenal`,
      retryable: false,
    };
  const now = new Date(env.occurred_at);
  if (Number.isNaN(now.getTime()))
    return { status: "FAILED", error: "occurred_at invalid", retryable: false };

  const existing = await LoyaltyProcessedEvent.findOne({
    where: {
      sourceSystem: env.source_system,
      sourceEventId: env.source_event_id,
    },
  });
  if (existing && existing.processingStatus !== "FAILED") {
    return {
      status: "DUPLICATE",
      result: existing.result,
      processed_at: existing.processedAt,
    };
  }

  try {
    const result = await sequelize.transaction(async (t) => {
      const [processed, created] = await LoyaltyProcessedEvent.findOrCreate({
        where: {
          sourceSystem: env.source_system,
          sourceEventId: env.source_event_id,
        },
        defaults: {
          sourceSystem: env.source_system,
          sourceEventId: env.source_event_id,
          eventType: env.event_type,
          coreId: env.core_id,
          payloadHash: payloadHash(env),
          processingStatus: "PROCESSING",
          occurredAt: now,
        },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!created && processed.processingStatus !== "FAILED") {
        return { __duplicate: true, result: processed.result };
      }
      const resolved = await configSvc.resolve(now);
      const cust = await ledger.ensureCustomer(env.core_id, {
        now,
        transaction: t,
        lock: true,
      });
      const ctx = {
        env,
        now,
        config: resolved.config,
        version: resolved.version,
        versionId: resolved.versionId,
        t,
        cust,
      };
      const out = await handler(ctx);
      const safe = toJsonSafe({ ...out, config_version: resolved.version });
      await processed.update(
        {
          processingStatus: "PROCESSED",
          result: safe,
          processedAt: new Date(),
          attemptCount: processed.attemptCount + (created ? 0 : 1),
          error: null,
        },
        { transaction: t },
      );
      return safe;
    });
    if (result && result.__duplicate)
      return { status: "DUPLICATE", result: result.result };
    return { status: "PROCESSED", result };
  } catch (error) {
    const unique = /unique|duplicate key/i.test(
      String(error.message || error.parent?.message || ""),
    );
    if (unique && !(error instanceof LoyaltyError)) {
      return { status: "DUPLICATE", result: null };
    }
    const retryable =
      !(error instanceof LoyaltyError) || error.details?.retryable !== false;
    await LoyaltyProcessedEvent.findOrCreate({
      where: {
        sourceSystem: env.source_system,
        sourceEventId: env.source_event_id,
      },
      defaults: {
        sourceSystem: env.source_system,
        sourceEventId: env.source_event_id,
        eventType: env.event_type,
        coreId: env.core_id,
        payloadHash: payloadHash(env),
        processingStatus: "FAILED",
        occurredAt: now,
        error: String(error.message || error),
        result: { envelope: toJsonSafe(env), retryable },
      },
    })
      .then(([row, created]) =>
        created
          ? null
          : row.update({
              processingStatus: "FAILED",
              error: String(error.message || error),
              attemptCount: row.attemptCount + 1,
              result: { envelope: toJsonSafe(env), retryable },
            }),
      )
      .catch(() => {});
    console.error(
      `[Loyalty] ingest ${env.event_type} ${env.source_event_id} failed:`,
      error.message,
    );
    return {
      status: "FAILED",
      error: error.message,
      code: error.code,
      retryable,
    };
  }
}

module.exports = {
  ingest,
  monthKey,
  rewardVp,
  eligibleNetFee,
  fqtEligible,
  HANDLERS,
  LoyaltyCustomer,
};
