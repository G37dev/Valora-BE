const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { authenticator } = require("otplib");
const { createClient } = require("@supabase/supabase-js");

const {
  Customer,
  User,
  AuthIdentity,
  Tenant,
  PartnerIdentityLink,
} = require("../models");

// Inisialisasi Supabase client untuk backend (Google Login)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

const JWT_SECRET = process.env.JWT_SECRET || "rahasia_super_valora_123";

// ============================================================================
// HELPER 1: Generate Final JWT
// ============================================================================
async function generateAuthResponse(coreId, tenantId) {
  const userProfile = await User.findOne({ where: { coreId } });
  if (!userProfile) throw new Error("Profil user tidak ditemukan");

  let tokenPayload = {
    coreId: coreId,
    email: userProfile.email,
    name: `${userProfile.firstName || ""} ${userProfile.lastName || ""}`.trim(),
  };

  if (tenantId) {
    const tenant = await Tenant.findByPk(tenantId);
    if (!tenant) throw new Error("Tenant ID tidak valid");

    const [linkRecord] = await PartnerIdentityLink.findOrCreate({
      where: { coreId, tenantId },
      defaults: {
        externalUserId: coreId,
        partnerSub: `sub-${tenantId.substring(0, 5)}-${coreId}`,
      },
    });

    tokenPayload.sub = linkRecord.partnerSub;
    tokenPayload.aud = tenantId;
  } else {
    tokenPayload.sub = coreId;
    tokenPayload.aud = "valora-core";
  }

  const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: "7d" });

  const fullUserData = {
    coreId: userProfile.coreId,
    email: userProfile.email,
    firstName: userProfile.firstName,
    lastName: userProfile.lastName,
    name: `${userProfile.firstName || ""} ${userProfile.lastName || ""}`.trim(),
    phoneNumber: userProfile.phoneNumber,
    avatarUrl: userProfile.avatarUrl,
    created_at: userProfile.createdAt,
    updated_at: userProfile.updatedAt,
  };

  return { token, user: fullUserData };
}

// ============================================================================
// HELPER 2: Generate Pre-Auth Token (15 Menit)
// ============================================================================
function generatePreAuthToken(coreId, tenantId) {
  return jwt.sign({ coreId, tenantId, scope: "pre_auth" }, JWT_SECRET, {
    expiresIn: "15m",
  });
}

// ============================================================================
// HELPER 3: Pengecekan 2FA
// ============================================================================
async function handle2FACheck(coreId, tenantId, res) {
  const totpRecord = await AuthIdentity.findOne({
    where: {
      coreId,
      provider: "AUTHENTICATOR",
      type: "TOTP",
      status: "ACTIVE",
    },
  });

  const preAuthToken = generatePreAuthToken(coreId, tenantId);

  if (totpRecord) {
    return res.json({
      message: "Verifikasi tambahan diperlukan.",
      require2FA: true,
      requireSetup: false,
      preAuthToken,
      availableMethods: {
        authenticator: true,
      },
    });
  }

  return res.json({
    message: "Anda wajib mengatur Google Authenticator sebelum dapat login.",
    require2FA: false,
    requireSetup: true,
    preAuthToken,
  });
}

// ============================================================================
// METODE 0: REGISTER
// ============================================================================
exports.register = async (req, res) => {
  try {
    const { firstName, lastName, email, password, phoneNumber } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email dan password wajib diisi." });
    }

    const existingAuth = await AuthIdentity.findOne({
      where: { providerUserId: email, provider: "LOCAL" },
    });

    if (existingAuth) {
      return res
        .status(400)
        .json({ error: "Email sudah terdaftar. Silakan login." });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await Customer.sequelize.transaction(async (t) => {
      const newCustomer = await Customer.create({}, { transaction: t });
      const coreId = newCustomer.coreId;

      await AuthIdentity.create(
        {
          coreId: coreId,
          type: "CREDENTIAL",
          provider: "LOCAL",
          providerUserId: email,
          passwordHash: hashedPassword,
        },
        { transaction: t },
      );

      await User.create(
        {
          coreId: coreId,
          firstName: firstName,
          lastName: lastName,
          email: email,
          phoneNumber: phoneNumber,
        },
        { transaction: t },
      );

      return coreId;
    });

    res.status(201).json({
      message: "Registrasi berhasil! Silakan login untuk melanjutkan.",
      coreId: result,
    });
  } catch (error) {
    res.status(500).json({ error: "Gagal registrasi: " + error.message });
  }
};

// ============================================================================
// METODE 1: EMAIL & PASSWORD LOGIN
// ============================================================================
exports.loginWithPassword = async (req, res) => {
  try {
    const { email, password, tenantId } = req.body;

    const authRecord = await AuthIdentity.findOne({
      where: { providerUserId: email, provider: "LOCAL", type: "CREDENTIAL" },
    });
    if (!authRecord)
      return res.status(401).json({ error: "Email tidak terdaftar." });

    const isValid = await bcrypt.compare(password, authRecord.passwordHash);
    if (!isValid) return res.status(401).json({ error: "Password salah." });

    return handle2FACheck(authRecord.coreId, tenantId, res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ============================================================================
// METODE 2: GOOGLE OAUTH LOGIN
// ============================================================================
exports.loginWithGoogle = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ error: "Token tidak ditemukan" });

    const token = authHeader.split(" ")[1];

    const {
      data: { user: supabaseUser },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !supabaseUser) {
      return res.status(401).json({ error: "Token Supabase tidak valid" });
    }

    const email = supabaseUser.email;
    const googleId = supabaseUser.user_metadata?.provider_id || supabaseUser.id;
    const fullName = supabaseUser.user_metadata?.full_name || "";
    const [firstName, ...lastNameArr] = fullName.split(" ");
    const lastName = lastNameArr.join(" ");
    const picture = supabaseUser.user_metadata?.avatar_url;

    let authRecord = await AuthIdentity.findOne({
      where: { providerUserId: googleId, provider: "GOOGLE" },
    });

    let coreId;

    if (!authRecord) {
      const newCustomer = await Customer.create({});
      coreId = newCustomer.coreId;

      await AuthIdentity.create({
        coreId: coreId,
        type: "OAUTH",
        provider: "GOOGLE",
        providerUserId: googleId,
      });

      await User.create({
        coreId: coreId,
        firstName: firstName || "User",
        lastName: lastName || "",
        email: email,
        avatarUrl: picture,
      });
    } else {
      coreId = authRecord.coreId;
    }

    const tenantId = req.body.tenantId;

    return handle2FACheck(coreId, tenantId, res);
  } catch (error) {
    res
      .status(500)
      .json({ error: "Gagal memproses Google Login: " + error.message });
  }
};

