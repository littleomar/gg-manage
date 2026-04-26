import type { AtParser } from "../modem/at-parser.ts";
import { sendUssd } from "../modem/ussd.ts";
import type { BalanceTracker } from "../balance-tracker.ts";
import { createLogger } from "../utils/logger.ts";
import {
  extractAirtimeCreditFromDashboard,
  parseGiffgaffBalance,
} from "./parser.ts";
import type { AccountCookieStore } from "./cookie-store.ts";
import type { GiffgaffLoginService } from "./giffgaff-login-service.ts";
import type {
  AccountProvider,
  AccountRefreshResult,
  AccountSummary,
} from "./provider.ts";

const GIFFGAFF_BALANCE_USSD = "*100#";
const DEFAULT_DASHBOARD_URL = "https://www.giffgaff.com/dashboard";
const DEFAULT_ACCEPT_LANGUAGE = "en-GB,en;q=0.9";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";
const DEFAULT_DASHBOARD_TIMEOUT_MS = 15_000;

const log = createLogger("account.giffgaff");

export interface GiffgaffAccountProviderOptions {
  at: AtParser;
  tracker: BalanceTracker;
  cookieStore: AccountCookieStore;
  fetch?: typeof fetch;
  dashboardUrl?: string;
  acceptLanguage?: string;
  userAgent?: string;
  dashboardTimeoutMs?: number;
  loginService?: GiffgaffLoginService;
}

export class GiffgaffAccountProvider implements AccountProvider {
  readonly #at: AtParser;
  readonly #tracker: BalanceTracker;
  readonly #cookieStore: AccountCookieStore;
  readonly #fetch: typeof fetch;
  readonly #dashboardUrl: string;
  readonly #acceptLanguage: string;
  readonly #userAgent: string;
  readonly #dashboardTimeoutMs: number;
  readonly #loginService?: GiffgaffLoginService;

  constructor(options: GiffgaffAccountProviderOptions) {
    this.#at = options.at;
    this.#tracker = options.tracker;
    this.#cookieStore = options.cookieStore;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#dashboardUrl = options.dashboardUrl ?? DEFAULT_DASHBOARD_URL;
    this.#acceptLanguage = options.acceptLanguage ?? DEFAULT_ACCEPT_LANGUAGE;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#dashboardTimeoutMs =
      options.dashboardTimeoutMs ?? DEFAULT_DASHBOARD_TIMEOUT_MS;
    this.#loginService = options.loginService;
  }

  async getStatus(): Promise<AccountSummary> {
    return this.#tracker.getStatus();
  }

  async refreshViaUssd(): Promise<AccountRefreshResult> {
    log.info(`Querying balance via USSD ${GIFFGAFF_BALANCE_USSD}`);
    const rawResponse = await sendUssd(this.#at, GIFFGAFF_BALANCE_USSD);
    const parsedBalance = parseGiffgaffBalance(rawResponse);
    if (parsedBalance) {
      await this.#tracker.recordBalanceChange(parsedBalance);
    } else {
      log.warn(`Could not parse balance from USSD response: ${rawResponse}`);
    }
    const summary = await this.#tracker.getStatus();
    return { source: "ussd", rawResponse, parsedBalance, summary };
  }

  async refreshViaDashboard(): Promise<AccountRefreshResult> {
    let cookie = await this.#cookieStore.get();

    if (!cookie) {
      cookie = await this.#tryAutoLogin(
        "no cookie stored",
      );
    }

    if (!cookie) {
      throw new Error(
        "Dashboard cookie is not configured. Set GG_USERNAME/GG_PASSWORD for auto-login or use /accountcookie <cookie>.",
      );
    }

    let attempt = await this.#fetchAndParseDashboard(cookie);

    if (!attempt.parsedBalance) {
      const fresh = await this.#tryAutoLogin(
        attempt.failureReason ?? "dashboard parse failed",
      );
      if (fresh) {
        attempt = await this.#fetchAndParseDashboard(fresh);
      }
    }

    if (!attempt.parsedBalance) {
      throw new Error(
        attempt.failureReason ??
          "Could not find the dashboard credit balance. The cookie may be expired or the page structure changed.",
      );
    }

    await this.#tracker.recordBalanceChange(attempt.parsedBalance);
    const summary = await this.#tracker.getStatus();
    return {
      source: "dashboard",
      rawResponse: attempt.responseUrl,
      parsedBalance: attempt.parsedBalance,
      summary,
    };
  }

  async #fetchAndParseDashboard(cookie: string): Promise<{
    parsedBalance: string | null;
    responseUrl: string;
    failureReason?: string;
  }> {
    log.info(`Refreshing dashboard at ${this.#dashboardUrl}`);
    const response = await this.#fetch(this.#dashboardUrl, {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": this.#acceptLanguage,
        "Cache-Control": "no-cache",
        Cookie: cookie,
        Pragma: "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "User-Agent": this.#userAgent,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(this.#dashboardTimeoutMs),
    });
    const responseUrl = response.url || this.#dashboardUrl;

    if (!response.ok) {
      return {
        parsedBalance: null,
        responseUrl,
        failureReason: `Dashboard request failed: HTTP ${response.status}.`,
      };
    }

    const html = await response.text();
    const parsedBalance = extractAirtimeCreditFromDashboard(html);
    return {
      parsedBalance,
      responseUrl,
      failureReason: parsedBalance
        ? undefined
        : "Could not find dashboard balance (cookie likely expired).",
    };
  }

  async #tryAutoLogin(reason: string): Promise<string | null> {
    if (!this.#loginService) {
      return null;
    }
    log.info(`Attempting auto-login (${reason}).`);
    try {
      const cookie = await this.#loginService.login();
      await this.#cookieStore.set(cookie);
      log.info("Auto-login succeeded; cookie stored.");
      return cookie;
    } catch (e) {
      log.warn("Auto-login failed:", e);
      return null;
    }
  }
}
