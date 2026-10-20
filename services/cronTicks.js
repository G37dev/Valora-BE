/*
 * Ticks untuk Vercel Cron — pengganti worker.js di serverless.
 *
 * - tickLoan / tickPrice       : wrapper scheduler/fungsi yang sudah ada
 * - drainQueues                : hidupkan BullMQ Worker (module cache di
 *   warm instance) lalu tunggu queue kosong sampai batas waktu
 * - tickChainEvents            : polling getContractEvents dengan
 *   last-block checkpoint di tabel cron_checkpoints — pengganti
 *   watchContractEvents (yang sebenarnya HTTP polling juga)
 *
 * Semua handler event sama dengan listener lokal — dedupe by tx_hash
 * sudah ada di masing-masing handler, jadi overlap/tick ganda aman.
 */

const { getContract, getContractEvents, prepareEvent } = require("thirdweb");
const { getRpcClient, eth_blockNumber } = require("thirdweb/rpc");
const { Queue } = require("bullmq");

const bl = require("./blockchainListener");
const el = require("./earnListener");
const loanScheduler = require("./loan/loan.scheduler");
const { syncTokenPrices } = require("../controllers/priceController");
const businessClock = require("./businessClock");
const { CronCheckpoint } = require("../models");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
// Loan + Price — wrapper langsung
// ------------------------------------------------------------------

async function tickLoan() {
  const now = await businessClock.current();
  return loanScheduler.tick(now);
}

async function tickPrice() {
  await syncTokenPrices();
  return { ok: true };
}

// ------------------------------------------------------------------
// BullMQ queue drain — Worker hidup di module cache selama instance
// warm; tiap invocation cukup pastikan running lalu tunggu antrean
// habis (pending jobs diproses Worker seperti biasa).
// ------------------------------------------------------------------

const QUEUE_WORKERS = {
  swap: "../workers/swap.worker",
  earn: "../workers/earn.worker",
  "earn-claim": "../workers/earn-claim.worker",
};

async function drainQueue(name, timeoutMs = 40_000) {
  const modPath = QUEUE_WORKERS[name];
  const worker = require(modPath);
  if (
    typeof worker.run === "function" &&
    worker.isRunning &&
    !worker.isRunning()
  ) {
    await worker.run().catch(() => {});
  }

  const queue = new Queue(name, { connection: worker.opts.connection });
  const deadline = Date.now() + timeoutMs;
  let emptyStreak = 0;
  let lastCounts = null;
  try {
    while (Date.now() < deadline) {
      const c = await queue.getJobCounts(
        "wait",
        "active",
        "delayed",
        "prioritized",
        "paused",
      );
      lastCounts = c;
      const pending =
        (c.wait || 0) +
        (c.active || 0) +
        (c.delayed || 0) +
        (c.prioritized || 0) +
        (c.paused || 0);
      if (pending === 0) {
        if (++emptyStreak >= 2) break;
      } else {
        emptyStreak = 0;
      }
      await sleep(1000);
    }
  } finally {
    await queue.close().catch(() => {});
    // Serverless: tutup koneksi Redis worker+shared conn supaya
    // tidak numpuk sampai kena 'max number of clients'.
    await worker.close().catch(() => {});
    await worker.opts?.connection?.quit?.().catch(() => {});
    delete require.cache[require.resolve(modPath)];
  }
  return { queue: name, drained: emptyStreak >= 2, counts: lastCounts };
}

