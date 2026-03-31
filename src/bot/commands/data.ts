import type { Context } from "grammy";
import type { AtParser } from "../../modem/at-parser.ts";
import { enableData, disableData, getDataStatus } from "../../modem/network.ts";

export function dataOnCommand(at: AtParser) {
  return async (ctx: Context) => {
    const result = await enableData(at);
    const status = await getDataStatus(at);
    await ctx.reply(`${result}\nCurrent status: ${status}`);
  };
}

export function dataOffCommand(at: AtParser) {
  return async (ctx: Context) => {
    const result = await disableData(at);
    const status = await getDataStatus(at);
    await ctx.reply(`${result}\nCurrent status: ${status}`);
  };
}
