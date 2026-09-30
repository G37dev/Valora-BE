const { syncTokenPrices } = require("../controllers/priceController");

// Jalankan otomatis setiap 30 detik (30000 ms)
setInterval(async () => {
  try {
    await syncTokenPrices();
  } catch (error) {
    console.error("[CRON BACKGROUND ERROR]:", error.message);
  }
}, 30000);

console.log(
  "[PRICE SCHEDULER] Background sync aktif (berjalan setiap 30 detik).",
);
