/*
 * Email OTP sender via SMTP (nodemailer).
 *
 * Env:
 *  - SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS — kredensial mailbox
 *    (contoh cPanel: server103.extremhost.net:465, official@vivalora.id)
 *  - SMTP_FROM — default "Vivalora <SMTP_USER>"
 *  - SMTP_TLS_REJECT_UNAUTHORIZED — set "false" kalau cert self-signed
 *  - Tanpa SMTP_HOST: dev fallback — kode di-log ke console dan
 *    sendOtpEmail return { dev: true } supaya endpoint bisa echo
 *    devCode bila ALLOW_OTP_DEV_ECHO=true (pola sama kayak WA OTP).
 */

const nodemailer = require("nodemailer");

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
const FROM =
  process.env.SMTP_FROM ||
  `Vivalora <${SMTP_USER || "official@vivalora.id"}>`;

let transporter = null;
if (SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 465),
    secure: Number(SMTP_PORT || 465) === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    tls: {
      rejectUnauthorized:
        process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false",
    },
    connectionTimeout: 10000,
    socketTimeout: 15000,
  });
}

const buildHtml = (code) => `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0A0A0A;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:40px 24px;">
    <div style="text-align:center;margin-bottom:28px;">
      <span style="font-size:28px;font-weight:800;letter-spacing:2px;color:#FBE678;">VIVALORA</span>
    </div>
    <div style="background:#141414;border:1px solid #2A2A2A;border-radius:16px;padding:32px 24px;text-align:center;">
      <div style="color:#FFFFFF;font-size:18px;font-weight:600;margin-bottom:8px;">Password Reset Code</div>
      <div style="color:#9A9A9A;font-size:13px;line-height:20px;margin-bottom:24px;">
        You requested to reset your Vivalora account password.<br/>Use the code below to continue:
      </div>
      <div style="background:#0A0A0A;border:1px solid #FBE678;border-radius:12px;padding:18px;margin-bottom:24px;">
        <span style="font-size:34px;font-weight:800;letter-spacing:10px;color:#FBE678;">${code}</span>
      </div>
      <div style="color:#9A9A9A;font-size:12px;line-height:18px;">
        This code expires in <b style="color:#FFFFFF;">5 minutes</b>.<br/>
        If you didn't request this, you can safely ignore this email —<br/>your password won't change.
      </div>
    </div>
    <div style="text-align:center;color:#555555;font-size:11px;margin-top:24px;line-height:16px;">
      Never share this code with anyone, including anyone<br/>claiming to be from Vivalora.
    </div>
  </div>
</body></html>`;

/**
 * Kirim kode OTP ke email. Return { delivered, dev } — dev=true berarti
 * SMTP belum dikonfigurasi dan kode hanya di-log (mode development).
 */
async function sendOtpEmail(email, code) {
  if (!transporter) {
    console.log(`[EMAIL-OTP DEV] ${email} <- ${code}`);
    return { delivered: false, dev: true };
  }
  await transporter.sendMail({
    from: FROM,
    to: email,
    subject: `${code} is your Vivalora reset code`,
    text: `${code} is your Vivalora password reset code. It expires in 5 minutes. Never share it with anyone.`,
    html: buildHtml(code),
  });
  return { delivered: true };
}

module.exports = { sendOtpEmail };
