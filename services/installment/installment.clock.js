/*
 * Test clock untuk Gold Installment.
 *
 * Production: now() selalu waktu server nyata.
 * Testing: set INSTALLMENT_TEST_CLOCK=1 lalu kirim header
 *   X-Installment-Now: 2027-04-05T00:00:00+07:00
 * pada request apa pun (create/pay/cancel/restructure/detail), atau set env
 * INSTALLMENT_TEST_NOW=<ISO> untuk memaksa waktu di worker/scheduler.
 *
 * Waktu yang dikirim dipakai sebagai effectiveAt -> settleToNow mengevaluasi
 * semua anniversary/maturity/cure yang terlewat seolah waktu sudah melompat.
 */

const ENABLED =
  String(process.env.INSTALLMENT_TEST_CLOCK || "").toLowerCase() === "1" ||
  String(process.env.INSTALLMENT_TEST_CLOCK || "").toLowerCase() === "true";

function now(req) {
  if (!ENABLED) return new Date();

  // Worker/scheduler: override global via env
  const envNow = process.env.INSTALLMENT_TEST_NOW;
  if (envNow) {
    const d = new Date(envNow);
    if (!Number.isNaN(d.getTime())) return d;
  }

  // HTTP request: header atau body/query
  const raw =
    req?.headers?.["x-installment-now"] ??
    req?.body?.as_of ??
    req?.query?.as_of;
  if (raw) {
    const d = new Date(String(raw));
    if (!Number.isNaN(d.getTime())) return d;
  }

  return new Date();
}

/** true bila request diproses dengan waktu simulasi (test mode aktif + override ada). */
function isOverride(req) {
  if (!ENABLED) return false;
  if (process.env.INSTALLMENT_TEST_NOW) return true;
  return Boolean(
    req?.headers?.["x-installment-now"] ??
    req?.body?.as_of ??
    req?.query?.as_of ??
    req?.body?.is_test ??
    req?.query?.is_test,
  );
}

module.exports = { now, isOverride, ENABLED };
