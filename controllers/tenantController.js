const { Customer, PartnerIdentityLink, User, Tenant } = require("../models");
const crypto = require("crypto");

exports.createTenant = async (req, res) => {
  try {
    const { code, name, config } = req.body || {};

    if (!code || !name) {
      return res
        .status(400)
        .json({ error: "Code dan Name tenant wajib diisi." });
    }

    const apiKey = `val_live_${crypto.randomBytes(16).toString("hex")}`;

    const newTenant = await Tenant.create({
      code,
      name,
      config,
      apiKey,
    });

    return res.status(201).json({
      message: "Tenant berhasil dibuat",
      tenant: newTenant,
    });
  } catch (error) {
    if (error.name === "SequelizeUniqueConstraintError") {
      return res
        .status(400)
        .json({ error: `Tenant dengan kode tersebut sudah terdaftar.` });
    }

    console.error("Tenant Error:", error);
    return res.status(500).json({ error: "Gagal membuat tenant." });
  }
};

exports.getTenants = async (req, res) => {
  try {
    const tenants = await Tenant.findAll();
    return res.status(200).json(tenants);
  } catch (error) {
    return res.status(500).json({ error: "Gagal mengambil data tenant." });
  }
};

// ============================================================================
// API: Daftarkan/Hubungkan User Tenant ke Master Customer Valora Core
// ============================================================================
exports.registerOrLinkCustomer = async (req, res) => {
  try {
    // tenantId didapat dari middleware API Key yang tervalidasi
    const tenantId = req.tenant.id;

    // Data yang dikirim oleh backend tenant saat user mereka register/login
    const { externalUserId, email, firstName, lastName } = req.body;

    if (!externalUserId) {
      return res.status(400).json({ error: "externalUserId wajib diisi." });
    }

    // Gunakan transaksi agar proses pembuatan data konsisten
    const result = await Customer.sequelize.transaction(async (t) => {
      // 1. Cek apakah relasi partner ini sudah pernah dibuat sebelumnya
      let linkRecord = await PartnerIdentityLink.findOne({
        where: { tenantId, externalUserId },
        transaction: t,
      });

      let coreId;

      if (!linkRecord) {
        // A. Jika belum ada, buat Master Customer baru di Valora Core
        const newCustomer = await Customer.create({}, { transaction: t });
        coreId = newCustomer.coreId;

        // B. Buat profil dasarnya di tabel User (opsional, jika dikirim tenant)
        if (email || firstName) {
          await User.create(
            {
              coreId,
              email,
              firstName: firstName || "User Tenant",
              lastName: lastName || "",
            },
            { transaction: t },
          );
        }

        // C. Buat link jembatan di tabel PartnerIdentityLink
        linkRecord = await PartnerIdentityLink.create(
          {
            coreId,
            tenantId,
            externalUserId,
            partnerSub: `sub-${tenantId.substring(0, 5)}-${coreId}`,
          },
          { transaction: t },
        );
      } else {
        // Jika sudah pernah terhubung, ambil coreId yang sudah ada
        coreId = linkRecord.coreId;
      }

      return {
        coreId,
        partnerSub: linkRecord.partnerSub,
      };
    });

    return res.status(200).json({
      message: "Customer berhasil dihubungkan ke Valora Core",
      data: result,
    });
  } catch (error) {
    return res
      .status(500)
      .json({ error: "Gagal menghubungkan customer: " + error.message });
  }
};
