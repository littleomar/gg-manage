import { Bot } from "grammy";
import type { Config } from "../config.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("bot");

export function createBot(config: Config): Bot {
  if (config.telegramProxyUrl) {
    const url = config.telegramProxyUrl;
    log.info(`Using proxy: ${url}`);
    // Bun's fetch respects HTTP_PROXY/HTTPS_PROXY environment variables
    process.env.HTTPS_PROXY = url;
    process.env.HTTP_PROXY = url;
  }

  return new Bot(config.telegramBotToken);
}

export async function sendMessage(bot: Bot, chatId: number, text: string): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (e) {
    log.error("Failed to send message:", e);
  }
}
