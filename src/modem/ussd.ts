import type { AtParser } from "./at-parser.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("ussd");

export async function sendUssd(at: AtParser, code: string, timeoutMs = 60000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`USSD timed out for code: ${code}`));
    }, timeoutMs);

    const handler = (line: string) => {
      if (!line.startsWith("+CUSD:")) return;

      log.debug(`USSD URC received: ${line}`);
      clearTimeout(timer);
      cleanup();

      // +CUSD: 0,"Your balance is £5.00",15
      // +CUSD: 0,"UCS2 hex encoded response",72
      const match = line.match(/\+CUSD:\s*\d+,\s*"([^"]*)"(?:,\s*(\d+))?/);
      if (match?.[1]) {
        const dcs = match[2] ? parseInt(match[2]) : 15;
        resolve(decodeUssdResponse(match[1], dcs));
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

    // Send without DCS parameter — let the modem use its default encoding
    at.execute(`AT+CUSD=1,"${code}"`).catch((e) => {
      clearTimeout(timer);
      cleanup();
      reject(e);
    });
  });
}

function decodeUssdResponse(text: string, dcs: number): string {
  // DCS 72 (0x48) = UCS2 encoding
  if (dcs === 72 || dcs === 0x48) {
    return decodeUcs2Hex(text);
  }

  // Check if it looks like UCS2 hex even without DCS hint (all hex, 4-char aligned)
  if (/^[0-9A-Fa-f]+$/.test(text) && text.length % 4 === 0 && text.length >= 8) {
    // Peek at first char — if it's a common UCS2 code point, decode as UCS2
    const first = parseInt(text.slice(0, 4), 16);
    if (first >= 0x20 && first <= 0xFFFF) {
      return decodeUcs2Hex(text);
    }
  }

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

function decodeUcs2Hex(hex: string): string {
  let result = "";
  for (let i = 0; i < hex.length; i += 4) {
    result += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  }
  return result;
}
