const bcrypt = require("bcrypt");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { Op } = require("sequelize");
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

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable wajib di-set.");
}

// ============================================================================
// SECURITY HELPERS
// ============================================================================

const normalizeEmail = (email) =>
  String(email || "")
    .trim()
    .toLowerCase();

const PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/;

const BCRYPT_ROUNDS = 12;

// Avatar preset "a1"-"a6" — key file di assets/images/profile pada app.
const randomAvatar = () => `a${1 + Math.floor(Math.random() * 6)}`;

/*
 * Enkripsi TOTP secret at-rest (AES-256-GCM).
 * Butuh env TOTP_ENCRYPTION_KEY — kalau tidak di-set,
 * secret disimpan plaintext (fallback untuk env lama).
 */
const TOTP_ENC_KEY = process.env.TOTP_ENCRYPTION_KEY;

const getEncKey = () =>
  crypto.createHash("sha256").update(String(TOTP_ENC_KEY)).digest();

function encryptSecret(plain) {
  if (!TOTP_ENC_KEY) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decryptSecret(stored) {
  if (!stored || !stored.startsWith("enc:")) return stored;
  const [, ivHex, tagHex, dataHex] = stored.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncKey(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

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

  const passkeyCount = await AuthIdentity.count({
    where: {
      coreId,
      provider: "PASSKEY",
      type: "WEBAUTHN",
      status: "ACTIVE",
    },
  });

  const preAuthToken = generatePreAuthToken(coreId, tenantId);

  if (totpRecord || passkeyCount > 0) {
    return res.json({
      message: "Verifikasi tambahan diperlukan.",
      require2FA: true,
      requireSetup: false,
      preAuthToken,
      availableMethods: {
        authenticator: Boolean(totpRecord),
        passkey: passkeyCount > 0,
      },
    });
  }

  /*
   * 2FA sekarang opsional — user yang belum setup
   * authenticator langsung dapat token login penuh.
   * Setup bisa dilakukan kapan saja dari halaman profile.
   */
  const authData = await generateAuthResponse(coreId, tenantId);

  return res.json({
    message: "Login berhasil!",
    require2FA: false,
    requireSetup: false,
    ...authData,
  });
}

// ============================================================================
// METODE 0: REGISTER
// ============================================================================
exports.register = async (req, res) => {
  try {
    const { firstName, lastName, password, phoneNumber } = req.body;
    const email = normalizeEmail(req.body.email);

    if (!email || !password) {
      return res.status(400).json({ error: "Email dan password wajib diisi." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Format email tidak valid." });
    }

    if (!PASSWORD_REGEX.test(password)) {
      return res.status(400).json({
        error:
          "Password minimal 12 karakter dengan huruf besar, huruf kecil, angka, dan simbol.",
      });
    }

    const existingAuth = await AuthIdentity.findOne({
      where: { providerUserId: email, provider: "LOCAL" },
    });

    if (existingAuth) {
      return res
        .status(400)
        .json({ error: "Email sudah terdaftar. Silakan login." });
    }

    if (phoneNumber) {
      const existingPhone = await User.findOne({ where: { phoneNumber } });
      if (existingPhone) {
        return res.status(400).json({ error: "Nomor HP sudah terdaftar." });
      }
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

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
          avatarUrl: randomAvatar(),
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
    console.error("Register error:", error);
    res.status(500).json({ error: "Gagal registrasi. Silakan coba lagi." });
  }
};

// ============================================================================
// METODE 1: EMAIL & PASSWORD LOGIN
// ============================================================================
exports.loginWithPassword = async (req, res) => {
  try {
    const { password, tenantId } = req.body;
    const email = normalizeEmail(req.body.email);

    const authRecord = await AuthIdentity.findOne({
      where: { providerUserId: email, provider: "LOCAL", type: "CREDENTIAL" },
    });

    /*
     * Error message sengaja generic untuk email-tidak-ada
     * dan password-salah — jangan bocorkan apakah email
     * terdaftar (user enumeration attack).
     */
    const INVALID_MSG = "Email atau password salah.";

    if (!authRecord) return res.status(401).json({ error: INVALID_MSG });

    const isValid = await bcrypt.compare(password, authRecord.passwordHash);
    if (!isValid) return res.status(401).json({ error: INVALID_MSG });

    return handle2FACheck(authRecord.coreId, tenantId, res);
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Terjadi kesalahan saat login." });
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

    /*
     * Pastikan user ini beneran authenticated via Google dan
     * email-nya terverifikasi sebelum dipakai untuk account
     * linking — jangan sampai Supabase account dengan email
     * unconfirmed bisa di-link ke akun lokal orang lain.
     */
    const isGoogleIdentity =
      supabaseUser.app_metadata?.provider === "google" ||
      (supabaseUser.identities || []).some((i) => i.provider === "google");

    if (!isGoogleIdentity || !supabaseUser.email_confirmed_at) {
      return res.status(401).json({
        error: "Akun Google tidak valid atau email belum terverifikasi.",
      });
    }

    const email = normalizeEmail(supabaseUser.email);
    const googleId = supabaseUser.user_metadata?.provider_id || supabaseUser.id;
    const fullName = supabaseUser.user_metadata?.full_name || "";
    const [firstName, ...lastNameArr] = fullName.split(" ");
    const lastName = lastNameArr.join(" ");

    let authRecord = await AuthIdentity.findOne({
      where: { providerUserId: googleId, provider: "GOOGLE" },
    });

    let coreId;

    if (!authRecord) {
      /*
       * Account linking: kalau email ini sudah terdaftar via
       * password lokal, link identitas Google ke akun yang sama
       * (bukan bikin akun kedua). Google memverifikasi email,
       * jadi email terverifikasi dari Supabase aman untuk linking.
       */
      const localAuth = await AuthIdentity.findOne({
        where: {
          providerUserId: email,
          provider: "LOCAL",
          type: "CREDENTIAL",
        },
      });

      await Customer.sequelize.transaction(async (t) => {
        if (localAuth) {
          coreId = localAuth.coreId;
        } else {
          const newCustomer = await Customer.create({}, { transaction: t });
          coreId = newCustomer.coreId;
        }

        await AuthIdentity.create(
          {
            coreId: coreId,
            type: "OAUTH",
            provider: "GOOGLE",
            providerUserId: googleId,
          },
          { transaction: t },
        );

        if (!localAuth) {
          await User.create(
            {
              coreId: coreId,
              firstName: firstName || "User",
              lastName: lastName || "",
              email: email,
              avatarUrl: randomAvatar(),
            },
            { transaction: t },
          );
        }
      });
    } else {
      coreId = authRecord.coreId;
    }

    const tenantId = req.body.tenantId;

    return handle2FACheck(coreId, tenantId, res);
  } catch (error) {
    console.error("Google login error:", error);
    res
      .status(500)
      .json({ error: "Gagal memproses Google Login. Silakan coba lagi." });
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

    /*
     * Terima pre_auth (alur login lama) maupun token
     * login penuh (setup dari halaman profile).
     */
    if (decoded.scope !== "pre_auth" && !decoded.coreId)
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
      secretKey: encryptSecret(secret),
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
    console.error("Setup authenticator error:", error);
    res.status(500).json({ error: "Gagal setup authenticator." });
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
    if (decoded.scope !== "pre_auth" && !decoded.coreId)
      return res.status(403).json({ error: "Token tidak valid" });

    const coreId = decoded.coreId;
    const tenantId = decoded.tenantId;

    /*
     * Pilih secret yang benar per konteks:
     * - pre_auth (login) → record ACTIVE milik user.
     *   Kalau ada PENDING stale dari setup yang dibatalkan,
     *   jangan sampai kode ACTIVE user ke-reject.
     * - full token (setup dari profile) → record PENDING
     *   yang baru saja dibuat di /2fa/setup.
     */
    const expectedStatus = decoded.scope === "pre_auth" ? "ACTIVE" : "PENDING";

    const authRecord = await AuthIdentity.findOne({
      where: {
        coreId,
        provider: "AUTHENTICATOR",
        type: "TOTP",
        status: expectedStatus,
      },
      order: [["created_at", "DESC"]],
    });

    if (!authRecord || !authRecord.secretKey)
      return res
        .status(404)
        .json({ error: "Metode Authenticator belum diatur." });

    const secretKey = decryptSecret(authRecord.secretKey);

    /*
     * Clone instance supaya opsi window tidak mengubah
     * state global authenticator (aman untuk request konkuren).
     */
    const totp = authenticator.clone();
    totp.options = { window: 2 };

    const isValid = totp.check(String(totpCode).trim(), secretKey);

    if (!isValid) {
      return res.status(401).json({
        error: "Kode authenticator salah atau kadaluarsa.",
      });
    }

    if (authRecord.status === "PENDING") {
      authRecord.status = "ACTIVE";
      await authRecord.save();

      /*
       * Setup ulang: nonaktifkan record TOTP lama
       * supaya cuma satu secret yang aktif.
       */
      await AuthIdentity.update(
        { status: "INACTIVE" },
        {
          where: {
            coreId,
            provider: "AUTHENTICATOR",
            type: "TOTP",
            id: { [Op.ne]: authRecord.id },
          },
        },
      );
    }

    const authData = await generateAuthResponse(coreId, tenantId);
    res.json({ message: "2FA Berhasil, Login Sukses!", ...authData });
  } catch (error) {
    console.error("Verify authenticator error:", error);
    res.status(500).json({ error: "Gagal verifikasi." });
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
      where: {
        coreId,
        provider: "AUTHENTICATOR",
        type: "TOTP",
        status: "ACTIVE",
      },
    });

    if (!authRecord || !authRecord.secretKey)
      return res.status(404).json({ error: "Authenticator belum diatur." });

    const secretKey = decryptSecret(authRecord.secretKey);
    const totp = authenticator.clone();
    totp.options = { window: 1 };

    const isValid = totp.check(String(totpCode).trim(), secretKey);

    if (!isValid) {
      return res
        .status(401)
        .json({ error: "Kode Authenticator salah atau kadaluarsa." });
    }

    res.json({ message: "2FA Transaksi Berhasil!" });
  } catch (error) {
    console.error("Verify tx 2FA error:", error);
    res.status(500).json({ error: "Gagal verifikasi." });
  }
};

// ============================================================================
// METODE 3D: 2FA STATUS — apakah user punya authenticator aktif
// ============================================================================
exports.get2FAStatus = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ error: "Token tidak ditemukan" });

    const decoded = jwt.verify(authHeader.split(" ")[1], JWT_SECRET);

    if (!decoded.coreId)
      return res.status(403).json({ error: "Token tidak valid" });

    const totpRecord = await AuthIdentity.findOne({
      where: {
        coreId: decoded.coreId,
        provider: "AUTHENTICATOR",
        type: "TOTP",
        status: "ACTIVE",
      },
    });

    const passkeyCount = await AuthIdentity.count({
      where: {
        coreId: decoded.coreId,
        provider: "PASSKEY",
        type: "WEBAUTHN",
        status: "ACTIVE",
      },
    });

    res.json({
      success: true,
      enabled: Boolean(totpRecord),
      passkeyEnabled: passkeyCount > 0,
    });
  } catch (error) {
    console.error("2FA status error:", error);
    res.status(500).json({ error: "Gagal cek status 2FA." });
  }
};

