require("dotenv").config();
const { Sequelize } = require("sequelize");

/**
 * Supabase session-mode pooler (port 5432) membatasi total client
 * (~15) dan sering memicu EMAXCONNSESSION di serverless + worker.
 * Transaction-mode pooler (port 6543) melepas koneksi tiap transaksi
 * selesai sehingga kapasitas client jauh lebih besar. Force switch
 * supaya tidak bergantung pada isi env di tiap environment.
 */
const databaseUrl = process.env.DB_FORCE_SESSION_MODE
  ? process.env.DATABASE_URL
  : (process.env.DATABASE_URL || "").replace(
      /(pooler\.supabase\.com):5432/,
      "$1:6543",
    );

const sequelize = new Sequelize(databaseUrl, {
  dialect: "postgres",
  dialectOptions: {
    // Supabase biasanya memerlukan SSL
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  },
  /**
   * Supabase session-mode pooler (port 5432) membatasi total client
   * (pool_size ~15). Di serverless setiap instance punya pool sendiri,
   * jadi keep pool kecil dan lepas koneksi idle cepat supaya tidak
   * memicu EMAXCONNSESSION. Bisa dioverride via env kalau perlu.
   */
  pool: {
    max: Number(process.env.DB_POOL_MAX || 2),
    min: 0,
    idle: Number(process.env.DB_POOL_IDLE || 5000),
    acquire: Number(process.env.DB_POOL_ACQUIRE || 30000),
    evict: Number(process.env.DB_POOL_EVICT || 1000),
  },
  /**
   * Retry query yang kena error koneksi/pooler sementara (misal
   * transisi slot pooler) supaya tidak langsung crash job/proses.
   */
  retry: {
    max: Number(process.env.DB_RETRY_MAX || 10),
    match: [
      /max clients reached/i,
      /EMAXCONNSESSION/i,
      /Connection terminated/i,
      /ECONNRESET/i,
      /ETIMEDOUT/i,
      /ECONNREFUSED/i,
      /EHOSTUNREACH/i,
      /ConnectionAcquireTimeoutError/i,
    ],
    backoffBase: Number(process.env.DB_RETRY_BACKOFF || 500),
    backoffExponent: 1.1,
  },
  logging: false, // Set ke console.log jika ingin melihat query SQL yang berjalan
});

module.exports = sequelize;
