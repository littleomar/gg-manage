export interface AccountSummary {
  lastBalance: string | null;
  lastChangeDate: string | null;
  deactivationDate: string | null;
  daysRemaining: number | null;
}

export type AccountSource = "ussd" | "dashboard";

export interface AccountRefreshResult {
  source: AccountSource;
  rawResponse: string;
  parsedBalance: string | null;
  summary: AccountSummary;
}

export interface AccountProvider {
  getStatus(): Promise<AccountSummary>;
  refreshViaUssd(): Promise<AccountRefreshResult>;
  refreshViaDashboard(): Promise<AccountRefreshResult>;
}
