const { Queue } = require("bullmq");
const Redis = require("ioredis");

const connection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
const earnClaimQueue = new Queue("earn-claim", {
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
  earnClaimQueue,
};
