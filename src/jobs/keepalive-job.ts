import type { AtParser } from "../modem/at-parser.ts";
import { disableData, enableData } from "../modem/network.ts";
import type { AlertsLog } from "../alerts.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("keepalive");

export interface KeepaliveJobOptions {
  at: AtParser;
  fetch: typeof fetch;
  alerts: AlertsLog;
  keepaliveUrl: string;
  timeoutMs: number;
}

export type KeepaliveResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export class KeepaliveJob {
  #running = false;
  readonly #at: AtParser;
  readonly #fetch: typeof fetch;
  readonly #alerts: AlertsLog;
  readonly #keepaliveUrl: string;
  readonly #timeoutMs: number;

  constructor(options: KeepaliveJobOptions) {
    this.#at = options.at;
    this.#fetch = options.fetch;
    this.#alerts = options.alerts;
    this.#keepaliveUrl = options.keepaliveUrl;
    this.#timeoutMs = options.timeoutMs;
  }

  async run(): Promise<KeepaliveResult> {
    if (this.#running) {
      log.warn("Keepalive skipped: another run is in progress.");
      return {
        ok: false,
        message: "Keepalive already running, try again shortly.",
      };
    }

    this.#running = true;
    log.info("Keepalive started.", {
      keepaliveUrl: this.#keepaliveUrl,
      timeoutMs: this.#timeoutMs,
    });

    try {
      await enableData(this.#at);
      const t0 = Date.now();
      const res = await this.#fetch(this.#keepaliveUrl, {
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      const text = await res.text();
      const elapsed = Date.now() - t0;
      log.info("Keepalive HTTP completed.", {
        status: res.status,
        bytes: text.length,
        elapsed,
      });
      return {
        ok: true,
        message: `Keepalive HTTP ${res.status} (${text.length} bytes, ${elapsed}ms)`,
      };
    } catch (e) {
      const details = e instanceof Error ? e.message : String(e);
      log.error("Keepalive failed.", e);
      await this.#alerts.insertAlert(
        "error",
        "keepalive_failed",
        "Keepalive run failed.",
        { error: details, keepaliveUrl: this.#keepaliveUrl },
      );
      return { ok: false, message: `Keepalive failed: ${details}` };
    } finally {
      try {
        await disableData(this.#at);
      } catch (e) {
        log.warn("Failed to disable data after keepalive:", e);
      }
      this.#running = false;
    }
  }
}
