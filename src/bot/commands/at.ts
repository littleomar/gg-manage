import type { Context } from "grammy";
import type { AtParser } from "../../modem/at-parser.ts";

export function atCommand(at: AtParser) {
  return async (ctx: Context) => {
    const text = ctx.message?.text ?? "";
    const cmd = text.replace(/^\/at\s*/i, "").trim();

    if (!cmd) {
      await ctx.reply("Usage: /at <AT command>\nExample: /at AT+CSQ");
      return;
    }

    try {
      const response = await at.execute(cmd, 15000);
      await ctx.reply(`<pre>${escapeHtml(cmd)}\n${escapeHtml(response || "OK")}</pre>`, { parse_mode: "HTML" });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`<pre>${escapeHtml(cmd)}\n${escapeHtml(errMsg)}</pre>`, { parse_mode: "HTML" });
    }
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
