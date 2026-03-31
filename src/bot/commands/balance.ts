import type { Context } from "grammy";
import type { AtParser } from "../../modem/at-parser.ts";
import { sendUssd } from "../../modem/ussd.ts";
import type { BalanceTracker } from "../../balance-tracker.ts";

export function balanceCommand(at: AtParser, tracker: BalanceTracker) {
  return async (ctx: Context) => {
    await ctx.reply("Checking balance...");

    try {
      const response = await sendUssd(at, "*100#");

      // Try to extract balance amount
      const balanceMatch = response.match(/£[\d.]+/);
      if (balanceMatch) {
        await tracker.recordBalanceChange(balanceMatch[0]);
      }

      const status = await tracker.getStatus();
      let msg = `<b>Balance Response:</b>\n${escapeHtml(response)}`;

      if (status.deactivationDate) {
        msg += `\n\n<b>Next Deactivation:</b> ${status.deactivationDate}`;
        msg += `\n<b>Days Remaining:</b> ${status.daysRemaining}`;
      }

      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Failed to check balance: ${errMsg}`);
    }
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
