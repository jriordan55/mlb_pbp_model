// Quick check: node telegram_test.js
// Needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env

const fs = require("node:fs");
const path = require("node:path");
const { sendTelegram, telegramConfigured } = require("./telegram");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadEnv(path.join(__dirname, ".env"));

(async () => {
  if (!telegramConfigured()) {
    console.error(
      "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID. Add them to .env first.",
    );
    process.exit(1);
  }
  const result = await sendTelegram(
    `mlb_pbp_model test alert ✅\n${new Date().toISOString()}`,
  );
  console.log(result.ok ? "Sent. Check Telegram." : result);
  process.exit(result.ok ? 0 : 1);
})();
