// middlewares/tenantAuth.js
const { Tenant } = require("../models");

exports.verifyTenantApiKey = async (req, res, next) => {
  try {
    const apiKey = req.headers["x-tenant-api-key"];
    if (!apiKey) {
      return res.status(401).json({ error: "Tenant API Key tidak ditemukan." });
    }

    // Cari tenant berdasarkan API Key di database
    const tenant = await Tenant.findOne({ where: { apiKey } });
    if (!tenant) {
      return res.status(403).json({ error: "API Key Tenant tidak valid." });
    }

    // Simpan data tenant ke request agar bisa dipakai di controller
    req.tenant = tenant;
    next();
  } catch (error) {
    res
      .status(500)
      .json({ error: "Autentikasi Tenant gagal: " + error.message });
  }
};
