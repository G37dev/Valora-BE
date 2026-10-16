/*
 * WhatsApp OTP sender — provider dipilih via env WA_OTP_PROVIDER:
 *
 *  - "fonnte"  : gateway unofficial (instant, butuh FONNTE_TOKEN dari
 *                dashboard fonnte.com — free tier 1.000 pesan/bln)
 *  - "meta"    : WhatsApp Business Cloud API resmi (butuh WA_ACCESS_TOKEN,
 *                WA_PHONE_NUMBER_ID, dan template auth yang sudah approved —
 *                nama template di WA_TEMPLATE_NAME, default "otp_code")
 *  - tidak di-set: dev fallback — kode di-log ke console, endpoint send-otp
 *                mengembalikan devCode bila ALLOW_OTP_DEV_ECHO=true.
 *
 * Tambah provider lain = tambah satu fungsi sender + cabang di sendOtpWhatsapp.
 */

const FONNTE_TOKEN = process.env.FONNTE_TOKEN;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_TEMPLATE_NAME = process.env.WA_TEMPLATE_NAME || "otp_code";

const PROVIDER =
  process.env.WA_OTP_PROVIDER || (FONNTE_TOKEN ? "fonnte" : "none");

/**
 * Normalisasi nomor HP Indonesia ke format 62xxx (tanpa +).
 * Menerima "08xx", "+62 8xx", "62 8xx", "8xx". Return null kalau invalid.
 */
function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = "62" + digits.slice(1);
  else if (digits.startsWith("8")) digits = "62" + digits;
  if (!/^62\d{8,14}$/.test(digits)) return null;
  return digits;
}

const buildMessage = (code) =>
  `*${code}* adalah kode verifikasi Valora Anda.\n\n` +
  `Kode berlaku 5 menit. Jangan bagikan ke siapa pun, termasuk pihak yang mengaku dari Valora.`;

async function sendViaFonnte(phone, code) {
  const res = await fetch("https://api.fonnte.com/send", {
    method: "POST",
    headers: {
      Authorization: FONNTE_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      target: phone,
      message: buildMessage(code),
      countryCode: "62",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === false) {
    throw new Error(`Fonnte gagal: ${data.reason || res.status}`);
  }
  return { delivered: true };
}

async function sendViaMeta(phone, code) {
  const res = await fetch(
    `https://graph.facebook.com/v21.0/${WA_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: WA_TEMPLATE_NAME,
          language: { code: "id" },
          components: [
            {
              type: "body",
              parameters: [{ type: "text", text: code }],
            },
          ],
        },
      }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Meta WA gagal: ${data.error?.message || res.status}`,
    );
  }
  return { delivered: true };
}

/**
 * Kirim kode OTP ke nomor WA. Return { delivered, dev } — dev=true berarti
 * tidak ada provider aktif dan kode hanya di-log (mode development).
 */
async function sendOtpWhatsapp(phone, code) {
  if (PROVIDER === "fonnte" && FONNTE_TOKEN) {
    return sendViaFonnte(phone, code);
  }
  if (PROVIDER === "meta" && WA_ACCESS_TOKEN && WA_PHONE_NUMBER_ID) {
    return sendViaMeta(phone, code);
  }
  console.log(`[WA-OTP DEV] ${phone} <- ${code}`);
  return { delivered: false, dev: true };
}

module.exports = { sendOtpWhatsapp, normalizePhone, PROVIDER };
