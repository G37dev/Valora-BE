require("dotenv").config();

const { sequelize } = require("./models");

const { startBlockchainListener } = require("./services/blockchainListener");
const { startEarnListener } = require("./services/earnListener");
const {
  startInstallmentScheduler,
} = require("./services/installment/installment.scheduler");

require("./workers/earn.worker");
require("./workers/earn-claim.worker");
require("./workers/swap.worker");

require("./services/priceScheduler");

async function startWorker() {
  try {
    await sequelize.authenticate();

    console.log("=================================");
    console.log("Valora Worker Database Connected");
    console.log("=================================");

    startBlockchainListener();
    startEarnListener();
    startInstallmentScheduler();

    console.log("Blockchain listener started.");
    console.log("Earn listener started.");
    console.log("Earn workers started.");
    console.log("Swap worker started.");
    console.log("Price scheduler started.");
    console.log("Installment scheduler started.");
  } catch (error) {
    console.error("Worker startup failed:", error);
    process.exit(1);
  }
}

startWorker();
