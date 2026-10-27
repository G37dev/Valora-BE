const jwt = require("jsonwebtoken");
const Redis = require("ioredis");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

const { User, AuthIdentity } = require("../models");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable wajib di-set.");
}

// ============================================================================
// RP CONFIG
// ============================================================================
const RP_NAME = process.env.WEBAUTHN_RP_NAME || "Valora";
const RP_ID = process.env.WEBAUTHN_RP_ID || "valora-be.vercel.app";

/*
 * Origin yang diizinkan:
 * - https://<RP_ID>  untuk web client / dev tools
 * - android:apk-key-hash:<base64url sha256 cert> untuk native Android
 *   (nilai saat ini = debug keystore; tambah fingerprint release
 *   keystore lewat env WEBAUTHN_ORIGINS kalau sudah ada)
 */
const ALLOWED_ORIGINS = (
  process.env.WEBAUTHN_ORIGINS ||
  `https://${RP_ID},android:apk-key-hash:1YhGWjkDfUmomsw2jWUay4EAYjll8n0ccd8FKJimvVQ,android:apk-key-hash:-sYXRdwJA3hvue3mKpYrOZ9zSPC7b4mbgzJmdZEDO5w,android:apk-key-hash:peg-EdHWEq5V5BT8ZLZCMSxRtJ6jd8qc7pNGkhmw_dA,android:apk-key-hash:-mWoBUaDbSRw3z40vfTRsOTmlU0EMk2ndmmbp0q57FY`
).split(",");

const CHALLENGE_TTL = 300; // 5 menit

// ============================================================================
// CHALLENGE STORE — Redis kalau tersedia, fallback in-memory (dev)
// ============================================================================
let redis;
const memStore = new Map();

function getRedis() {
  if (redis === undefined) {
    redis = process.env.REDIS_URL
      ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2 })
      : null;
  }
  return redis;
}

async function setChallenge(key, challenge) {
  const r = getRedis();
  if (r) {
    await r.set(`pk:${key}`, challenge, "EX", CHALLENGE_TTL);
  } else {
    memStore.set(key, { challenge, exp: Date.now() + CHALLENGE_TTL * 1000 });
  }
}

async function consumeChallenge(key) {
  const r = getRedis();
  if (r) {
    const k = `pk:${key}`;
    const challenge = await r.get(k);
    await r.del(k); // single-use — challenge tidak bisa di-replay
    return challenge;
  }
  const entry = memStore.get(key);
  memStore.delete(key);
  if (!entry || Date.now() > entry.exp) return null;
  return entry.challenge;
}

// ============================================================================
// HELPERS
// ============================================================================
function decodeAuthToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  try {
    return jwt.verify(authHeader.split(" ")[1], JWT_SECRET);
  } catch {
    return null;
  }
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const fromB64url = (str) => new Uint8Array(Buffer.from(str, "base64url"));

async function getActivePasskeys(coreId) {
  const records = await AuthIdentity.findAll({
    where: { coreId, provider: "PASSKEY", type: "WEBAUTHN", status: "ACTIVE" },
  });

  return records.map((r) => {
    const data = JSON.parse(r.secretKey);
    return {
      record: r,
      id: r.providerUserId,
      publicKey: fromB64url(data.publicKey),
      counter: data.counter || 0,
      transports: data.transports || [],
    };
  });
}

async function generateAuthResponse(coreId) {
  const userProfile = await User.findOne({ where: { coreId } });
  if (!userProfile) throw new Error("Profil user tidak ditemukan");

  const token = jwt.sign(
    {
      coreId: coreId,
      email: userProfile.email,
      name: `${userProfile.firstName || ""} ${userProfile.lastName || ""}`.trim(),
      sub: coreId,
      aud: "valora-core",
    },
    JWT_SECRET,
    { expiresIn: "7d" },
  );

  return {
    token,
    user: {
      coreId: userProfile.coreId,
      email: userProfile.email,
      firstName: userProfile.firstName,
      lastName: userProfile.lastName,
      name: `${userProfile.firstName || ""} ${userProfile.lastName || ""}`.trim(),
      phoneNumber: userProfile.phoneNumber,
      avatarUrl: userProfile.avatarUrl,
      created_at: userProfile.createdAt,
      updated_at: userProfile.updatedAt,
    },
  };
}

