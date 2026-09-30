const axios = require("axios");

const INDODAX_BASE_URL = "https://indodax.com";

const ALLOWED_SYMBOLS = new Set(["USDTIDR", "USDCIDR", "XAUTIDR"]);

const ALLOWED_TIMEFRAMES = new Set([
  "1",
  "15",
  "30",
  "60",
  "240",
  "1D",
  "3D",
  "1W",
]);

const getIndodaxChart = async ({ symbol = "USDTIDR", tf = "60", days = 1 }) => {
  const normalizedSymbol = String(symbol).trim().toUpperCase();

  const normalizedTf = String(tf).trim();

  if (!ALLOWED_SYMBOLS.has(normalizedSymbol)) {
    throw new Error(`Unsupported Indodax symbol: ${normalizedSymbol}`);
  }

  if (!ALLOWED_TIMEFRAMES.has(normalizedTf)) {
    throw new Error(`Unsupported timeframe: ${normalizedTf}`);
  }

  const numericDays = Number(days);

  if (!Number.isFinite(numericDays) || numericDays <= 0 || numericDays > 30) {
    throw new Error("days must be between 1 and 30");
  }

  const now = Math.floor(Date.now() / 1000);

  const from = now - numericDays * 24 * 60 * 60;

  const response = await axios.get(
    `${INDODAX_BASE_URL}/tradingview/history_v2`,
    {
      params: {
        from,
        to: now,
        tf: normalizedTf,
        symbol: normalizedSymbol,
      },

      timeout: 15000,
    },
  );

  if (!Array.isArray(response.data)) {
    throw new Error("Invalid response from Indodax");
  }

  return response.data;
};

module.exports = {
  getIndodaxChart,
};
