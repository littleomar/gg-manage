import type { Context } from "grammy";
import type { BalanceTracker } from "../../balance-tracker.ts";
import { getDataStatus } from "../../modem/network.ts";
import type { AtParser } from "../../modem/at-parser.ts";

export function statusCommand(at: AtParser, tracker: BalanceTracker) {
  return async (ctx: Context) => {
    try {
      const [status, dataStatus] = await Promise.all([
        tracker.getStatus(),
        getDataStatus(at),
      ]);

      if (!status.lastChangeDate) {
        await ctx.reply(
          "No balance change recorded yet.\nUse /balance to check your balance first."
        );
        return;
      }

      let urgency = "";
      if (status.daysRemaining !== null) {
        if (status.daysRemaining <= 14) urgency = " ⚠️ URGENT";
        else if (status.daysRemaining <= 30) urgency = " ⚠️";
      }

      const msg = [
        "<b>giffgaff Account Status</b>",
        "",
        `<b>Last Balance:</b> ${status.lastBalance}`,
        `<b>Last Change:</b> ${status.lastChangeDate}`,
        `<b>Deactivation Date:</b> ${status.deactivationDate}${urgency}`,
        `<b>Days Remaining:</b> ${status.daysRemaining}`,
        "",
        `<b>Mobile Data:</b> ${dataStatus}`,
      ].join("\n");

      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Failed to get status: ${errMsg}`);
    }
  };
}
