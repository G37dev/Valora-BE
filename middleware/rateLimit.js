/*
 * Rate limiter in-memory sederhana (fixed window).
 *
 * Catatan: di Vercel serverless, state ini per-instance —
 * masih cukup efektif melawan brute-force karena satu
 * attacker cenderung di-route ke instance yang sama.
 * Untuk proteksi yang lebih kuat lintas instance, ganti
 * backing store ke Redis (REDIS_URL sudah tersedia di env).
 */

const buckets = new Map();

// Bersihkan entry kedaluwarsa tiap menit supaya Map tidak membengkak
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (now > entry.resetAt) buckets.delete(key);
  }
}, 60_000);
if (sweeper.unref) sweeper.unref();

/**
 * @param {object} options
 * @param {number} options.windowMs  durasi window dalam ms
 * @param {number} options.max       maks request per window
 * @param {function} [options.keyFn] custom key (default: IP)
 */
function rateLimit({ windowMs, max, keyFn }) {
  return (req, res, next) => {
    const key = `${req.path}:${keyFn ? keyFn(req) : req.ip}`;
    const now = Date.now();
    const entry = buckets.get(key);

    if (!entry || now > entry.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res
        .status(429)
        .json({ error: "Terlalu banyak percobaan. Coba lagi nanti." });
    }
    next();
  };
}

module.exports = rateLimit;
