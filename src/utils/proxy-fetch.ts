import { createLogger } from "./logger.ts";

const log = createLogger("proxy-fetch");

export function createProxyFetch(proxyUrl: string | undefined): typeof fetch {
  if (!proxyUrl) {
    return globalThis.fetch;
  }

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
