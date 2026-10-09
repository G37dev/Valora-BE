const { UserPushToken } = require("../models");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const ANDROID_CHANNEL_ID = "transactions";

/**
 * Kirim push notification ke semua device milik satu user (by coreId).
 * Token yang sudah mati (DeviceNotRegistered) otomatis dihapus.
 *
 * Catatan: butuh FCM service-account key yang di-upload ke Expo
 * (Push Notifications credentials) agar Android delivery jalan.
 */
async function sendPushToUser(coreId, { title, body, data, sound }) {
  const tokens = await UserPushToken.findAll({ where: { coreId } });

  if (!tokens.length) {
    return { sent: 0 };
  }

  const messages = tokens.map((t) => ({
    to: t.pushToken,
    title,
    body,
    data: data || {},
    sound: sound || "notif",
    channelId: ANDROID_CHANNEL_ID,
    priority: "high",
  }));

  const response = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(messages),
  });

  const result = await response.json();
  const tickets = result.data || [];

  // Bersihkan token yang sudah tidak valid
  const deadTokens = [];
  tickets.forEach((ticket, i) => {
    if (
      ticket.status === "error" &&
      ticket.details?.error === "DeviceNotRegistered"
    ) {
      deadTokens.push(tokens[i].pushToken);
    }
  });

  if (deadTokens.length) {
    await UserPushToken.destroy({ where: { pushToken: deadTokens } });
  }

  return { sent: tickets.length - deadTokens.length, tickets };
}

module.exports = { sendPushToUser };
