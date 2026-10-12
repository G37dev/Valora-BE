const crypto = require("crypto");
const axios = require("axios");

const API_KEY = process.env.VERIFF_API_KEY;
const API_SECRET = process.env.VERIFF_API_SECRET;
const BASE_URL =
  process.env.VERIFF_BASE_URL || "https://stationapi.veriff.com/v1";

function isConfigured() {
  return Boolean(API_KEY && API_SECRET);
}

function sign(payload) {
  return crypto.createHmac("sha256", API_SECRET).update(payload).digest("hex");
}

/*
 * Buat verification session baru di Veriff.
 * Return { id, url, sessionToken } — url = hosted verification page.
 */
async function createSession({
  coreId,
  firstName,
  lastName,
  documentCountry,
  documentType,
  callback,
}) {
  if (!isConfigured()) {
    throw new Error("Veriff belum dikonfigurasi (VERIFF_API_KEY/SECRET).");
  }

  const body = JSON.stringify({
    verification: {
      callback,
      vendorData: coreId,
      timestamp: new Date().toISOString(),
      person: {
        firstName: firstName || undefined,
        lastName: lastName || undefined,
      },
      document: documentCountry
        ? {
            country: documentCountry,
            type: documentType || undefined,
          }
        : undefined,
    },
  });

  const { data } = await axios.post(`${BASE_URL}/sessions`, body, {
    headers: {
      "Content-Type": "application/json",
      "X-AUTH-CLIENT": API_KEY,
      "X-HMAC-SIGNATURE": sign(body),
    },
    timeout: 15_000,
  });

  return data.verification;
}

/*
 * Verifikasi signature webhook Veriff — HMAC-SHA256 hex dari
 * raw request body dengan API secret.
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!isConfigured() || !signature || !rawBody) return false;

  const expected = sign(rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

/*
 * Ambil decision verifikasi (GET /sessions/:id/decision).
 * Signature untuk GET = HMAC(sessionId). Return null kalau
 * decision belum keluar.
 */
async function getDecision(sessionId) {
  if (!isConfigured()) {
    throw new Error("Veriff belum dikonfigurasi (VERIFF_API_KEY/SECRET).");
  }

  const { data } = await axios.get(
    `${BASE_URL}/sessions/${sessionId}/decision`,
    {
      headers: {
        "X-AUTH-CLIENT": API_KEY,
        "X-HMAC-SIGNATURE": sign(sessionId),
      },
      timeout: 15_000,
    },
  );

  return data?.verification || null;
}

/*
 * Map decision Veriff → status KycProfile lokal.
 */
function mapDecisionToStatus(decision) {
  switch (String(decision || "").toLowerCase()) {
    case "approved":
      return "VERIFIED";
    case "declined":
      return "REJECTED";
    case "resubmission_requested":
    case "in_review":
      return "PENDING";
    case "abandoned":
      return "UNVERIFIED";
    case "expired":
      return "REJECTED";
    default:
      return null;
  }
}

module.exports = {
  isConfigured,
  createSession,
  getDecision,
  mapDecisionToStatus,
  verifyWebhookSignature,
};
