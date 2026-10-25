const axios = require("axios");
const { Op } = require("sequelize");
const { Price, LoanPriceTick } = require("../models");

const TROY_OUNCE_TO_GRAM = 31.1034768;

// Cache ringan agar hitung change24h tidak query DB per request.
const CHANGE_24H_CACHE_TTL_MS = 60 * 1000;
const change24hCache = new Map();

async function getChange24hPct(asset) {
  const cached = change24hCache.get(asset);
  if (cached && Date.now() - cached.at < CHANGE_24H_CACHE_TTL_MS) {
    return cached.pct;
  }
  const now = new Date();
  const baselineCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [latest, baseline] = await Promise.all([
    LoanPriceTick.findOne({
      where: { asset, isOverride: false, observedAt: { [Op.lte]: now } },
      order: [["observed_at", "DESC"]],
    }),
    LoanPriceTick.findOne({
      where: {
        asset,
        isOverride: false,
        observedAt: { [Op.lte]: baselineCutoff },
      },
      order: [["observed_at", "DESC"]],
    }),
  ]);
  let pct = 0;
  if (latest && baseline && Number(baseline.priceIdr) > 0) {
    pct = (Number(latest.priceIdr) / Number(baseline.priceIdr) - 1) * 100;
  }
  change24hCache.set(asset, { pct, at: Date.now() });
  return pct;
}

/**
 * @desc    Sinkronisasi harga terbaru dari Indodax & ShariaCoin ke Database
 * @route   POST /api/prices/sync
 */
const syncTokenPrices = async (req, res) => {
  try {
    console.log(
      "[PRICE SYNC] Mengambil data harga dari Indodax & ShariaCoin...",
    );

    const syncOne = async (asset, fetchPrice) => {
      try {
        const { priceIdr, source } = await fetchPrice();
        await Price.upsert({ asset, priceIdr, source });
        // Tick hanya untuk stablecoin — GOLD/XAUT sudah di-tick
        // loan.scheduler dalam satuan per-token (XAUT per toz),
        // menulis per-gram di sini akan merusak series.
        if (asset === "USDT" || asset === "USDC") {
          await LoanPriceTick.create({
            asset,
            priceIdr,
            source,
            observedAt: new Date(),
            fetchedAt: new Date(),
          });
          change24hCache.delete(asset);
        }
        console.log(`[PRICE SYNC] ${asset} OK`);
      } catch (err) {
        console.error(`[PRICE SYNC] ${asset} gagal:`, err.message);
      }
    };

    // 1. USDT ke IDR dari Indodax
    await syncOne("USDT", async () => {
      const r = await axios.get("https://indodax.com/api/usdt_idr/ticker");
      return { priceIdr: r.data.ticker.last, source: "INDODAX" };
    });

    // 2. USDC ke IDR dari Indodax
    await syncOne("USDC", async () => {
      const r = await axios.get("https://indodax.com/api/usdc_idr/ticker");
      return { priceIdr: r.data.ticker.last, source: "INDODAX" };
    });

    // 3. XAUT (Tether Gold) ke IDR dari Indodax
    await syncOne("XAUT", async () => {
      const r = await axios.get("https://indodax.com/api/xaut_idr/ticker");
      const perGram = parseFloat(r.data.ticker.last) / TROY_OUNCE_TO_GRAM;
      return { priceIdr: perGram.toFixed(2), source: "INDODAX" };
    });

    // 4. GOLD dari ShariaCoin
    await syncOne("GOLD", async () => {
      const r = await axios.get("https://shariacoin.co.id/api/price");
      return { priceIdr: r.data.data.gold.price_buy, source: "SHARIACOIN" };
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
    const data = await Promise.all(
      prices.map(async (p) => {
        const row = p.toJSON ? p.toJSON() : p;
        try {
          row.change24h_pct = await getChange24hPct(p.asset);
        } catch {
          row.change24h_pct = 0;
        }
        return row;
      }),
    );
    return res.status(200).json({
      success: true,
      data,
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
