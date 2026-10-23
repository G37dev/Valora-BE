/*
 * QA Swap — quote math + validation + idempotency (SWA cases, service level).
 *   node scripts/test-swap-qa.js
 */
require("dotenv").config();
const Decimal = require("decimal.js");
const svc = require("../services/swap/swap.service");
const { sequelize, Price, InternalWallet } = require("../models");

let fails = 0;
const check = (name, cond, extra = "") => {
  if (!cond) fails++;
  console.log(
    `${cond ? "  PASS" : "  FAIL"} ${name}${extra ? " — " + extra : ""}`,
  );
};
const expectThrow = async (name, fn, match) => {
  try {
    await fn();
    check(name, false, "no throw");
  } catch (e) {
    check(name, !match || e.message.includes(match), e.message.slice(0, 90));
  }
};

(async () => {
  await sequelize.authenticate();
  const price = async (a) => {
    if (a === "IDR") return new Decimal(1);
    const p = await Price.findOne({ where: { asset: a } });
    return new Decimal(p.priceIdr);
  };
  const FEE = svc.SWAP_FEE_RATE;
  const XAUT_G = new Decimal("31.1035");
  check("fee rate = 0.35%", FEE.eq("0.0035"), FEE.toString());

  console.log("== SWA quote math (fee 0.35%, floor rounding)");
  {
    const pU = await price("USDT");
    const q = await svc.calculateSwapQuote({
      fromAmount: "100",
      fromPriceIdr: pU,
      toPriceIdr: new Decimal(1),
      fromAsset: "USDT",
      toAsset: "IDR",
    });
    const gross = new Decimal(100).mul(pU);
    const fee = gross.mul(FEE);
    const net = gross.sub(fee);
    check("USDT→IDR gross", q.grossValueIdr.eq(gross));
    check("USDT→IDR fee = gross*0.35%", q.feeAmountIdr.eq(fee));
    const expNet = net.mul(100).floor().div(100);
    check(
      "USDT→IDR receive = floor(net, 2dp)",
      q.receiveAmount.eq(expNet),
      `recv=${q.receiveAmount} exp=${expNet}`,
    );
  }
  {
    const pX = await price("XAUT");
    const q = await svc.calculateSwapQuote({
      fromAmount: "0.001",
      fromPriceIdr: pX,
      toPriceIdr: new Decimal(1),
      fromAsset: "XAUT",
      toAsset: "IDR",
    });
    const gross = new Decimal("0.001").mul(XAUT_G).mul(pX);
    check(
      "XAUT→IDR uses gram multiplier x31.1035",
      q.grossValueIdr.eq(gross),
      `gross=${gross.toFixed(0)}`,
    );
    const expX = gross.mul(new Decimal(1).sub(FEE)).mul(100).floor().div(100);
    check(
      "XAUT→IDR receive = floor(net, 2dp)",
      q.receiveAmount.eq(expX),
      `recv=${q.receiveAmount} exp=${expX}`,
    );
  }
  {
    const pU = await price("USDT"),
      pA = await price("USDC");
    const q = await svc.calculateSwapQuote({
      fromAmount: "10",
      fromPriceIdr: pU,
      toPriceIdr: pA,
      fromAsset: "USDT",
      toAsset: "USDC",
    });
    const net = new Decimal(10).mul(pU).mul(new Decimal(1).sub(FEE));
    const exp = net
      .div(pA)
      .mul(new Decimal(10).pow(6))
      .floor()
      .div(new Decimal(10).pow(6));
    check(
      "USDT→USDC receive = floor(net/toPrice, 6dec)",
      q.receiveAmount.eq(exp),
      `recv=${q.receiveAmount}`,
    );
    check("USDT→USDC fee in to-asset", q.feeAmount.gt(0));
  }

  console.log("== Tiny/zero amount");
  await expectThrow(
    "amount 0 → error",
    () =>
      svc.calculateSwapQuote({
        fromAmount: "0",
        fromPriceIdr: new Decimal(1),
        toPriceIdr: new Decimal(1),
        fromAsset: "USDT",
        toAsset: "IDR",
      }),
    "lebih besar",
  );
  await expectThrow("tiny XAUT → receive<=0 reject", () =>
    svc.calculateSwapQuote({
      fromAmount: "0.0000001",
      fromPriceIdr: new Decimal(1),
      toPriceIdr: new Decimal("99999999999999"),
      fromAsset: "XAUT",
      toAsset: "IDR",
    }),
  );
  await expectThrow(
    "negative → error",
    () =>
      svc.calculateSwapQuote({
        fromAmount: "-5",
        fromPriceIdr: new Decimal(1),
        toPriceIdr: new Decimal(1),
        fromAsset: "USDT",
        toAsset: "IDR",
      }),
    "lebih besar",
  );

  console.log("== Only DUMMY assets configured (SWA-001)");
  for (const a of ["USDT", "USDC", "GOLD", "XAUT"]) {
    const tok = svc.ASSETS[a] && svc.ASSETS[a].tokenAddress;
    check(`${a} tokenAddress = DUMMY env`, !!tok, tok);
  }
  check(
    "USDT addr == USDT_DUMMY_CONTRACT_ADDRESS",
    svc.ASSETS.USDT.tokenAddress === process.env.USDT_DUMMY_CONTRACT_ADDRESS,
  );

  console.log("== createSwapService validation");
  await expectThrow(
    "same asset reject",
    () =>
      svc.createSwapService({
        coreId: "qa",
        fromAsset: "USDT",
        toAsset: "USDT",
        fromAmount: "1",
        idempotencyKey: "qa-x",
      }),
    "tidak boleh sama",
  );
  await expectThrow(
    "missing idempotencyKey",
    () =>
      svc.createSwapService({
        coreId: "qa",
        fromAsset: "USDT",
        toAsset: "IDR",
        fromAmount: "1",
      }),
    "idempotencyKey",
  );
  await expectThrow(
    "blockchain fromAsset w/o wallet → reject",
    () =>
      svc.createSwapService({
        coreId: "qa",
        fromAsset: "USDT",
        toAsset: "IDR",
        fromAmount: "1",
        idempotencyKey: "qa-y",
      }),
    "fromWalletAddress",
  );
  await expectThrow(
    "invalid asset reject",
    () =>
      svc.createSwapService({
        coreId: "qa",
        fromAsset: "BTC",
        toAsset: "IDR",
        fromAmount: "1",
        idempotencyKey: "qa-z",
      }),
    "tidak didukung",
  );
  await expectThrow("non-numeric amount reject", () =>
    svc.createSwapService({
      coreId: "qa",
      fromAsset: "USDT",
      toAsset: "IDR",
      fromAmount: "abc",
      idempotencyKey: "qa-n",
    }),
  );

  console.log("== Insufficient internal wallet (IDR→USDT)");
  const TW = process.env.QA_CORE_ID || "RABv8pXT";
  const wallet = await InternalWallet.findOne({ where: { coreId: TW } });
  const origBal = wallet ? wallet.balanceIdr : null;
  await InternalWallet.update({ balanceIdr: 1000 }, { where: { coreId: TW } });
  await expectThrow("IDR balance < amount → error", () =>
    svc.createSwapService({
      coreId: TW,
      fromAsset: "IDR",
      toAsset: "USDT",
      fromAmount: "999999999",
      idempotencyKey: `qa-insuff-${Date.now()}`,
      toWalletAddress: "0x000000000000000000000000000000000000dEaD",
    }),
  );
  if (origBal !== null) {
    await InternalWallet.update(
      { balanceIdr: origBal },
      { where: { coreId: TW } },
    );
  }

  console.log("== Idempotency replay (SWA dedup)");
  const { Swap } = require("../models");
  const key = `qa-idem-${Date.now()}`;
  const row = await Swap.create({
    coreId: TW,
    idempotencyKey: key,
    fromAsset: "IDR",
    toAsset: "USDT",
    fromAmount: "50000",
    toAmount: "3.1",
    receiveAmount: "3.1",
    fromType: "INTERNAL",
    toType: "BLOCKCHAIN",
    status: "PENDING",
  });
  {
    const again = await svc.createSwapService({
      coreId: TW,
      fromAsset: "IDR",
      toAsset: "USDT",
      fromAmount: "50000",
      idempotencyKey: key,
      toWalletAddress: "0x000000000000000000000000000000000000dEaD",
    });
    check(
      "same key + same params → returns existing (no dup)",
      again.existing === true && again.swap.id === row.id,
    );
    const cnt = await Swap.count({ where: { idempotencyKey: key } });
    check("no duplicate row created", cnt === 1, `count=${cnt}`);
  }
  await expectThrow(
    "same key + different params → reject",
    () =>
      svc.createSwapService({
        coreId: TW,
        fromAsset: "IDR",
        toAsset: "USDC",
        fromAmount: "50000",
        idempotencyKey: key,
        toWalletAddress: "0x000000000000000000000000000000000000dEaD",
      }),
    "Idempotency key sudah digunakan",
  );
  await Swap.destroy({ where: { id: row.id } }).catch(() => {});

  console.log(fails ? `\n${fails} FAILED` : "\nALL PASS");
  await sequelize.close();
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
