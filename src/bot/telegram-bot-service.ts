import type { Bot, Context } from "grammy";
import type { AccountProvider } from "../account/provider.ts";
import type { AccountCookieStore } from "../account/cookie-store.ts";
import type { GiffgaffHttpLoginService } from "../account/giffgaff-login-service.ts";
import type { AlertsLog } from "../alerts.ts";
import type { AtParser } from "../modem/at-parser.ts";
import type { KeepaliveJob } from "../jobs/keepalive-job.ts";
import { disableData, enableData, getDataStatus } from "../modem/network.ts";
import { getSimInfo } from "../modem/sim-info.ts";
import { createLogger } from "../utils/logger.ts";
import { escapeHtml } from "../utils/html.ts";
import { authMiddleware } from "./middleware.ts";
import {
  formatAccountStatus,
  formatAccountSummary,
  formatBalanceResponse,
  formatHelpMenu,
  formatSimInfo,
} from "./formatters.ts";

const logger = createLogger("bot.telegram");

const BOT_MENU_COMMANDS = [
  { command: "help", description: "Show available commands" },
  { command: "status", description: "Account status & deactivation date" },
  { command: "balance", description: "Check giffgaff balance via USSD" },
  { command: "account", description: "Refresh account via giffgaff dashboard" },
  {
    command: "accountcookie",
    description: "Set dashboard cookie: /accountcookie <cookie>",
  },
  { command: "keepalive", description: "Run minimal data traffic to keep SIM active" },
  { command: "info", description: "SIM & network info" },
  { command: "dataon", description: "Enable mobile data" },
  { command: "dataoff", description: "Disable mobile data" },
  { command: "at", description: "Send raw AT command" },
] as const;

export interface TelegramBotServiceOptions {
  bot: Bot;
  at: AtParser;
  account: AccountProvider;
  cookieStore: AccountCookieStore;
  keepalive: KeepaliveJob;
  alerts: AlertsLog;
  allowedChatId: number;
  loginService?: GiffgaffHttpLoginService;
}

export class TelegramBotService {
  readonly #bot: Bot;
  readonly #at: AtParser;
  readonly #account: AccountProvider;
  readonly #cookieStore: AccountCookieStore;
  readonly #keepalive: KeepaliveJob;
  readonly #alerts: AlertsLog;
  readonly #allowedChatId: number;
  readonly #loginService?: GiffgaffHttpLoginService;

  constructor(options: TelegramBotServiceOptions) {
    this.#bot = options.bot;
    this.#at = options.at;
    this.#account = options.account;
    this.#cookieStore = options.cookieStore;
    this.#keepalive = options.keepalive;
    this.#alerts = options.alerts;
    this.#allowedChatId = options.allowedChatId;
    this.#loginService = options.loginService;
  }

  async start(onStart: () => Promise<void> | void): Promise<void> {
    this.#bot.use(authMiddleware(this.#allowedChatId));
    try {
      await this.#bot.api.setMyCommands([...BOT_MENU_COMMANDS]);
    } catch (e) {
      logger.warn("Failed to register bot menu commands:", e);
    }
    this.#registerHandlers();
    this.#bot.start({ onStart });
  }

  stop(): void {
    this.#bot.stop();
  }

