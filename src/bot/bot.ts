import { Bot } from "grammy";
import type { Config } from "../config.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("bot");

function createProxyFetch(proxyUrl: string): typeof fetch {
	log.info(`HTTP proxy configured: ${proxyUrl}`);
	return (async (input, init) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		const method = init?.method ?? "GET";
		const t0 = Date.now();
		log.info(`→ ${method} ${url} via proxy`);
		try {
			const res = await fetch(input, {
				...init,
				proxy: proxyUrl,
			} as unknown as RequestInit);
			log.info(`← ${res.status} ${url} (${Date.now() - t0}ms)`);
			return res;
		} catch (e) {
			log.error(`✗ Proxy fetch failed for ${url} (${Date.now() - t0}ms):`, e);
			throw e;
		}
	}) as typeof fetch;
}

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
