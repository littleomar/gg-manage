import type { AccountRefreshResult, AccountSummary } from "../account/provider.ts";
import type { SimInfo } from "../modem/sim-info.ts";
import { escapeHtml } from "../utils/html.ts";

const SOURCE_LABELS: Record<AccountRefreshResult["source"], string> = {
  ussd: "USSD",
  dashboard: "Dashboard",
};

export function formatBalanceResponse(result: AccountRefreshResult): string {
  const lines = [
    "<b>Balance Response:</b>",
    escapeHtml(result.rawResponse),
  ];
  if (result.summary.deactivationDate) {
    lines.push(
      "",
      `<b>Next Deactivation:</b> ${result.summary.deactivationDate}`,
      `<b>Days Remaining:</b> ${result.summary.daysRemaining}`,
    );
  }
  return lines.join("\n");
}

export function formatAccountSummary(result: AccountRefreshResult): string {
  const { summary } = result;
  return [
    "<b>giffgaff Account</b>",
    `<b>Source:</b> ${SOURCE_LABELS[result.source]}`,
    `<b>Balance:</b> ${summary.lastBalance ?? "unknown"}`,
    `<b>Last Change:</b> ${summary.lastChangeDate ?? "unknown"}`,
    `<b>Deactivation Date:</b> ${summary.deactivationDate ?? "unknown"}`,
    `<b>Days Remaining:</b> ${summary.daysRemaining ?? "unknown"}`,
  ].join("\n");
}

export function formatAccountStatus(
  summary: AccountSummary,
  dataStatus: string,
): string {
  let urgency = "";
  if (summary.daysRemaining !== null) {
    if (summary.daysRemaining <= 14) urgency = " ⚠️ URGENT";
    else if (summary.daysRemaining <= 30) urgency = " ⚠️";
  }

  return [
    "<b>giffgaff Account Status</b>",
    "",
    `<b>Last Balance:</b> ${summary.lastBalance}`,
    `<b>Last Change:</b> ${summary.lastChangeDate}`,
    `<b>Deactivation Date:</b> ${summary.deactivationDate}${urgency}`,
    `<b>Days Remaining:</b> ${summary.daysRemaining}`,
    "",
    `<b>Mobile Data:</b> ${dataStatus}`,
  ].join("\n");
}

export function formatSimInfo(info: SimInfo): string {
  return [
    "<b>SIM Information</b>",
    "",
    `<b>ICCID:</b> <code>${info.iccid}</code>`,
    `<b>IMSI:</b> <code>${info.imsi}</code>`,
    `<b>Operator:</b> ${info.operator}`,
    `<b>Registration:</b> ${info.registration}`,
    `<b>Signal:</b> ${info.signalStrength.percent}% (${info.signalStrength.dbm} dBm, RSSI: ${info.signalStrength.rssi})`,
  ].join("\n");
}

export function formatHelpMenu(): string {
  return [
    "<b>Available Commands</b>",
    "",
    "/balance — Check giffgaff balance via USSD",
    "/account — Refresh account from giffgaff dashboard",
    "/accountcookie &lt;cookie&gt; — Set giffgaff dashboard cookie (or 'clear')",
    "/keepalive — Run minimal data traffic to keep SIM active",
    "/status — Account status &amp; deactivation date",
    "/info — SIM &amp; network info",
    "/dataon — Enable mobile data",
    "/dataoff — Disable mobile data",
    "/at &lt;cmd&gt; — Send raw AT command",
    "/help — Show this help",
  ].join("\n");
}
