// Free Telegram alerts via Bot API (BotFather).
// Requires TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in env / GitHub secrets.
// Optional TELEGRAM_ALERT_STATE path persists dedupe across GitHub Actions runs.

const fs = require("node:fs");
const path = require("node:path");

const recentAlerts = new Map();
let stateLoaded = false;

function alertStatePath() {
  if (process.env.TELEGRAM_ALERT_STATE) {
    return path.resolve(process.env.TELEGRAM_ALERT_STATE);
  }
  if (process.env.SCRAPER_DATA_DIR) {
    return path.join(path.resolve(process.env.SCRAPER_DATA_DIR), ".telegram_alerts.json");
  }
  return path.join(__dirname, "data", ".telegram_alerts.json");
}

function loadAlertState() {
  if (stateLoaded) return;
  stateLoaded = true;
  const filePath = alertStatePath();
  try {
    if (!fs.existsSync(filePath)) return;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const now = Date.now();
    for (const [key, expiresAt] of Object.entries(raw || {})) {
      if (Number(expiresAt) > now) recentAlerts.set(key, Number(expiresAt));
    }
  } catch (error) {
    console.error("Telegram alert state load failed:", error.message || error);
  }
}

function saveAlertState() {
  const filePath = alertStatePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const now = Date.now();
    const out = {};
    for (const [key, expiresAt] of recentAlerts) {
      if (expiresAt > now) out[key] = expiresAt;
    }
    fs.writeFileSync(filePath, JSON.stringify(out, null, 2));
  } catch (error) {
    console.error("Telegram alert state save failed:", error.message || error);
  }
}

function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

function shouldAlert(key, ttlMs = Number(process.env.TELEGRAM_ALERT_TTL_MS) || 30 * 60 * 1000) {
  loadAlertState();
  const now = Date.now();
  for (const [seenKey, expiresAt] of recentAlerts) {
    if (expiresAt <= now) recentAlerts.delete(seenKey);
  }
  if (!key) return true;
  if (recentAlerts.has(key)) return false;
  recentAlerts.set(key, now + ttlMs);
  saveAlertState();
  return true;
}

async function sendTelegram(text, { key = null, ttlMs } = {}) {
  if (!telegramConfigured()) return { ok: false, skipped: true };
  if (key && !shouldAlert(key, ttlMs)) return { ok: false, deduped: true };

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const body = {
    chat_id: chatId,
    text: String(text || "").slice(0, 4000),
    disable_web_page_preview: true,
  };

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      console.error(
        "Telegram send failed:",
        payload.description || response.statusText || response.status,
      );
      if (key) {
        recentAlerts.delete(key);
        saveAlertState();
      }
      return { ok: false, error: payload.description || String(response.status) };
    }
    return { ok: true };
  } catch (error) {
    console.error("Telegram send error:", error.message || error);
    if (key) {
      recentAlerts.delete(key);
      saveAlertState();
    }
    return { ok: false, error: error.message || String(error) };
  }
}

module.exports = {
  telegramConfigured,
  shouldAlert,
  sendTelegram,
};
