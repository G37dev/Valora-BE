require("dotenv").config();
const { Sequelize } = require("sequelize");

const sequelize = new Sequelize(process.env.DATABASE_URL, {
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
  logging: false, // Set ke console.log jika ingin melihat query SQL yang berjalan
});

module.exports = sequelize;
