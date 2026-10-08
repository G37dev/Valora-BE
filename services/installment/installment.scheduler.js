/*
 * Scheduler Gold Installment.
 *
 * Cron hanya PEMICU; waktu finansial efektif diambil dari state plan
 * (next_event_at, anniversary, maturity, cure_ends_at, ...). Jika cron telat,
 * settleToNow tetap memakai timestamp terjadwal (brief 16.2 / BND-03).
 */

const cron = require("node-cron");
const { Op } = require("sequelize");
const { InstallmentPlan } = require("../../models");
const { settlePlan } = require("./installment.service");
const { TERMINAL_STATUSES } = require("./installment.constants");
const clock = require("./installment.clock");

const BATCH_SIZE = Number(process.env.INSTALLMENT_SCHEDULER_BATCH ?? 50);
let running = false;

async function tick(now = clock.now()) {
  if (running) return { skipped: true };
  running = true;

  let processed = 0;
  let failed = 0;
  try {
    const due = await InstallmentPlan.findAll({
      attributes: ["id"],
      where: {
        nextEventAt: { [Op.lte]: now },
        status: { [Op.notIn]: TERMINAL_STATUSES },
      },
      order: [["next_event_at", "ASC"]],
      limit: BATCH_SIZE,
    });

    for (const { id } of due) {
      try {
        await settlePlan(id, now);
        processed += 1;
      } catch (error) {
        failed += 1;
        console.error(
          `[INSTALLMENT SCHEDULER] plan ${id} gagal:`,
          error.message,
        );
      }
    }

    if (processed || failed) {
      console.log(
        `[INSTALLMENT SCHEDULER] processed=${processed} failed=${failed}`,
      );
    }
  } catch (error) {
    console.error("[INSTALLMENT SCHEDULER] tick error:", error.message);
  } finally {
    running = false;
  }

  return { processed, failed };
}

function startInstallmentScheduler() {
  const task = cron.schedule("* * * * *", () => tick());
  console.log(
    "[INSTALLMENT SCHEDULER] aktif (tiap 1 menit, effective-time based).",
  );
  return task;
}

module.exports = { startInstallmentScheduler, tick };
