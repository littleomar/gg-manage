import type { AtParser } from "./at-parser.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("sms");

export interface SmsMessage {
  index: number;
  sender: string;
  timestamp: string;
  body: string;
}

export async function initSms(at: AtParser): Promise<void> {
  await at.execute("AT+CMGF=1"); // Text mode
  await at.execute('AT+CPMS="ME","ME","ME"'); // Use modem storage
  await at.execute("AT+CNMI=2,1,0,0,0"); // Enable +CMTI URC for new SMS
  log.info("SMS initialized (text mode, URC enabled)");
}

export async function readSms(at: AtParser, index: number): Promise<SmsMessage | null> {
  try {
    const resp = await at.execute(`AT+CMGR=${index}`);
    return parseSmsResponse(resp, index);
  } catch (e) {
    log.error(`Failed to read SMS ${index}:`, e);
    return null;
  }
}

export async function listUnreadSms(at: AtParser): Promise<SmsMessage[]> {
  try {
    const resp = await at.execute('AT+CMGL="REC UNREAD"');
    if (!resp.trim()) return [];
    return parseSmsList(resp);
  } catch {
    return [];
  }
}

export async function deleteSms(at: AtParser, index: number): Promise<void> {
  try {
    await at.execute(`AT+CMGD=${index}`);
    log.debug(`Deleted SMS ${index}`);
  } catch (e) {
    log.error(`Failed to delete SMS ${index}:`, e);
  }
}

export async function deleteAllSms(at: AtParser): Promise<void> {
  try {
    await at.execute("AT+CMGD=1,4"); // Delete all messages
    log.info("Deleted all SMS");
  } catch (e) {
    log.error("Failed to delete all SMS:", e);
  }
}

/** Decode UCS2 hex string (e.g. "00480065006C006C006F") to text */
function decodeUcs2Hex(hex: string): string {
  // Check if it looks like UCS2 hex (even length, all hex chars)
  if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length % 4 !== 0) {
    return hex; // Return as-is if not UCS2 hex
  }
  let result = "";
  for (let i = 0; i < hex.length; i += 4) {
    result += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  }
  return result;
}

/** Try to decode a field that might be UCS2 hex or plain text */
function decodeField(value: string): string {
  if (!value) return value;
  const decoded = decodeUcs2Hex(value);
  // If decoding produced readable text, use it
  return decoded;
}

function parseSmsResponse(resp: string, index: number): SmsMessage | null {
  // +CMGR: "REC UNREAD","+447xxx","","26/03/31,14:00:00+32"
  // +CMGR: "REC UNREAD","00670069006600660067006100660066",,"26/04/01,02:48:18+4"
  const lines = resp.split("\n");
  const headerLine = lines.find((l) => l.startsWith("+CMGR:"));
  if (!headerLine) return null;

  const match = headerLine.match(/\+CMGR:\s*"[^"]*",\s*"([^"]*)"(?:,\s*"[^"]*")?,\s*"?([^"]*)"?/);
  const sender = decodeField(match?.[1] ?? "Unknown");
  const timestamp = match?.[2] ?? "";

  const headerIdx = lines.indexOf(headerLine);
  const rawBody = lines
    .slice(headerIdx + 1)
    .join("\n")
    .trim();

  return { index, sender, timestamp, body: decodeField(rawBody) };
}

function parseSmsList(resp: string): SmsMessage[] {
  const messages: SmsMessage[] = [];
  const lines = resp.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("+CMGL:")) continue;

    // Handle various formats:
    // +CMGL: 1,"REC UNREAD","+447xxx","","26/03/31,14:00:00+32"
    // +CMGL: 1,"REC UNREAD","00670069006600660067006100660066",,"26/04/01,02:48:18+4"
    const match = line.match(/\+CMGL:\s*(\d+),\s*"[^"]*",\s*"([^"]*)"(?:,\s*"[^"]*")?,\s*"?([^"]*)"?/);
    if (!match) {
      log.warn(`Failed to parse CMGL line: ${line}`);
      continue;
    }

    const index = parseInt(match[1]!);
    const sender = decodeField(match[2] ?? "Unknown");
    const timestamp = match[3] ?? "";

    const bodyLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.startsWith("+CMGL:")) break;
      bodyLines.push(lines[j]!);
    }

    const rawBody = bodyLines.join("\n").trim();
    messages.push({ index, sender, timestamp, body: decodeField(rawBody) });
  }

  return messages;
}