  #registerHandlers(): void {
    this.#bot.command("balance", (ctx) => this.#handleBalance(ctx));
    this.#bot.command("account", (ctx) => this.#handleAccount(ctx));
    this.#bot.command("accountcookie", (ctx) => this.#handleAccountCookie(ctx));
    this.#bot.command("keepalive", (ctx) => this.#handleKeepalive(ctx));
    this.#bot.command("status", (ctx) => this.#handleStatus(ctx));
    this.#bot.command("info", (ctx) => this.#handleInfo(ctx));
    this.#bot.command("dataon", (ctx) => this.#handleDataOn(ctx));
    this.#bot.command("dataoff", (ctx) => this.#handleDataOff(ctx));
    this.#bot.command("at", (ctx) => this.#handleAt(ctx));
    this.#bot.command("help", async (ctx) => {
      await ctx.reply(formatHelpMenu(), { parse_mode: "HTML" });
    });
  }

  async #handleBalance(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    logger.info("Handling /balance.", { chatId });
    await ctx.reply("Checking balance...");
    try {
      const result = await this.#account.refreshViaUssd();
      await ctx.reply(formatBalanceResponse(result), { parse_mode: "HTML" });
      logger.info("/balance reply sent.", {
        chatId,
        parsed: result.parsedBalance,
      });
    } catch (e) {
      const details = e instanceof Error ? e.message : String(e);
      await this.#alerts.insertAlert(
        "error",
        "balance_refresh_failed",
        "Balance refresh failed.",
        { error: details },
      );
      await ctx.reply(`Failed to check balance: ${details}`);
    }
  }

  async #handleAccount(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    logger.info("Handling /account.", { chatId });
    await ctx.reply("Refreshing dashboard...");

    this.#loginService?.setOnAwaitingMfa(() => {
      void ctx
        .reply("Awaiting giffgaff verification SMS (up to 90s)...")
        .catch(() => undefined);
    });

    try {
      const result = await this.#account.refreshViaDashboard();
      await ctx.reply(formatAccountSummary(result), { parse_mode: "HTML" });
      logger.info("/account reply sent.", {
        chatId,
        parsed: result.parsedBalance,
      });
    } catch (e) {
      const details = e instanceof Error ? e.message : String(e);
      await this.#alerts.insertAlert(
        "error",
        "account_refresh_failed",
        "Account refresh failed.",
        { error: details },
      );
      await ctx.reply(`Failed to refresh account: ${details}`);
    } finally {
      this.#loginService?.setOnAwaitingMfa(null);
    }
  }

  async #handleAccountCookie(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    const raw = (ctx.match ?? "").toString().trim();

    if (!raw) {
      await ctx.reply(
        [
          "Usage: /accountcookie <cookie> — store the giffgaff dashboard cookie.",
          "Use /accountcookie clear to remove the saved cookie.",
        ].join("\n"),
      );
      return;
    }

    if (raw.toLowerCase() === "clear") {
      await this.#cookieStore.set(null);
      logger.info("Cleared dashboard cookie.", { chatId });
      await safeDeleteMessage(ctx);
      await ctx.reply("Dashboard cookie cleared.");
      return;
    }

    await this.#cookieStore.set(raw);
    logger.info("Updated dashboard cookie.", {
      chatId,
      cookieLength: raw.length,
    });
    await safeDeleteMessage(ctx);

    try {
      const result = await this.#account.refreshViaDashboard();
      await ctx.reply(
        `Cookie saved and verified.\n\n${formatAccountSummary(result)}`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      const details = e instanceof Error ? e.message : String(e);
      await this.#alerts.insertAlert(
        "warn",
        "account_cookie_validation_failed",
        "Dashboard cookie validation failed.",
        { error: details },
      );
      await ctx.reply(`Cookie saved, but verification failed: ${details}`);
    }
  }

  async #handleKeepalive(ctx: Context): Promise<void> {
    logger.info("Handling /keepalive.", { chatId: ctx.chat?.id });
    const result = await this.#keepalive.run();
    await ctx.reply(result.message);
  }

  async #handleStatus(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    logger.info("Handling /status.", { chatId });
    try {
      const [summary, dataStatus] = await Promise.all([
        this.#account.getStatus(),
        getDataStatus(this.#at),
      ]);

      if (!summary.lastChangeDate) {
        await ctx.reply(
          "No balance change recorded yet.\nUse /balance to check your balance first.",
        );
        return;
      }

      await ctx.reply(formatAccountStatus(summary, dataStatus), {
        parse_mode: "HTML",
      });
    } catch (e) {
      const details = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Failed to get status: ${details}`);
    }
  }

  async #handleInfo(ctx: Context): Promise<void> {
    logger.info("Handling /info.", { chatId: ctx.chat?.id });
    try {
      const info = await getSimInfo(this.#at);
      await ctx.reply(formatSimInfo(info), { parse_mode: "HTML" });
    } catch (e) {
      const details = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Failed to get SIM info: ${details}`);
    }
  }

  async #handleDataOn(ctx: Context): Promise<void> {
    logger.info("Handling /dataon.", { chatId: ctx.chat?.id });
    const result = await enableData(this.#at);
    const status = await getDataStatus(this.#at);
    await ctx.reply(`${result}\nCurrent status: ${status}`);
  }

  async #handleDataOff(ctx: Context): Promise<void> {
    logger.info("Handling /dataoff.", { chatId: ctx.chat?.id });
    const result = await disableData(this.#at);
    const status = await getDataStatus(this.#at);
    await ctx.reply(`${result}\nCurrent status: ${status}`);
  }

  async #handleAt(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    const cmd = (ctx.match ?? "").toString().trim();

    if (!cmd) {
      await ctx.reply("Usage: /at <AT command>\nExample: /at AT+CSQ");
      return;
    }

    logger.info("Handling /at.", { chatId, cmd });
    try {
      const response = await this.#at.execute(cmd, 15000);
      await ctx.reply(
        `<pre>${escapeHtml(cmd)}\n${escapeHtml(response || "OK")}</pre>`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await ctx.reply(
        `<pre>${escapeHtml(cmd)}\n${escapeHtml(errMsg)}</pre>`,
        { parse_mode: "HTML" },
      );
    }
  }
}

async function safeDeleteMessage(ctx: Context): Promise<void> {
  try {
    await ctx.deleteMessage();
  } catch (e) {
    logger.debug("Could not delete message (best-effort):", e);
  }
}
