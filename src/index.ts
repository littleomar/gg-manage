import { AccountCookieStore } from "./account/cookie-store.ts";
import { GiffgaffAccountProvider } from "./account/giffgaff-account-provider.ts";
import {
  GiffgaffHttpLoginService,
  extractMfaCode,
} from "./account/giffgaff-login-service.ts";
import { AlertsLog } from "./alerts.ts";
import { BalanceTracker } from "./balance-tracker.ts";
import { createBot, sendMessage } from "./bot/bot.ts";
import { TelegramBotService } from "./bot/telegram-bot-service.ts";
import { loadConfig } from "./config.ts";
import { KeepaliveJob } from "./jobs/keepalive-job.ts";
import { AtParser } from "./modem/at-parser.ts";
import { openSerial } from "./modem/serial.ts";
import { initSms } from "./modem/sms.ts";
import { SmsForwarder } from "./sms-forwarder.ts";
import { createLogger } from "./utils/logger.ts";
import { createProxyFetch } from "./utils/proxy-fetch.ts";

const log = createLogger("main");

async function main() {
  log.info("Starting gg-manage...");

  const config = loadConfig();
  log.info(`Serial: ${config.serialPort} @ ${config.serialBaud}`);

  const serial = await openSerial(config.serialPort, config.serialBaud);
  const at = new AtParser(serial);

  let urcSerial: Awaited<ReturnType<typeof openSerial>> | null = null;
  if (config.serialUrcPort) {
    log.info(`URC port: ${config.serialUrcPort}`);
    urcSerial = await openSerial(config.serialUrcPort, config.serialBaud);
    urcSerial.parser.on("data", (line: string) => at.feedUrc(line));
  }

  log.info("Initializing modem...");
  await at.execute("ATE0");
  const atResp = await at.execute("AT");
  log.info(`Modem responded: ${atResp || "OK"}`);

  const cpin = await at.execute("AT+CPIN?");
  if (!cpin.includes("READY")) {
    log.error(`SIM not ready: ${cpin}`);
    process.exit(1);
  }
  log.info("SIM ready");

  await initSms(at);

  const tracker = new BalanceTracker(config.dataDir);
  const cookieStore = new AccountCookieStore(config.dataDir);
  const alerts = new AlertsLog(config.dataDir);
  const proxyFetch = createProxyFetch(config.telegramProxyUrl);

  const loginService =
    config.giffgaffUsername && config.giffgaffPassword
      ? new GiffgaffHttpLoginService({
          username: config.giffgaffUsername,
          password: config.giffgaffPassword,
          fetch: proxyFetch,
        })
      : undefined;

  if (!loginService) {
    log.warn(
      "GG_USERNAME/GG_PASSWORD not set; /account auto-login disabled.",
    );
  }

  const account = new GiffgaffAccountProvider({
    at,
    tracker,
    cookieStore,
    fetch: proxyFetch,
    dashboardUrl: config.giffgaffDashboardUrl,
    loginService,
  });

  const keepalive = new KeepaliveJob({
    at,
    fetch: proxyFetch,
    alerts,
    keepaliveUrl: config.keepaliveUrl,
    timeoutMs: config.keepaliveTimeoutMs,
  });

  const bot = createBot(config);
  const botService = new TelegramBotService({
    bot,
    at,
    account,
    cookieStore,
    keepalive,
    alerts,
    allowedChatId: config.telegramChatId,
    loginService,
  });

  const forwarder = new SmsForwarder(
    at,
    bot,
    config.telegramChatId,
    config.smsPollIntervalMs,
  );

  if (loginService) {
    forwarder.addInterceptor((sms) => {
      if (!loginService.isLoginInProgress()) return false;
      const code = extractMfaCode(sms.body);
      if (!code) return false;
      log.info("Intercepted giffgaff MFA SMS; forwarding code to login flow");
      return loginService.receiveMfaCode(code);
    });
  }

  forwarder.start();

  const shutdown = async () => {
    log.info("Shutting down...");
    forwarder.stop();
    botService.stop();
    if (urcSerial) await urcSerial.close();
    await serial.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info("Starting Telegram bot...");
  await botService.start(async () => {
    log.info("Bot is online");
    await sendMessage(bot, config.telegramChatId, "🟢 gg-manage bot started");
  });
}

main().catch((e) => {
  log.error("Fatal error:", e);
  process.exit(1);
});
