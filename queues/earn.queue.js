const { Queue } = require("bullmq");
const connection = require("./connection");

const earnQueue = new Queue("earn", {
  connection,
  defaultJobOptions: {
    attempts: 5,

    backoff: {
      type: "exponential",
      delay: 5000,
    },

    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

module.exports = {
  earnQueue,
};
