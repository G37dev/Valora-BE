const axios = require("axios");
const { Price } = require("../models");

const TROY_OUNCE_TO_GRAM = 31.1034768;

/**
 * @desc    Sinkronisasi harga terbaru dari Indodax & ShariaCoin ke Database
 * @route   POST /api/prices/sync
 */
const syncTokenPrices = async (req, res) => {
  try {
    console.log(
      "[PRICE SYNC] Mengambil data harga dari Indodax & ShariaCoin...",
    );

    // 1. USDT ke IDR dari Indodax
    const usdtRes = await axios.get("https://indodax.com/api/usdt_idr/ticker");
    const usdtPrice = usdtRes.data.ticker.last;
    await Price.upsert({
      asset: "USDT",
      priceIdr: usdtPrice,
      source: "INDODAX",
    });

    // 2. USDC ke IDR dari Indodax
    const usdcRes = await axios.get("https://indodax.com/api/usdc_idr/ticker");
    const usdcPrice = usdcRes.data.ticker.last;
    await Price.upsert({
      asset: "USDC",
      priceIdr: usdcPrice,
      source: "INDODAX",
    });

    // 3. XAUT (Tether Gold) ke IDR dari Indodax
    const xautRes = await axios.get("https://indodax.com/api/xaut_idr/ticker");
    const xautPricePerOz = parseFloat(xautRes.data.ticker.last);
    const xautPricePerGram = xautPricePerOz / TROY_OUNCE_TO_GRAM; // Konversi ke gram

    await Price.upsert({
      asset: "XAUT",
      priceIdr: xautPricePerGram.toFixed(2), // Dibulatkan 2 desimal
      source: "INDODAX",
    });

    // 4. GOLD dari ShariaCoin
    const goldRes = await axios.get("https://shariacoin.co.id/api/price");
    const goldBuyPrice = goldRes.data.data.gold.price_buy;
    await Price.upsert({
      asset: "GOLD",
      priceIdr: goldBuyPrice,
      source: "SHARIACOIN",
    });

    console.log("[PRICE SYNC SUCCESS] Semua harga berhasil diperbarui.");

    if (res) {
      return res.status(200).json({
        success: true,
        message: "Harga berhasil disinkronkan ke database.",
      });
    }
  } catch (error) {
    console.error(
      "[PRICE SYNC ERROR] Gagal menyinkronkan harga:",
      error.message,
    );
    if (res && !res.headersSent) {
      return res.status(500).json({
        success: false,
        message: "Gagal menyinkronkan harga",
        error: error.message,
      });
    }
  }
};

/**
 * @desc    Mengambil daftar harga yang tersimpan di database lokal
 * @route   GET /api/prices
 */
const getCachedPrices = async (req, res) => {
  try {
    const prices = await Price.findAll();
    return res.status(200).json({
      success: true,
      data: prices,
    });
  } catch (error) {
    console.error("Gagal mengambil data harga:", error);
    return res.status(500).json({
      success: false,
      message: "Gagal memuat data harga dari database",
      error: error.message,
    });
  }
};

const { getIndodaxChart } = require("../services/indodaxChartService");

const getChartData = async (req, res) => {
  try {
    const { symbol = "USDTIDR", tf = "1D", days = "7" } = req.query;

    const rawData = await getIndodaxChart({
      symbol,
      tf,
      days,
    });

    const chartData = rawData
      .map((item) => ({
        timestamp: Number(item.Time) * 1000,
        value: Number(item.Close),
        open: Number(item.Open),
        high: Number(item.High),
        low: Number(item.Low),
        close: Number(item.Close),
        volume: Number(item.Volume || 0),
      }))
      .filter(
        (item) =>
          Number.isFinite(item.timestamp) && Number.isFinite(item.value),
      );

    return res.status(200).json({
      success: true,
      data: {
        symbol: String(symbol).toUpperCase(),
        timeframe: String(tf),
        points: chartData,
      },
    });
  } catch (error) {
    console.error("[INDODAX CHART] Error:", error);

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil data chart Indodax.",
    });
  }
};

module.exports = {
  syncTokenPrices,
  getCachedPrices,
  getChartData,
};
