/*
 * Calendar engine untuk Gold Installment.
 *
 * Aritmatika bulan dilakukan pada "wall clock" zona waktu bisnis
 * (default WIB, UTC+7) supaya semantik "tanggal 31 -> hari terakhir bulan"
 * konsisten, lalu dikembalikan ke instant UTC untuk disimpan (TIMESTAMPTZ).
 *
 * Anniversary SELALU dihitung dari anchor (activation), bukan chaining,
 * sehingga 31 Jan -> 28 Feb -> 31 Mar -> 30 Apr -> 31 May (Gambar 7).
 */

const TZ_OFFSET_MINUTES = Number(
  process.env.INSTALLMENT_TZ_OFFSET_MINUTES ?? 420,
);

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Tanggal tidak valid: ${value}`);
  }
  return date;
}

function toLocal(date) {
  return new Date(toDate(date).getTime() + TZ_OFFSET_MINUTES * MS_PER_MINUTE);
}

function fromLocal(local) {
  return new Date(local.getTime() - TZ_OFFSET_MINUTES * MS_PER_MINUTE);
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Tambah n bulan kalender dengan last-day fallback.
 * Hari-dalam-bulan anchor dipertahankan jika ada di bulan target.
 */
function addMonths(anchor, months) {
  const local = toLocal(anchor);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();

  const totalMonths = month + Number(months);
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonth = ((totalMonths % 12) + 12) % 12;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));

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

function addDays(date, days) {
  return new Date(toDate(date).getTime() + Number(days) * MS_PER_DAY);
}

function addHours(date, hours) {
  return new Date(toDate(date).getTime() + Number(hours) * MS_PER_HOUR);
}

/** 00:00 wall-clock zona bisnis pada hari yang sama. */
function startOfDay(date) {
  const local = toLocal(date);
  return fromLocal(
    new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()),
    ),
  );
}

/**
 * Batas kalender (jatuh tempo, anniversary, maturity, cure, claimable)
 * diseragamkan ke 00:00 zona bisnis. Aktivasi 5 Mar 03:00 -> 5 Apr 00:00.
 */
function calendarMonthsFrom(anchor, months) {
  return startOfDay(addMonths(anchor, months));
}

function calendarDaysFrom(anchor, days) {
  return startOfDay(addDays(anchor, days));
}

/** Anniversary ke-k (k >= 1) dari activation, jam 00:00. */
function anniversaryAt(activatedAt, k) {
  return calendarMonthsFrom(activatedAt, k);
}

/** Jumlah hari penuh (floor) dari `from` ke `to`; 0 jika to <= from. */
function fullDaysBetween(from, to) {
  const diff = toDate(to).getTime() - toDate(from).getTime();
  return diff <= 0 ? 0 : Math.floor(diff / MS_PER_DAY);
}

function isAfterOrEqual(a, b) {
  return toDate(a).getTime() >= toDate(b).getTime();
}

function minDate(...dates) {
  const valid = dates.filter(Boolean).map(toDate);
  return valid.length
    ? new Date(Math.min(...valid.map((d) => d.getTime())))
    : null;
}

module.exports = {
  TZ_OFFSET_MINUTES,
  MS_PER_DAY,
  addMonths,
  addDays,
  addHours,
  startOfDay,
  calendarMonthsFrom,
  calendarDaysFrom,
  anniversaryAt,
  fullDaysBetween,
  isAfterOrEqual,
  minDate,
  toDate,
};
