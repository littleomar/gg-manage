import type { AtParser } from "./at-parser.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("ussd");

export async function sendUssd(at: AtParser, code: string, timeoutMs = 30000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`USSD timed out for code: ${code}`));
    }, timeoutMs);

    const handler = (line: string) => {
      if (!line.startsWith("+CUSD:")) return;

      clearTimeout(timer);
      cleanup();

      // +CUSD: 0,"Your balance is £5.00",15
      const match = line.match(/\+CUSD:\s*\d+,"([^"]*)"(?:,\d+)?/);
      if (match?.[1]) {
        resolve(decodeUssdResponse(match[1]));
      } else {
        resolve(line);
      }
    };

    const cleanup = () => {
      const idx = (at as any).urcHandlers?.indexOf(handler);
      if (idx !== undefined && idx >= 0) {
        (at as any).urcHandlers.splice(idx, 1);
      }
    };

    at.onUnsolicited(handler);

    at.execute(`AT+CUSD=1,"${code}",15`).catch((e) => {
      clearTimeout(timer);
      cleanup();
      reject(e);
    });
  });
}

function decodeUssdResponse(text: string): string {
  // Handle GSM 7-bit hex encoding if present
  if (/^[0-9A-Fa-f]+$/.test(text) && text.length > 20) {
    try {
      const bytes: number[] = [];
      for (let i = 0; i < text.length; i += 2) {
        bytes.push(parseInt(text.substring(i, i + 2), 16));
      }
      return String.fromCharCode(...bytes);
    } catch {
      return text;
    }
  }
  return text;
}
