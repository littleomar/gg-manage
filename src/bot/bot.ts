import { Bot } from "grammy";
import { SocksProxyAgent } from "socks-proxy-agent";
import * as https from "node:https";
import type { Config } from "../config.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("bot");

function createSocksFetch(proxyUrl: string): typeof fetch {
  const agent = new SocksProxyAgent(proxyUrl);

  return (input, init?) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers = init?.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init?.headers as Record<string, string>) ?? {};

    return new Promise<Response>((resolve, reject) => {
      const req = https.request(url, { method, headers, agent }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve(
            new Response(body, {
              status: res.statusCode ?? 200,
              statusText: res.statusMessage ?? "",
              headers: res.headers as Record<string, string>,
            }),
          );
        });
        res.on("error", reject);
      });

      req.on("error", reject);

      if (init?.body) {
        if (init.body instanceof ReadableStream) {
          const reader = init.body.getReader();
          const pump = (): Promise<void> =>
            reader.read().then(({ done, value }) => {
              if (done) {
                req.end();
                return;
              }
              req.write(value);
              return pump();
            });
          pump().catch(reject);
        } else {
          req.write(init.body);
          req.end();
        }
      } else {
        req.end();
      }
    });
  };
}

export function createBot(config: Config): Bot {
  const isSocks = config.telegramProxyUrl?.startsWith("socks");

  if (config.telegramProxyUrl && !isSocks) {
    // HTTP proxy — Bun's fetch respects these env vars
    log.info(`Using HTTP proxy: ${config.telegramProxyUrl}`);
    process.env.HTTPS_PROXY = config.telegramProxyUrl;
    process.env.HTTP_PROXY = config.telegramProxyUrl;
    return new Bot(config.telegramBotToken);
  }

  if (config.telegramProxyUrl && isSocks) {
    log.info(`Using SOCKS proxy: ${config.telegramProxyUrl}`);
    return new Bot(config.telegramBotToken, {
      client: {
        fetch: createSocksFetch(config.telegramProxyUrl),
      },
    });
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
