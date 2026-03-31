import type { AtParser } from "./at-parser.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("network");

export async function enableData(at: AtParser): Promise<string> {
  try {
    await at.execute("AT+CGATT=1");
    await at.execute("AT+CGACT=1,1");
    log.info("Mobile data enabled");
    return "Mobile data enabled";
  } catch (e) {
    const msg = `Failed to enable data: ${e instanceof Error ? e.message : e}`;
    log.error(msg);
    return msg;
  }
}

export async function disableData(at: AtParser): Promise<string> {
  try {
    await at.execute("AT+CGACT=0,1");
    await at.execute("AT+CGATT=0");
    log.info("Mobile data disabled");
    return "Mobile data disabled";
  } catch (e) {
    const msg = `Failed to disable data: ${e instanceof Error ? e.message : e}`;
    log.error(msg);
    return msg;
  }
}

export async function getDataStatus(at: AtParser): Promise<string> {
  try {
    const resp = await at.execute("AT+CGATT?");
    const match = resp.match(/\+CGATT:\s*(\d)/);
    return match?.[1] === "1" ? "Attached" : "Detached";
  } catch {
    return "Unknown";
  }
}
