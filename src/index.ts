import { loadConfig } from "./config.ts";
import { openSerial } from "./modem/serial.ts";
import { AtParser } from "./modem/at-parser.ts";
import { initSms } from "./modem/sms.ts";
import { createBot, sendMessage } from "./bot/bot.ts";
import { authMiddleware } from "./bot/middleware.ts";
import { atCommand } from "./bot/commands/at.ts";
import { dataOnCommand, dataOffCommand } from "./bot/commands/data.ts";
import { balanceCommand } from "./bot/commands/balance.ts";
import { infoCommand } from "./bot/commands/info.ts";
import { statusCommand } from "./bot/commands/status.ts";
import { SmsForwarder } from "./sms-forwarder.ts";
import { BalanceTracker } from "./balance-tracker.ts";
import { createLogger } from "./utils/logger.ts";

const log = createLogger("main");

async function main() {
  log.info("Starting gg-manage...");

  // Load config
  const config = loadConfig();
  log.info(`Serial: ${config.serialPort} @ ${config.serialBaud}`);

  // Open serial port
  const serial = await openSerial(config.serialPort, config.serialBaud);
  const at = new AtParser(serial);

  // Modem init sequence
  log.info("Initializing modem...");
  await at.execute("ATE0"); // Disable echo
  const atResp = await at.execute("AT");
  log.info(`Modem responded: ${atResp || "OK"}`);

  // Check SIM
  const cpin = await at.execute("AT+CPIN?");
  if (!cpin.includes("READY")) {
    log.error(`SIM not ready: ${cpin}`);
    process.exit(1);
  }
  log.info("SIM ready");

  // Initialize SMS
  await initSms(at);

  // Balance tracker
  const tracker = new BalanceTracker(config.dataDir);

  // Create Telegram bot
  const bot = createBot(config);
  bot.use(authMiddleware(config.telegramChatId));

  // Register commands
  bot.command("at", atCommand(at));
  bot.command("dataon", dataOnCommand(at));
  bot.command("dataoff", dataOffCommand(at));
  bot.command("balance", balanceCommand(at, tracker));
  bot.command("info", infoCommand(at));
  bot.command("status", statusCommand(at, tracker));
  bot.command("help", async (ctx) => {
    const msg = [
      "<b>Available Commands</b>",
      "",
      "/at &lt;cmd&gt; — Send raw AT command",
      "/dataon — Enable mobile data",
      "/dataoff — Disable mobile data",
      "/balance — Check giffgaff balance",
      "/info — SIM &amp; network info",
      "/status — Account status &amp; deactivation date",
      "/help — Show this help",
    ].join("\n");
    await ctx.reply(msg, { parse_mode: "HTML" });
  });

  // Start SMS forwarder
  const forwarder = new SmsForwarder(at, bot, config.telegramChatId, config.smsPollIntervalMs);
  forwarder.start();

  // Graceful shutdown
  const shutdown = async () => {
    log.info("Shutting down...");
    forwarder.stop();
    bot.stop();
    await serial.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start bot
  log.info("Starting Telegram bot...");
  bot.start({
    onStart: async () => {
      log.info("Bot is online");
      await sendMessage(bot, config.telegramChatId, "🟢 gg-manage bot started");
    },
  });
}

main().catch((e) => {
  log.error("Fatal error:", e);
  process.exit(1);
});
