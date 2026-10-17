/*
 * Calendar engine Loan.
 *
 * Monthly Anniversary = recurrence kalender dari activation (wall-clock
 * zona bisnis, default WIB). Jika tanggal tidak ada di bulan target, pakai
 * hari terakhir bulan; anchor TIDAK drift (selalu dihitung dari activation,
 * bukan chaining) — brief 06 / A.3.
 *
 * Jam:menit:detik activation dipertahankan sehingga prorata
 * segment_elapsed_seconds / calendar_cycle_seconds eksak.
 *
 * Maturity = activation + tenor hari kalender (instant eksak).
 * PDP day = setiap interval 24 jam PENUH setelah maturity_at (A.3).
 */

const TZ_OFFSET_MINUTES = Number(process.env.LOAN_TZ_OFFSET_MINUTES ?? 420);

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

const toLocal = (date) =>
  new Date(toDate(date).getTime() + TZ_OFFSET_MINUTES * MS_PER_MINUTE);
const fromLocal = (local) =>
  new Date(local.getTime() - TZ_OFFSET_MINUTES * MS_PER_MINUTE);

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addMonths(anchor, months) {
  const local = toLocal(anchor);
  const totalMonths = local.getUTCMonth() + Number(months);
  const targetYear = local.getUTCFullYear() + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const targetDay = Math.min(
    local.getUTCDate(),
    daysInMonth(targetYear, targetMonth),
  );
  return fromLocal(
    new Date(
      Date.UTC(
        targetYear,
        targetMonth,
        targetDay,
        local.getUTCHours(),
        local.getUTCMinutes(),
        local.getUTCSeconds(),
        local.getUTCMilliseconds(),
      ),
    ),
  );
}

const addDays = (date, days) =>
  new Date(toDate(date).getTime() + Number(days) * MS_PER_DAY);
const addHours = (date, hours) =>
  new Date(toDate(date).getTime() + Number(hours) * MS_PER_HOUR);
const addSeconds = (date, seconds) =>
  new Date(toDate(date).getTime() + Number(seconds) * 1000);

/** Anniversary ke-k (k >= 1) dari activation. */
const anniversaryAt = (activatedAt, k) => addMonths(activatedAt, k);

/** Jumlah anniversary yang sudah lewat (<= at). */
function anniversariesPassed(activatedAt, at) {
  const t = toDate(at).getTime();
  let k = 0;
  while (anniversaryAt(activatedAt, k + 1).getTime() <= t) k += 1;
  return k;
}

/** Interval 24 jam PENUH dari `from` ke `to`; 0 jika to <= from. */
function fullDaysBetween(from, to) {
  const diff = toDate(to).getTime() - toDate(from).getTime();
  return diff <= 0 ? 0 : Math.floor(diff / MS_PER_DAY);
}

const secondsBetween = (from, to) =>
  Math.max(0, (toDate(to).getTime() - toDate(from).getTime()) / 1000);

const isAfterOrEqual = (a, b) => toDate(a).getTime() >= toDate(b).getTime();
const isBefore = (a, b) => toDate(a).getTime() < toDate(b).getTime();

function minDate(...dates) {
  const valid = dates.filter(Boolean).map(toDate);
  return valid.length
    ? new Date(Math.min(...valid.map((d) => d.getTime())))
    : null;
}

/** Hari Minggu zona bisnis (VVLR scheduled no-update). */
const isBusinessSunday = (date) => toLocal(date).getUTCDay() === 0;

module.exports = {
  TZ_OFFSET_MINUTES,
  MS_PER_DAY,
  MS_PER_HOUR,
  toDate,
  addMonths,
  addDays,
  addHours,
  addSeconds,
  anniversaryAt,
  anniversariesPassed,
  fullDaysBetween,
  secondsBetween,
  isAfterOrEqual,
  isBefore,
  minDate,
  isBusinessSunday,
};
