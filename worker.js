require("dotenv").config();

const { sequelize } = require("./models");

const { startBlockchainListener } = require("./services/blockchainListener");
const { startEarnListener } = require("./services/earnListener");

// ===============================
// START BULLMQ WORKERS
// ===============================

require("./workers/earn.worker");
require("./workers/earn-claim.worker");

// ===============================
// START PRICE SCHEDULER
// ===============================

require("./services/priceScheduler");

// ===============================
// START WORKER PROCESS
// ===============================

async function startWorker() {
  try {
    await sequelize.authenticate();

    console.log("=================================");
    console.log("Valora Worker Database Connected");
    console.log("=================================");

    startBlockchainListener();
    startEarnListener();

    console.log("Blockchain listener started.");
    console.log("Earn listener started.");
    console.log("Earn workers started.");
    console.log("Price scheduler started.");
  } catch (error) {
    console.error("Worker startup failed:", error);

    process.exit(1);
  }
}

startWorker();
