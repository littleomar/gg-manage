import type { Bot } from "grammy";
import type { AtParser } from "./modem/at-parser.ts";
import {
  readSms,
  listAllSms,
  deleteSms,
  getStorageInfo,
  type SmsMessage,
} from "./modem/sms.ts";
import { sendMessage } from "./bot/bot.ts";
import { escapeHtml } from "./utils/html.ts";
import { formatTime } from "./utils/time.ts";
import { createLogger } from "./utils/logger.ts";

const log = createLogger("sms-fwd");

export type SmsInterceptor = (sms: {
  sender: string;
  timestamp: string;
  body: string;
}) => boolean;

export class SmsForwarder {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private interceptors: SmsInterceptor[] = [];

  constructor(
    private at: AtParser,
    private bot: Bot,
    private chatId: number,
    private pollIntervalMs: number
  ) {}

  addInterceptor(fn: SmsInterceptor): void {
    this.interceptors.push(fn);
  }

  start(): void {
    // Listen for +CMTI URC (real-time new SMS notification)
    this.at.onUnsolicited((line) => {
      if (!line.startsWith("+CMTI:")) return;

      // +CMTI: "ME",3
      const match = line.match(/\+CMTI:\s*"[^"]*",(\d+)/);
      if (match?.[1]) {
        const index = parseInt(match[1]);
        log.info(`New SMS notification, index: ${index}`);
        this.handleNewSms(index);
      }
    });

    // Initial sweep: drain any messages stuck in storage from a previous run
    this.sweep().catch((e) => log.error("Initial SMS sweep failed:", e));

    // Polling fallback / straggler sweep
    this.pollTimer = setInterval(() => this.sweep(), this.pollIntervalMs);
    log.info(`SMS forwarder started (poll interval: ${this.pollIntervalMs}ms)`);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async handleNewSms(index: number): Promise<void> {
    let sms: SmsMessage | null = null;
    try {
      sms = await readSms(this.at, index);
      if (!sms) {
        log.warn(`SMS ${index} could not be read/parsed; deleting to free storage`);
        return;
      }

      if (this.runInterceptors(sms)) {
        log.info(`SMS ${index} claimed by interceptor; skipping forward`);
      } else {
        await this.forwardSms(sms.sender, sms.timestamp, sms.body);
      }
    } catch (e) {
      log.error(`Failed to handle SMS ${index}:`, e);
    } finally {
      // Always free the storage slot, even on parse/forward failure —
      // otherwise the modem fills up and stops accepting new SMS.
      await deleteSms(this.at, index);
    }
  }

  private async sweep(): Promise<void> {
    try {
      const storage = await getStorageInfo(this.at);
      if (storage) {
        log.debug(`SMS storage: ${storage.used}/${storage.total}`);
        if (storage.used >= storage.total) {
          log.warn(`SMS storage FULL (${storage.used}/${storage.total}) — new SMS will be rejected by network until drained`);
        }
      }

      const messages = await listAllSms(this.at);
      if (messages.length === 0) return;

      const unread = messages.filter((m) => m.status === "REC UNREAD");
      const stragglers = messages.filter((m) => m.status !== "REC UNREAD");

      if (unread.length > 0) log.info(`Sweep found ${unread.length} unread SMS`);
      if (stragglers.length > 0) log.warn(`Sweep found ${stragglers.length} stale SMS (already read but not deleted) — clearing`);

      for (const sms of unread) {
        try {
          if (this.runInterceptors(sms)) {
            log.info(`SMS ${sms.index} claimed by interceptor; skipping forward`);
          } else {
            await this.forwardSms(sms.sender, sms.timestamp, sms.body);
          }
        } catch (e) {
          log.error(`Failed to process SMS ${sms.index}:`, e);
        } finally {
          await deleteSms(this.at, sms.index);
        }
      }

      for (const sms of stragglers) {
        await deleteSms(this.at, sms.index);
      }
    } catch (e) {
      log.error("SMS sweep error:", e);
    }
  }

  private runInterceptors(sms: {
    sender: string;
    timestamp: string;
    body: string;
  }): boolean {
    for (const fn of this.interceptors) {
      try {
        if (fn(sms)) return true;
      } catch (e) {
        log.error("SMS interceptor threw:", e);
      }
    }
    return false;
  }

  private async forwardSms(sender: string, timestamp: string, body: string): Promise<void> {
    const now = formatTime(new Date());
    const msg = [
      `<b>📩 New SMS</b>`,
      `<b>From:</b> <code>${escapeHtml(sender)}</code>`,
      `<b>Time:</b> ${escapeHtml(timestamp || now)}`,
      "",
      escapeHtml(body),
    ].join("\n");

    await sendMessage(this.bot, this.chatId, msg);
    log.info(`Forwarded SMS from ${sender}`);
  }
}
