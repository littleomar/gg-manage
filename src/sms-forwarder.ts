import type { Bot } from "grammy";
import type { AtParser } from "./modem/at-parser.ts";
import { readSms, listUnreadSms, deleteSms } from "./modem/sms.ts";
import { sendMessage } from "./bot/bot.ts";
import { formatTime } from "./utils/time.ts";
import { createLogger } from "./utils/logger.ts";

const log = createLogger("sms-fwd");

export class SmsForwarder {
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private at: AtParser,
    private bot: Bot,
    private chatId: number,
    private pollIntervalMs: number
  ) {}

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

    // Polling fallback
    this.pollTimer = setInterval(() => this.pollUnread(), this.pollIntervalMs);
    log.info(`SMS forwarder started (poll interval: ${this.pollIntervalMs}ms)`);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async handleNewSms(index: number): Promise<void> {
    try {
      const sms = await readSms(this.at, index);
      if (!sms) return;

      await this.forwardSms(sms.sender, sms.timestamp, sms.body);
      await deleteSms(this.at, index);
    } catch (e) {
      log.error(`Failed to handle SMS ${index}:`, e);
    }
  }

  private async pollUnread(): Promise<void> {
    try {
      const messages = await listUnreadSms(this.at);
      if (messages.length === 0) return;

      log.info(`Polling found ${messages.length} unread SMS`);
      for (const sms of messages) {
        await this.forwardSms(sms.sender, sms.timestamp, sms.body);
        await deleteSms(this.at, sms.index);
      }
    } catch (e) {
      log.error("SMS poll error:", e);
    }
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
