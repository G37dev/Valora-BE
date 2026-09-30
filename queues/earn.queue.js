const { Queue } = require("bullmq");

const connection = {
  host: process.env.REDIS_HOST || "127.0.0.1",

  port: Number(process.env.REDIS_PORT || 6379),
};

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
