const Redis = require("ioredis");

/**
 * Shared enqueue-side Redis connection.
 *
 * BullMQ Queue boleh share satu koneksi per proses (enqueue non-blocking).
 * Worker tetap wajib punya koneksi dedicated sendiri (blocking commands).
 *
 * Di Vercel serverless ini memangkas koneksi Redis per instance dari 3
 * (earn + earn-claim + swap queue masing-masing `new Redis`) jadi 1 —
 * penting karena Upstash free tier max 30 clients.
 */
const connection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

module.exports = connection;
