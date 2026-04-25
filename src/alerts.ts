import { dataPath } from "./storage.ts";
import { createLogger } from "./utils/logger.ts";

const log = createLogger("alerts");
const ALERTS_FILE = "alerts.jsonl";

export type AlertLevel = "info" | "warn" | "error";

export interface AlertEntry {
  ts: string;
  level: AlertLevel;
  code: string;
  message: string;
  payload?: Record<string, unknown>;
}

export class AlertsLog {
  #filePath: string;

  constructor(dataDir: string) {
    this.#filePath = dataPath(dataDir, ALERTS_FILE);
  }

  async insertAlert(
    level: AlertLevel,
    code: string,
    message: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const entry: AlertEntry = {
      ts: new Date().toISOString(),
      level,
      code,
      message,
      ...(payload ? { payload } : {}),
    };

    try {
      const existing = await Bun.file(this.#filePath).exists();
      const line = `${JSON.stringify(entry)}\n`;
      if (existing) {
        const current = await Bun.file(this.#filePath).text();
        await Bun.write(this.#filePath, current + line);
      } else {
        await Bun.write(this.#filePath, line);
      }
    } catch (e) {
      log.error(`Failed to append alert ${code}:`, e);
    }
  }
}
