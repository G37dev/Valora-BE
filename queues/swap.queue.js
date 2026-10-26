const { Queue } = require("bullmq");
const connection = require("./connection");

const swapQueue = new Queue("swap", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 3000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

module.exports = {
  swapQueue,
};