// ============================================================================
// METODE 3E: DISABLE AUTHENTICATOR
// Wajib kode OTP yang sedang aktif — session yang dicuri tidak bisa
// mematikan 2FA tanpa akses ke authenticator.
// ============================================================================
exports.disableAuthenticator = async (req, res) => {
  try {
    const { token: totpCode } = req.body;

    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ error: "Token tidak ditemukan" });

    const decoded = jwt.verify(authHeader.split(" ")[1], JWT_SECRET);

    if (!decoded.coreId)
      return res.status(403).json({ error: "Token tidak valid" });

    const coreId = decoded.coreId;

    const authRecord = await AuthIdentity.findOne({
      where: {
        coreId,
        provider: "AUTHENTICATOR",
        type: "TOTP",
        status: "ACTIVE",
      },
    });

    if (!authRecord || !authRecord.secretKey)
      return res
        .status(404)
        .json({ error: "Authenticator belum aktif di akun ini." });

    const secretKey = decryptSecret(authRecord.secretKey);
    const totp = authenticator.clone();
    totp.options = { window: 1 };

    const isValid = totp.check(String(totpCode).trim(), secretKey);

    if (!isValid) {
      return res
        .status(401)
        .json({ error: "Kode Authenticator salah atau kadaluarsa." });
    }

    authRecord.status = "INACTIVE";
    await authRecord.save();

    res.json({
      success: true,
      message: "Authenticator berhasil dinonaktifkan.",
    });
  } catch (error) {
    console.error("Disable authenticator error:", error);
    res.status(500).json({ error: "Gagal menonaktifkan authenticator." });
  }
};

exports.generateAuthResponse = generateAuthResponse;
