import { Bot } from "grammy";
import type { Config } from "../config.ts";
import { createLogger } from "../utils/logger.ts";
import { createProxyFetch } from "../utils/proxy-fetch.ts";

const log = createLogger("bot");

export function createBot(config: Config): Bot {
	if (!config.telegramProxyUrl) {
		return new Bot(config.telegramBotToken);
	}

	const customFetch = createProxyFetch(config.telegramProxyUrl);

	return new Bot(config.telegramBotToken, {
		client: { fetch: customFetch },
	});
}

export async function sendMessage(
	bot: Bot,
	chatId: number,
	text: string,
): Promise<void> {
	try {
		await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
	} catch (e) {
		log.error("Failed to send message:", e);
	}
}
