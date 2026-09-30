const { prepareEvent, parseEventLogs } = require("thirdweb");

const earnPositionCreatedEvent = prepareEvent({
  signature:
    "event EarnPositionCreated(address indexed user,uint256 indexed positionId,uint256 principal,uint64 maturityAt,uint16 aprBps)",
});

const earnPositionClaimedEvent = prepareEvent({
  signature:
    "event EarnPositionClaimed(address indexed user,uint256 indexed positionId,uint256 principal,uint256 reward)",
});

const parsePoolEvent = (logs, poolAddress, event) => {
  if (!Array.isArray(logs) || !logs.length) {
    return null;
  }

  const poolLogs = logs.filter(
    (log) => log?.address?.toLowerCase() === poolAddress.toLowerCase(),
  );

  if (!poolLogs.length) {
    return null;
  }

  const events = parseEventLogs({
    logs: poolLogs,
    events: [event],
    strict: false,
  });

  return events?.[0] || null;
};

const parseEarnPositionCreated = (logs, poolAddress) => {
  return parsePoolEvent(logs, poolAddress, earnPositionCreatedEvent);
};

const parseEarnPositionClaimed = (logs, poolAddress) => {
  return parsePoolEvent(logs, poolAddress, earnPositionClaimedEvent);
};

module.exports = {
  parseEarnPositionCreated,
  parseEarnPositionClaimed,
};
