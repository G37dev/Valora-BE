const { Queue } = require("bullmq");
const Redis = require("ioredis");

const connection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
});
const earnClaimQueue = new Queue("earn-claim", {
  connection,
});

module.exports = {
  earnClaimQueue,
};
