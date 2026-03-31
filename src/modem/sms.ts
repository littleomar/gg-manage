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

function parseSmsResponse(resp: string, index: number): SmsMessage | null {
  // +CMGR: "REC UNREAD","+447xxx","","26/03/31,14:00:00+32"
  // Message body on next line(s)
  const lines = resp.split("\n");
  const headerLine = lines.find((l) => l.startsWith("+CMGR:"));
  if (!headerLine) return null;

  const match = headerLine.match(/\+CMGR:\s*"[^"]*","([^"]*)","[^"]*","([^"]*)"/);
  const sender = match?.[1] ?? "Unknown";
  const timestamp = match?.[2] ?? "";

  const headerIdx = lines.indexOf(headerLine);
  const body = lines
    .slice(headerIdx + 1)
    .join("\n")
    .trim();

  return { index, sender, timestamp, body };
}

function parseSmsList(resp: string): SmsMessage[] {
  const messages: SmsMessage[] = [];
  const lines = resp.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.startsWith("+CMGL:")) continue;

    const match = line.match(/\+CMGL:\s*(\d+),"[^"]*","([^"]*)","[^"]*","([^"]*)"/);
    if (!match) continue;

    const index = parseInt(match[1]!);
    const sender = match[2] ?? "Unknown";
    const timestamp = match[3] ?? "";

    const bodyLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.startsWith("+CMGL:")) break;
      bodyLines.push(lines[j]!);
    }

    messages.push({ index, sender, timestamp, body: bodyLines.join("\n").trim() });
  }

  return messages;
}
