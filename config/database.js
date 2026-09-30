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
  logging: false, // Set ke console.log jika ingin melihat query SQL yang berjalan
});

module.exports = sequelize;
