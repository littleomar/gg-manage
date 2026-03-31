import type { AtParser } from "./at-parser.ts";

export interface SimInfo {
  iccid: string;
  imsi: string;
  signalStrength: { rssi: number; dbm: number; percent: number };
  registration: string;
  operator: string;
}

export async function getSimInfo(at: AtParser): Promise<SimInfo> {
  const [iccid, imsi, csq, creg, cops] = await Promise.all([
    getICCID(at),
    getIMSI(at),
    getSignalStrength(at),
    getRegistration(at),
    getOperator(at),
  ]);

  return { iccid, imsi, signalStrength: csq, registration: creg, operator: cops };
}

async function getICCID(at: AtParser): Promise<string> {
  const resp = await at.execute("AT+QCCID");
  // Response: +QCCID: 8944...
  const match = resp.match(/\+QCCID:\s*(\S+)/);
  return match?.[1] ?? resp.trim();
}

async function getIMSI(at: AtParser): Promise<string> {
  const resp = await at.execute("AT+CIMI");
  return resp.trim();
}

async function getSignalStrength(at: AtParser): Promise<{ rssi: number; dbm: number; percent: number }> {
  const resp = await at.execute("AT+CSQ");
  // Response: +CSQ: 18,99
  const match = resp.match(/\+CSQ:\s*(\d+),/);
  const rssi = match ? parseInt(match[1]!) : 99;
  const dbm = rssi === 99 ? -999 : -113 + 2 * rssi;
  const percent = rssi === 99 ? 0 : Math.round((rssi / 31) * 100);
  return { rssi, dbm, percent };
}

async function getRegistration(at: AtParser): Promise<string> {
  const resp = await at.execute("AT+CREG?");
  // Response: +CREG: 0,1
  const match = resp.match(/\+CREG:\s*\d+,(\d+)/);
  const statMap: Record<string, string> = {
    "0": "Not registered",
    "1": "Registered (home)",
    "2": "Searching...",
    "3": "Registration denied",
    "5": "Registered (roaming)",
  };
  return match?.[1] ? (statMap[match[1]] ?? `Unknown (${match[1]})`) : resp.trim();
}

async function getOperator(at: AtParser): Promise<string> {
  const resp = await at.execute("AT+COPS?");
  // Response: +COPS: 0,0,"giffgaff",7
  const match = resp.match(/\+COPS:\s*\d+,\d+,"([^"]+)"/);
  return match?.[1] ?? "Unknown";
}