async function drainAllQueues(timeoutMs = 40_000) {
  const perQueue = Math.max(10_000, Math.floor(timeoutMs / 3));
  const out = {};
  for (const name of Object.keys(QUEUE_WORKERS)) {
    try {
      out[name] = await drainQueue(name, perQueue);
    } catch (error) {
      out[name] = { error: error.message };
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Chain events polling — pengganti watchContractEvents.
// ------------------------------------------------------------------

const BLOCK_CHUNK = 5_000n;
const CONFIRMATIONS = 12n;
const BOOTSTRAP_LOOKBACK = 8_000n;
const MAX_CHUNKS_PER_CONTRACT = 10;

const transferEvent = prepareEvent({
  signature:
    "event Transfer(address indexed from,address indexed to,uint256 value)",
});
const earnCreatedEvent = prepareEvent({
  signature:
    "event EarnPositionCreated(address indexed user, uint256 indexed positionId, uint256 principal, uint64 maturityAt, uint16 aprBps)",
});
const earnClaimedEvent = prepareEvent({
  signature:
    "event EarnPositionClaimed(address indexed user, uint256 indexed positionId, uint256 principal, uint256 reward)",
});

async function readCheckpoint(key, fallback) {
  const row = await CronCheckpoint.findByPk(key);
  if (!row) return fallback;
  try {
    return BigInt(row.value);
  } catch {
    return fallback;
  }
}

async function writeCheckpoint(key, value) {
  await CronCheckpoint.upsert({ key, value: value.toString() });
}

async function pollRange({ contract, key, safeHead, fetchEvents, handle }) {
  let from = await readCheckpoint(key, safeHead - BOOTSTRAP_LOOKBACK);
  let processed = 0;
  let chunks = 0;
  while (from <= safeHead && chunks < MAX_CHUNKS_PER_CONTRACT) {
    const to =
      from + BLOCK_CHUNK - 1n > safeHead ? safeHead : from + BLOCK_CHUNK - 1n;
    const events = await fetchEvents(contract, from, to);
    for (const event of events) {
      await handle(event);
      processed += 1;
    }
    from = to + 1n;
    chunks += 1;
  }
  const done = from > safeHead;
  await writeCheckpoint(key, done ? safeHead : from - 1n);
  return { processed, done, next_from: from.toString() };
}

async function tickChainEvents() {
  const rpc = getRpcClient({ client: bl.client, chain: bl.customSepolia });
  const latest = await eth_blockNumber(rpc);
  const safeHead = latest - CONFIRMATIONS;
  const out = { latest_block: Number(latest), safe_head: Number(safeHead) };

  const fetchEvents = (contract, from, to, events) =>
    getContractEvents({ contract, fromBlock: from, toBlock: to, events });

  for (const token of bl.getTokensToWatch().filter((t) => t.address)) {
    const contract = getContract({
      client: bl.client,
      chain: bl.customSepolia,
      address: token.address,
    });
    try {
      out[`token:${token.name}`] = await pollRange({
        contract,
        key: `chain_evt:token:${token.address.toLowerCase()}`,
        safeHead,
        fetchEvents: (c, f, t) => fetchEvents(c, f, t, [transferEvent]),
        handle: (event) => bl.handleTransferEvent({ event, token }),
      });
    } catch (error) {
      out[`token:${token.name}`] = { error: error.message };
    }
  }

  for (const pool of el.getEarnPoolsToWatch().filter((p) => p.address)) {
    const contract = getContract({
      client: bl.client,
      chain: bl.customSepolia,
      address: pool.address,
    });
    const baseKey = `chain_evt:earn:${pool.address.toLowerCase()}`;
    try {
      const created = await pollRange({
        contract,
        key: `${baseKey}:created`,
        safeHead,
        fetchEvents: (c, f, t) => fetchEvents(c, f, t, [earnCreatedEvent]),
        handle: (event) => el.handleEarnCreatedEvent({ event, pool }),
      });
      const claimed = await pollRange({
        contract,
        key: `${baseKey}:claimed`,
        safeHead,
        fetchEvents: (c, f, t) => fetchEvents(c, f, t, [earnClaimedEvent]),
        handle: (event) => el.handleEarnClaimedEvent({ event, pool }),
      });
      out[`earn:${pool.asset}`] = {
        created: created.processed,
        claimed: claimed.processed,
        done: created.done && claimed.done,
      };
    } catch (error) {
      out[`earn:${pool.asset}`] = { error: error.message };
    }
  }

  return out;
}

// ------------------------------------------------------------------
// Earn maturity forecast + treasury monitor (brief §8–14)
// Per-pool: liquid balance vs liabilities vs maturing positions
// di horizon D-1/D-3/D-7/D-10.
// ------------------------------------------------------------------

const MATURITY_HORIZONS = [1, 3, 7, 10];

async function tickEarnTreasury() {
  const { EarnPosition } = require("../models");
  const {
    getEarnPoolAddress,
    getTokenContract,
    readContract: _rc,
  } = require("./earn/earn.blockchain.service");
  const { readContract } = require("thirdweb");
  const { LEGACY_EARN_POOLS } = require("./earn/earn.constants");
  const { Op } = require("sequelize");

  const report = {};
  const now = Date.now();

  for (const asset of ["USDT", "USDC", "GOLD", "XAUT"]) {
    const pools = [];
    try {
      pools.push({ label: "v2", address: getEarnPoolAddress(asset) });
    } catch {}
    if (LEGACY_EARN_POOLS[asset]) {
      pools.push({ label: "v1", address: LEGACY_EARN_POOLS[asset] });
    }

    const poolReports = [];
    for (const pool of pools) {
      try {
        const contract = getContract({
          client: bl.client,
          chain: bl.customSepolia,
          address: pool.address,
        });
        const tokenAddr = (
          await readContract({
            contract,
            method: "function assetToken() view returns (address)",
            params: [],
          })
        ).toString();
        const token = getContract({
          client: bl.client,
          chain: bl.customSepolia,
          address: tokenAddr,
        });
        const [liquid, principalLiab, rewardLiab] = await Promise.all([
          readContract({
            contract: token,
            method: "function balanceOf(address) view returns (uint256)",
            params: [pool.address],
          }),
          readContract({
            contract,
            method: "function totalPrincipalLiability() view returns (uint256)",
            params: [],
          }),
          readContract({
            contract,
            method: "function totalRewardLiability() view returns (uint256)",
            params: [],
          }),
        ]);

        // Posisi ACTIVE di DB untuk pool ini, matang <= 10 hari
        const positions = await EarnPosition.findAll({
          where: {
            asset,
            status: "ACTIVE",
            poolAddress: pool.address,
            maturityAt: {
              [Op.lte]: new Date(now + 10 * 86400_000),
            },
          },
          attributes: ["id", "positionId", "principal", "maturityAt"],
        });

        const horizons = {};
        for (const d of MATURITY_HORIZONS) {
          const due = positions.filter(
            (p) =>
              p.maturityAt &&
              new Date(p.maturityAt).getTime() <= now + d * 86400_000,
          );
          horizons[`d${d}`] = {
            count: due.length,
            principal: due
              .reduce((s, p) => s + BigInt(p.principal || 0), 0n)
              .toString(),
          };
        }

        const totalLiab = BigInt(principalLiab) + BigInt(rewardLiab);
        poolReports.push({
          pool: pool.address,
          version: pool.label,
          liquid: BigInt(liquid).toString(),
          principal_liability: BigInt(principalLiab).toString(),
          reward_liability: BigInt(rewardLiab).toString(),
          total_liability: totalLiab.toString(),
          liquidity_ok: BigInt(liquid) >= totalLiab,
          shortfall:
            BigInt(liquid) >= totalLiab
              ? "0"
              : (totalLiab - BigInt(liquid)).toString(),
          maturing: horizons,
        });
      } catch (e) {
        poolReports.push({
          pool: pool.address,
          version: pool.label,
          error: e.message,
        });
      }
    }
    report[asset] = poolReports;
  }

  console.log("[earn-treasury]", JSON.stringify(report));
  return report;
}

module.exports = {
  tickLoan,
  tickPrice,
  drainQueue,
  drainAllQueues,
  tickChainEvents,
  tickEarnTreasury,
};