// ============================================================================
// 1. REGISTER OPTIONS — butuh JWT penuh (setup dari profile)
// ============================================================================
exports.getRegisterOptions = async (req, res) => {
  try {
    const decoded = decodeAuthToken(req);
    if (!decoded || !decoded.coreId)
      return res.status(401).json({ error: "Token tidak valid" });

    const coreId = decoded.coreId;
    const userProfile = await User.findOne({ where: { coreId } });
    if (!userProfile)
      return res.status(404).json({ error: "Profil user tidak ditemukan" });

    const existing = await getActivePasskeys(coreId);

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: userProfile.email,
      userDisplayName:
        `${userProfile.firstName || ""} ${userProfile.lastName || ""}`.trim() ||
        userProfile.email,
      userID: new Uint8Array(Buffer.from(coreId, "utf8")),
      attestationType: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
        authenticatorAttachment: "platform", // biometrik device (bukan security key)
      },
      excludeCredentials: existing.map((pk) => ({
        id: pk.id,
        transports: pk.transports,
      })),
    });

    await setChallenge(`reg:${coreId}`, options.challenge);

    res.json(options);
  } catch (error) {
    console.error("Passkey register options error:", error);
    res.status(500).json({ error: "Gagal membuat opsi registrasi passkey." });
  }
};

// ============================================================================
// 2. REGISTER VERIFY — simpan credential baru
// ============================================================================
exports.verifyRegister = async (req, res) => {
  try {
    const decoded = decodeAuthToken(req);
    if (!decoded || !decoded.coreId)
      return res.status(401).json({ error: "Token tidak valid" });

    const coreId = decoded.coreId;
    const { response, friendlyName } = req.body;
    if (!response)
      return res.status(400).json({ error: "Response passkey wajib diisi." });

    const challenge = await consumeChallenge(`reg:${coreId}`);
    if (!challenge)
      return res
        .status(400)
        .json({ error: "Challenge tidak ditemukan atau kadaluarsa." });

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: ALLOWED_ORIGINS,
        expectedRPID: RP_ID,
        requireUserVerification: false,
      });
    } catch (err) {
      console.error("Passkey attestation invalid:", err.message);
      return res
        .status(400)
        .json({ error: "Verifikasi passkey gagal. Coba lagi." });
    }

    const { verified, registrationInfo } = verification;
    if (!verified || !registrationInfo)
      return res.status(400).json({ error: "Verifikasi passkey gagal." });

    const { credential } = registrationInfo;

    const dup = await AuthIdentity.findOne({
      where: {
        provider: "PASSKEY",
        type: "WEBAUTHN",
        providerUserId: credential.id,
      },
    });
    if (dup)
      return res
        .status(409)
        .json({ error: "Passkey ini sudah terdaftar di akun lain." });

    await AuthIdentity.create({
      coreId,
      type: "WEBAUTHN",
      provider: "PASSKEY",
      providerUserId: credential.id,
      secretKey: JSON.stringify({
        publicKey: b64url(credential.publicKey),
        counter: credential.counter || 0,
        transports: credential.transports || [],
        friendlyName: friendlyName || "Passkey",
      }),
      status: "ACTIVE",
    });

    res.json({ verified: true, message: "Passkey berhasil didaftarkan." });
  } catch (error) {
    console.error("Passkey register verify error:", error);
    res.status(500).json({ error: "Gagal mendaftarkan passkey." });
  }
};

// ============================================================================
// 3. AUTH OPTIONS — butuh pre_auth token (login) atau JWT penuh
// ============================================================================
exports.getAuthOptions = async (req, res) => {
  try {
    const decoded = decodeAuthToken(req);
    if (!decoded || !decoded.coreId)
      return res.status(401).json({ error: "Token tidak valid" });

    const coreId = decoded.coreId;
    const passkeys = await getActivePasskeys(coreId);

    if (passkeys.length === 0)
      return res
        .status(404)
        .json({ error: "Tidak ada passkey terdaftar di akun ini." });

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials: passkeys.map((pk) => ({
        id: pk.id,
        transports: pk.transports,
      })),
      userVerification: "preferred",
    });

    await setChallenge(`auth:${coreId}`, options.challenge);

    res.json(options);
  } catch (error) {
    console.error("Passkey auth options error:", error);
    res.status(500).json({ error: "Gagal membuat opsi autentikasi passkey." });
  }
};

