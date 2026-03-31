import type { SerialConnection } from "./serial.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("at-parser");

type UrcHandler = (line: string) => void;

interface PendingCommand {
  cmd: string;
  resolve: (response: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  lines: string[];
}

export class AtParser {
  private queue: PendingCommand[] = [];
  private current: PendingCommand | null = null;
  private urcHandlers: UrcHandler[] = [];
  private serial: SerialConnection;

  constructor(serial: SerialConnection) {
    this.serial = serial;
    serial.parser.on("data", (line: string) => this.onLine(line));
  }

  execute(cmd: string, timeoutMs = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
      const pending: PendingCommand = {
        cmd,
        resolve,
        reject,
        lines: [],
        timer: setTimeout(() => {
          if (this.current === pending) {
            this.current = null;
            reject(new Error(`AT command timed out: ${cmd}`));
            this.processNext();
          }
        }, timeoutMs),
      };

      this.queue.push(pending);
      if (!this.current) this.processNext();
    });
  }

  onUnsolicited(handler: UrcHandler): void {
    this.urcHandlers.push(handler);
  }

  private processNext(): void {
    if (this.current || this.queue.length === 0) return;

    this.current = this.queue.shift()!;
    log.debug(`>> ${this.current.cmd}`);
    this.serial.write(this.current.cmd);
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    log.debug(`<< ${trimmed}`);

    if (this.current) {
      // Skip echo of the command itself
      if (trimmed === this.current.cmd) return;

      if (trimmed === "OK" || trimmed.startsWith("ERROR") || trimmed.startsWith("+CME ERROR") || trimmed.startsWith("+CMS ERROR")) {
        clearTimeout(this.current.timer);
        const response = this.current.lines.join("\n");
        const isError = trimmed !== "OK";

        if (isError) {
          this.current.lines.push(trimmed);
          const errResponse = this.current.lines.join("\n");
          this.current.reject(new Error(errResponse));
        } else {
          this.current.resolve(response);
        }

        this.current = null;
        this.processNext();
        return;
      }

      // Check if this is a URC arriving during a command
      if (this.isUrc(trimmed)) {
        this.dispatchUrc(trimmed);
        return;
      }

      this.current.lines.push(trimmed);
    } else {
      // No active command — must be a URC
      this.dispatchUrc(trimmed);
    }
  }

  private isUrc(line: string): boolean {
    const urcPrefixes = ["+CMTI:", "+CMT:", "+CUSD:", "+CREG:", "+CGREG:", "+CEREG:"];
    return urcPrefixes.some((p) => line.startsWith(p));
  }

  private dispatchUrc(line: string): void {
    for (const handler of this.urcHandlers) {
      try {
        handler(line);
      } catch (e) {
        log.error("URC handler error:", e);
      }
    }
  }
}
