const express = require("express");
const router = express.Router();
const {
  getCachedPrices,
  syncTokenPrices,
  getChartData,
} = require("../controllers/priceController");

// Route untuk melihat harga yang tersimpan di DB
router.get("/", getCachedPrices);

// Route untuk memaksa update/sync harga dari API luar secara manual
router.post("/sync", syncTokenPrices);
router.get("/chart", getChartData);
module.exports = router;
