import { readJson, writeJson, dataPath } from "./storage.ts";
import { formatTime, addDays, diffDays } from "./utils/time.ts";
import { createLogger } from "./utils/logger.ts";

const log = createLogger("balance");

const DEACTIVATION_DAYS = 180;
const BALANCE_FILE = "balance.json";

interface BalanceRecord {
  date: string;
  balance: string;
}

interface BalanceData {
  lastBalanceChange: string;
  lastBalance: string;
  history: BalanceRecord[];
}

export class BalanceTracker {
  private filePath: string;

  constructor(dataDir: string) {
    this.filePath = dataPath(dataDir, BALANCE_FILE);
  }

  async recordBalanceChange(balance: string): Promise<void> {
    const data = await this.load();
    const now = new Date().toISOString();

    if (data.lastBalance === balance) {
      log.debug("Balance unchanged, skipping record");
      return;
    }

    data.lastBalanceChange = now;
    data.lastBalance = balance;
    data.history.unshift({ date: now, balance });

    // Keep last 50 records
    if (data.history.length > 50) {
      data.history = data.history.slice(0, 50);
    }

    await writeJson(this.filePath, data);
    log.info(`Balance changed to ${balance}`);
  }

  async getStatus(): Promise<{
    lastBalance: string | null;
    lastChangeDate: string | null;
    deactivationDate: string | null;
    daysRemaining: number | null;
  }> {
    const data = await this.load();

    if (!data.lastBalanceChange) {
      return { lastBalance: null, lastChangeDate: null, deactivationDate: null, daysRemaining: null };
    }

    const deactivationDate = addDays(data.lastBalanceChange, DEACTIVATION_DAYS);

    return {
      lastBalance: data.lastBalance,
      lastChangeDate: formatTime(data.lastBalanceChange),
      deactivationDate: formatTime(deactivationDate.toDate()),
      daysRemaining: diffDays(deactivationDate.toDate()),
    };
  }

  private async load(): Promise<BalanceData> {
    const data = await readJson<BalanceData>(this.filePath);
    return data ?? { lastBalanceChange: "", lastBalance: "", history: [] };
  }
}
