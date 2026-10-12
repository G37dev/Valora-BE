const crypto = require("crypto");
const axios = require("axios");

const API_KEY = process.env.DIDIT_API_KEY;
const WEBHOOK_SECRET = process.env.DIDIT_WEBHOOK_SECRET;
const WORKFLOW_ID = process.env.DIDIT_WORKFLOW_ID;
const BASE_URL =
  process.env.DIDIT_BASE_URL || "https://verification.didit.me/v3";

function isConfigured() {
  return Boolean(API_KEY && WORKFLOW_ID);
}

function sign(payload) {
  return crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(payload)
    .digest("hex");
}

/*
 * Buat verification session baru di Didit.
 * POST /v3/session/ → { session_id, url, session_token }
 * session_token dipakai FE untuk launch native SDK.
 */
async function createSession({ coreId, callback }) {
  if (!isConfigured()) {
    throw new Error("Didit belum dikonfigurasi (DIDIT_API_KEY/WORKFLOW_ID).");
  }

  const { data } = await axios.post(
    `${BASE_URL}/session/`,
    {
      workflow_id: WORKFLOW_ID,
      vendor_data: coreId,
      callback,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
      },
      timeout: 15_000,
    },
  );

  return data;
}

/*
 * Verifikasi signature webhook Didit — X-Signature = HMAC-SHA256
 * hex dari raw request body dengan per-destination webhook secret.
 */
function verifyWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET || !signature || !rawBody) return false;

  const expected = sign(rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

/*
 * Ambil decision verifikasi (GET /v3/session/{id}/decision/).
 * Response punya field `status` top-level ("Approved", "Declined",
 * "In Review", dst). Return null kalau belum ada decision.
 */
async function getDecision(sessionId) {
  if (!API_KEY) {
    throw new Error("Didit belum dikonfigurasi (DIDIT_API_KEY).");
  }

  const { data } = await axios.get(
    `${BASE_URL}/session/${sessionId}/decision/`,
    {
      headers: { "x-api-key": API_KEY },
      timeout: 15_000,
    },
  );

  return data || null;
}

/*
 * Map status Didit (case-sensitive persis) → status KycProfile lokal.
 */
function mapStatusToLocal(status) {
  switch (status) {
    case "Approved":
      return "VERIFIED";
    case "Declined":
    case "Expired":
    case "Kyc Expired":
      return "REJECTED";
    case "In Review":
    case "In Progress":
    case "Not Started":
    case "Resubmitted":
    case "Awaiting User":
      return "PENDING";
    case "Abandoned":
      return "UNVERIFIED";
    default:
      return null;
  }
}

module.exports = {
  isConfigured,
  createSession,
  getDecision,
  mapStatusToLocal,
  verifyWebhookSignature,
};