// ============================================================================
// 4. AUTH VERIFY — verifikasi assertion → keluarkan JWT penuh
// ============================================================================
exports.verifyAuth = async (req, res) => {
  try {
    const decoded = decodeAuthToken(req);
    if (!decoded || !decoded.coreId)
      return res.status(401).json({ error: "Token tidak valid" });

    const coreId = decoded.coreId;
    const { response } = req.body;
    if (!response)
      return res.status(400).json({ error: "Response passkey wajib diisi." });

    const challenge = await consumeChallenge(`auth:${coreId}`);
    if (!challenge)
      return res
        .status(400)
        .json({ error: "Challenge tidak ditemukan atau kadaluarsa." });

    const passkeys = await getActivePasskeys(coreId);
    const passkey = passkeys.find((pk) => pk.id === response.id);
    if (!passkey)
      return res.status(404).json({ error: "Passkey tidak dikenali." });

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: ALLOWED_ORIGINS,
        expectedRPID: RP_ID,
        credential: {
          id: passkey.id,
          publicKey: passkey.publicKey,
          counter: passkey.counter,
          transports: passkey.transports,
        },
        requireUserVerification: false,
      });
    } catch (err) {
      console.error("Passkey assertion invalid:", err.message);
      return res
        .status(401)
        .json({ error: "Verifikasi passkey gagal. Coba lagi." });
    }

    if (!verification.verified)
      return res.status(401).json({ error: "Verifikasi passkey gagal." });

    /*
     * Update sign counter — proteksi clone authenticator.
     * Kalau counter turun, server menolak di verifikasi di atas.
     */
    passkey.record.secretKey = JSON.stringify({
      ...JSON.parse(passkey.record.secretKey),
      counter: verification.authenticationInfo.newCounter,
    });
    await passkey.record.save();

    const authData = await generateAuthResponse(coreId);
    res.json({ message: "Passkey login sukses!", ...authData });
  } catch (error) {
    console.error("Passkey auth verify error:", error);
    res.status(500).json({ error: "Gagal verifikasi passkey." });
  }
};

// ============================================================================
// 5. LIST / DELETE — manajemen di profile
// ============================================================================
exports.listPasskeys = async (req, res) => {
  try {
    const decoded = decodeAuthToken(req);
    if (!decoded || !decoded.coreId)
      return res.status(401).json({ error: "Token tidak valid" });

    const passkeys = await getActivePasskeys(decoded.coreId);

    res.json({
      passkeys: passkeys.map((pk) => {
        const data = JSON.parse(pk.record.secretKey);
        return {
          id: pk.record.id,
          credentialId: pk.id.substring(0, 12) + "...",
          friendlyName: data.friendlyName || "Passkey",
          createdAt: pk.record.created_at,
        };
      }),
    });
  } catch (error) {
    console.error("Passkey list error:", error);
    res.status(500).json({ error: "Gagal memuat daftar passkey." });
  }
};

exports.deletePasskey = async (req, res) => {
  try {
    const decoded = decodeAuthToken(req);
    if (!decoded || !decoded.coreId)
      return res.status(401).json({ error: "Token tidak valid" });

    const { id } = req.params;
    const record = await AuthIdentity.findOne({
      where: {
        id,
        coreId: decoded.coreId,
        provider: "PASSKEY",
        type: "WEBAUTHN",
        status: "ACTIVE",
      },
    });

    if (!record)
      return res.status(404).json({ error: "Passkey tidak ditemukan." });

    record.status = "INACTIVE";
    await record.save();

    res.json({ success: true, message: "Passkey berhasil dihapus." });
  } catch (error) {
    console.error("Passkey delete error:", error);
    res.status(500).json({ error: "Gagal menghapus passkey." });
  }
};