// ============================================================================
// METODE 3A: SETUP AUTHENTICATOR (TOTP)
// ============================================================================
exports.setupAuthenticator = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ error: "Pre-Auth Token tidak ditemukan" });

    const preAuthToken = authHeader.split(" ")[1];
    const decoded = jwt.verify(preAuthToken, JWT_SECRET);

    if (decoded.scope !== "pre_auth")
      return res.status(403).json({ error: "Token tidak valid" });

    const coreId = decoded.coreId;
    const secret = authenticator.generateSecret();

    await AuthIdentity.destroy({
      where: {
        coreId,
        provider: "AUTHENTICATOR",
        type: "TOTP",
        status: "PENDING",
      },
    });

    await AuthIdentity.create({
      coreId,
      type: "TOTP",
      provider: "AUTHENTICATOR",
      providerUserId: coreId,
      secretKey: secret,
      status: "PENDING",
    });

    const userProfile = await User.findOne({ where: { coreId } });
    const otpauth = authenticator.keyuri(
      userProfile.email,
      "Valora App",
      secret,
    );

    res.json({ secret, otpauth });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Gagal setup authenticator: " + error.message });
  }
};

// ============================================================================
// METODE 3B: VERIFY AUTHENTICATOR (TOTP dengan Debugging Waktu)
// ============================================================================
exports.verifyAuthenticator = async (req, res) => {
  try {
    const { token: totpCode } = req.body;

    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ error: "Pre-Auth Token tidak ditemukan" });

    const preAuthToken = authHeader.split(" ")[1];
    const decoded = jwt.verify(preAuthToken, JWT_SECRET);
    if (decoded.scope !== "pre_auth")
      return res.status(403).json({ error: "Token tidak valid" });

    const coreId = decoded.coreId;
    const tenantId = decoded.tenantId;

    const authRecord = await AuthIdentity.findOne({
      where: { coreId, provider: "AUTHENTICATOR", type: "TOTP" },
      order: [["created_at", "DESC"]],
    });

    if (!authRecord || !authRecord.secretKey)
      return res
        .status(404)
        .json({ error: "Metode Authenticator belum diatur." });

    // --- DEBUGGING WAKTU & KODE ---
    const serverTime = new Date().toISOString();
    const generatedCodeByServer = authenticator.generate(authRecord.secretKey);

    console.log("========================================");
    console.log("🕒 Waktu Server Saat Ini :", serverTime);
    console.log("🔑 Secret Key di DB     :", authRecord.secretKey);
    console.log("📱 Kode dari HP (User)  :", totpCode);
    console.log("💻 Kode Buatan Server   :", generatedCodeByServer);
    console.log("========================================");

    // Set toleransi jendela waktu lebih longgar (window: 2 berarti ±60 detik)
    authenticator.options = { window: 2 };

    const isValid = authenticator.check(totpCode, authRecord.secretKey);

    if (!isValid) {
      return res.status(401).json({
        error: `Kode salah. (HP: ${totpCode} vs Server: ${generatedCodeByServer}). Cek sinkronisasi jam PC Anda!`,
      });
    }

    if (authRecord.status === "PENDING") {
      authRecord.status = "ACTIVE";
      await authRecord.save();
    }

    const authData = await generateAuthResponse(coreId, tenantId);
    res.json({ message: "2FA Berhasil, Login Sukses!", ...authData });
  } catch (error) {
    res.status(500).json({ error: "Gagal verifikasi: " + error.message });
  }
};

// ============================================================================
// METODE 3C: VERIFY AUTHENTICATOR FINAL
// ============================================================================

exports.verifyTransaction2FA = async (req, res) => {
  try {
    const { token: totpCode } = req.body;
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ error: "Token tidak ditemukan" });

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET); // Menggunakan JWT_SECRET biasa
    const coreId = decoded.coreId;

    const authRecord = await AuthIdentity.findOne({
      where: { coreId, provider: "AUTHENTICATOR", type: "TOTP" },
    });

    if (!authRecord || !authRecord.secretKey)
      return res.status(404).json({ error: "Authenticator belum diatur." });

    authenticator.options = { window: 1 };
    const isValid = authenticator.check(totpCode, authRecord.secretKey);

    if (!isValid) {
      return res
        .status(401)
        .json({ error: "Kode Authenticator salah atau kadaluarsa." });
    }

    res.json({ message: "2FA Transaksi Berhasil!" });
  } catch (error) {
    res.status(500).json({ error: "Gagal verifikasi: " + error.message });
  }
};
