const crypto = require("crypto");
const axios = require("axios");

const APP_TOKEN = process.env.SUMSUB_APP_TOKEN;
const SECRET_KEY = process.env.SUMSUB_SECRET_KEY;
const WEBHOOK_SECRET = process.env.SUMSUB_WEBHOOK_SECRET;
const LEVEL_NAME = process.env.SUMSUB_LEVEL_NAME || "id-and-liveness";
const BASE_URL = process.env.SUMSUB_BASE_URL || "https://api.sumsub.com";

function isConfigured() {
  return Boolean(APP_TOKEN && SECRET_KEY);
}

/*
 * Signature request Sumsub — X-App-Access-Sig =
 * HMAC-SHA256 hex dari (ts + METHOD + url-dengan-query + body-string)
 * ditandatangani dengan SECRET_KEY. Setiap request API wajib
 * bawa X-App-Token + X-App-Access-Ts + X-App-Access-Sig.
 */
function buildHeaders(method, urlWithQuery, bodyString) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto
    .createHmac("sha256", SECRET_KEY)
    .update(ts + method.toUpperCase() + urlWithQuery + (bodyString || ""))
    .digest("hex");

  return {
    "Content-Type": "application/json",
    "X-App-Token": APP_TOKEN,
    "X-App-Access-Ts": ts,
    "X-App-Access-Sig": sig,
  };
}

async function signedRequest(method, pathWithQuery, body) {
  const bodyString = body ? JSON.stringify(body) : "";
  const { data } = await axios({
    method,
    url: `${BASE_URL}${pathWithQuery}`,
    data: body || undefined,
    headers: buildHeaders(method, pathWithQuery, bodyString),
    timeout: 15_000,
  });
  return data;
}

/*
 * Buat/ambil applicant lalu accessToken untuk launch mobile SDK.
 * externalUserId = coreId — Sumsub balikin itu di webhook.
 * POST /resources/applicants?levelName=X  (idempotent per externalUserId:
 * kalau sudah ada, ambil yang lama via /applicants/-/one)
 * POST /resources/accessTokens?userId=X&levelName=Y&ttlInSecs=Z
 */
async function createAccessToken({ coreId, levelName, ttlInSecs = 1200 }) {
  if (!isConfigured()) {
    throw new Error(
      "Sumsub belum dikonfigurasi (SUMSUB_APP_TOKEN/SECRET_KEY).",
    );
  }

  const level = levelName || LEVEL_NAME;
  let applicant;

  try {
    applicant = await signedRequest(
      "POST",
      `/resources/applicants?levelName=${encodeURIComponent(level)}`,
      { externalUserId: coreId },
    );
  } catch (err) {
    // 409 = applicant dengan externalUserId ini sudah ada → pakai yang lama
    if (err?.response?.status === 409) {
      applicant = await signedRequest(
        "GET",
        `/resources/applicants/-/one?externalUserId=${encodeURIComponent(coreId)}`,
      );
    } else {
      throw err;
    }
  }

  const token = await signedRequest(
    "POST",
    `/resources/accessTokens?userId=${encodeURIComponent(coreId)}` +
      `&levelName=${encodeURIComponent(level)}&ttlInSecs=${ttlInSecs}`,
  );

  return { applicant, token };
}

/*
 * Refresh accessToken — dipanggil SDK dari tokenExpirationHandler
 * kalau token di tengah flow expired.
 */
async function refreshAccessToken({ coreId, ttlInSecs = 1200 }) {
  const { token } = await createAccessToken({ coreId, ttlInSecs });
  return token;
}

/*
 * Ambil status review applicant.
 * GET /resources/applicants/{applicantId}/status
 * → { reviewStatus, reviewResult: { reviewAnswer } }
 */
async function getApplicantStatus(applicantId) {
  if (!isConfigured()) {
    throw new Error(
      "Sumsub belum dikonfigurasi (SUMSUB_APP_TOKEN/SECRET_KEY).",
    );
  }
  return signedRequest(
    "GET",
    `/resources/applicants/${encodeURIComponent(applicantId)}/status`,
  );
}

/*
 * Verifikasi signature webhook Sumsub.
 * Header: X-Payload-Digest (hex) + X-Payload-Digest-Alg
 * (HMAC_SHA1_HEX / HMAC_SHA256_HEX / HMAC_SHA512_HEX — default sha256).
 */
function verifyWebhookSignature(rawBody, digest, alg) {
  if (!WEBHOOK_SECRET || !digest || !rawBody) return false;

  const nodeAlg =
    {
      HMAC_SHA1_HEX: "sha1",
      HMAC_SHA256_HEX: "sha256",
      HMAC_SHA512_HEX: "sha512",
    }[String(alg || "").toUpperCase()] || "sha256";

  const expected = crypto
    .createHmac(nodeAlg, WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(digest), "utf8");
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

/*
 * Map status review Sumsub → status KycProfile lokal.
 * Dipakai webhook (payload.reviewResult/reviewStatus) dan
 * auto-sync (response GET /status yang shapenya sama).
 */
function mapStatusToLocal({ reviewStatus, reviewAnswer }) {
  if (reviewStatus === "completed" || reviewAnswer) {
    if (reviewAnswer === "GREEN") return "VERIFIED";
    if (reviewAnswer === "RED") return "REJECTED";
  }
  switch (reviewStatus) {
    case "init":
    case "pending":
    case "queued":
    case "onHold":
    case "awaitingUser":
    case "processed":
      return "PENDING";
    default:
      return null;
  }
}

module.exports = {
  isConfigured,
  createAccessToken,
  refreshAccessToken,
  getApplicantStatus,
  mapStatusToLocal,
  verifyWebhookSignature,
};
