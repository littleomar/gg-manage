import type { Context } from "grammy";
import type { AtParser } from "../../modem/at-parser.ts";
import { getSimInfo } from "../../modem/sim-info.ts";

export function infoCommand(at: AtParser) {
  return async (ctx: Context) => {
    try {
      const info = await getSimInfo(at);

      const msg = [
        "<b>SIM Information</b>",
        "",
        `<b>ICCID:</b> <code>${info.iccid}</code>`,
        `<b>IMSI:</b> <code>${info.imsi}</code>`,
        `<b>Operator:</b> ${info.operator}`,
        `<b>Registration:</b> ${info.registration}`,
        `<b>Signal:</b> ${info.signalStrength.percent}% (${info.signalStrength.dbm} dBm, RSSI: ${info.signalStrength.rssi})`,
      ].join("\n");

      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await ctx.reply(`Failed to get SIM info: ${errMsg}`);
    }
  };
}
