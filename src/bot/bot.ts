import { Bot } from "grammy";
import { SocksClient } from "socks";
import * as tls from "node:tls";
import * as net from "node:net";
import type { Config } from "../config.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("bot");

function parseSocksUrl(proxyUrl: string) {
  const url = new URL(proxyUrl);
  const type = url.protocol.startsWith("socks4") ? 4 : 5;
  return {
    host: url.hostname,
    port: parseInt(url.port) || 1080,
    type: type as 4 | 5,
    ...(url.username ? { userId: url.username } : {}),
    ...(url.password ? { password: url.password } : {}),
  };
}

function createSocksFetch(proxyUrl: string): typeof fetch {
  const proxy = parseSocksUrl(proxyUrl);

  return async (input, init?) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};

    if (init?.headers instanceof Headers) {
      init.headers.forEach((v, k) => (headers[k] = v));
    } else if (init?.headers) {
      Object.assign(headers, init.headers);
    }

    if (!headers["host"]) headers["host"] = url.host;

    // Establish SOCKS connection to target
    const { socket } = await SocksClient.createConnection({
      proxy,
      command: "connect",
      destination: {
        host: url.hostname,
        port: parseInt(url.port) || (url.protocol === "https:" ? 443 : 80),
      },
    });

    // Upgrade to TLS for HTTPS
    const tlsSocket = url.protocol === "https:"
      ? tls.connect({ socket, servername: url.hostname })
      : socket;

    if (tlsSocket !== socket) {
      await new Promise<void>((resolve, reject) => {
        (tlsSocket as tls.TLSSocket).once("secureConnect", resolve);
        (tlsSocket as tls.TLSSocket).once("error", reject);
      });
    }

    // Build raw HTTP request
    const path = url.pathname + url.search;
    let body: Buffer | null = null;
    if (init?.body) {
      if (typeof init.body === "string") {
        body = Buffer.from(init.body);
      } else if (init.body instanceof ArrayBuffer || init.body instanceof Uint8Array) {
        body = Buffer.from(init.body);
      } else if (init.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        body = Buffer.concat(chunks);
      } else {
        body = Buffer.from(String(init.body));
      }
    }

    if (body) headers["content-length"] = body.byteLength.toString();

    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");

    const requestHead = `${method} ${path} HTTP/1.1\r\n${headerLines}\r\n\r\n`;
    tlsSocket.write(requestHead);
    if (body) tlsSocket.write(body);

    // Read response
    return new Promise<Response>((resolve, reject) => {
      const chunks: Buffer[] = [];
      tlsSocket.on("data", (chunk: Buffer) => chunks.push(chunk));
      tlsSocket.on("error", reject);
      tlsSocket.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const headerEnd = raw.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          reject(new Error("Invalid HTTP response"));
          return;
        }

        const headerSection = raw.slice(0, headerEnd);
        const bodySection = raw.slice(headerEnd + 4);
        const [statusLine, ...headerParts] = headerSection.split("\r\n");
        const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)\s*(.*)/);
        const status = statusMatch ? parseInt(statusMatch[1]) : 200;
        const statusText = statusMatch?.[2] ?? "";

        const respHeaders: Record<string, string> = {};
        for (const h of headerParts) {
          const idx = h.indexOf(":");
          if (idx > 0) {
            respHeaders[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim();
          }
        }

        // Handle chunked transfer encoding
        let responseBody: string;
        if (respHeaders["transfer-encoding"]?.includes("chunked")) {
          responseBody = decodeChunked(bodySection);
        } else {
          responseBody = bodySection;
        }

        resolve(
          new Response(responseBody, { status, statusText, headers: respHeaders }),
        );
      });
    });
  };
}

function decodeChunked(data: string): string {
  const parts: string[] = [];
  let remaining = data;
  while (remaining.length > 0) {
    const lineEnd = remaining.indexOf("\r\n");
    if (lineEnd === -1) break;
    const size = parseInt(remaining.slice(0, lineEnd), 16);
    if (size === 0) break;
    parts.push(remaining.slice(lineEnd + 2, lineEnd + 2 + size));
    remaining = remaining.slice(lineEnd + 2 + size + 2);
  }
  return parts.join("");
}

function createHttpProxyFetch(proxyUrl: string): typeof fetch {
  const proxy = new URL(proxyUrl);
  const proxyHost = proxy.hostname;
  const proxyPort = parseInt(proxy.port) || 8080;

  return async (input, init?) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
    );
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};

    if (init?.headers instanceof Headers) {
      init.headers.forEach((v, k) => (headers[k] = v));
    } else if (init?.headers) {
      Object.assign(headers, init.headers);
    }

    if (!headers["host"]) headers["host"] = url.host;

    const targetHost = url.hostname;
    const targetPort = parseInt(url.port) || (url.protocol === "https:" ? 443 : 80);

    // HTTP CONNECT tunnel for HTTPS
    const proxySocket = net.connect(proxyPort, proxyHost);
    await new Promise<void>((resolve, reject) => {
      proxySocket.once("connect", resolve);
      proxySocket.once("error", reject);
    });

    if (url.protocol === "https:") {
      // Send CONNECT request
      proxySocket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);

      // Wait for 200 response
      await new Promise<void>((resolve, reject) => {
        let buf = "";
        const onData = (chunk: Buffer) => {
          buf += chunk.toString();
          if (buf.includes("\r\n\r\n")) {
            proxySocket.removeListener("data", onData);
            if (buf.startsWith("HTTP/1.1 200") || buf.startsWith("HTTP/1.0 200")) {
              resolve();
            } else {
              reject(new Error(`Proxy CONNECT failed: ${buf.split("\r\n")[0]}`));
            }
          }
        };
        proxySocket.on("data", onData);
        proxySocket.once("error", reject);
      });
    }

    // Upgrade to TLS for HTTPS
    const socket = url.protocol === "https:"
      ? tls.connect({ socket: proxySocket, servername: targetHost })
      : proxySocket;

    if (socket !== proxySocket) {
      await new Promise<void>((resolve, reject) => {
        (socket as tls.TLSSocket).once("secureConnect", resolve);
        (socket as tls.TLSSocket).once("error", reject);
      });
    }

    // Build and send HTTP request
    let body: Buffer | null = null;
    if (init?.body) {
      if (typeof init.body === "string") {
        body = Buffer.from(init.body);
      } else if (init.body instanceof ArrayBuffer || init.body instanceof Uint8Array) {
        body = Buffer.from(init.body);
      } else if (init.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        body = Buffer.concat(chunks);
      } else {
        body = Buffer.from(String(init.body));
      }
    }

    if (body) headers["content-length"] = body.byteLength.toString();

    const path = url.pathname + url.search;
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");

    socket.write(`${method} ${path} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
    if (body) socket.write(body);

    // Read response
    return new Promise<Response>((resolve, reject) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("error", reject);
      socket.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        const headerEnd = raw.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          reject(new Error("Invalid HTTP response"));
          return;
        }

        const headerSection = raw.slice(0, headerEnd);
        const bodySection = raw.slice(headerEnd + 4);
        const [statusLine, ...headerParts] = headerSection.split("\r\n");
        const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)\s*(.*)/);
        const status = statusMatch ? parseInt(statusMatch[1]) : 200;
        const statusText = statusMatch?.[2] ?? "";

        const respHeaders: Record<string, string> = {};
        for (const h of headerParts) {
          const idx = h.indexOf(":");
          if (idx > 0) {
            respHeaders[h.slice(0, idx).trim().toLowerCase()] = h.slice(idx + 1).trim();
          }
        }

        let responseBody: string;
        if (respHeaders["transfer-encoding"]?.includes("chunked")) {
          responseBody = decodeChunked(bodySection);
        } else {
          responseBody = bodySection;
        }

        resolve(
          new Response(responseBody, { status, statusText, headers: respHeaders }),
        );
      });
    });
  };
}

export function createBot(config: Config): Bot {
  if (!config.telegramProxyUrl) {
    return new Bot(config.telegramBotToken);
  }

  const isSocks = config.telegramProxyUrl.startsWith("socks");
  const proxyType = isSocks ? "SOCKS" : "HTTP";
  log.info(`Using ${proxyType} proxy: ${config.telegramProxyUrl}`);

  const customFetch = isSocks
    ? createSocksFetch(config.telegramProxyUrl)
    : createHttpProxyFetch(config.telegramProxyUrl);

  return new Bot(config.telegramBotToken, {
    client: { fetch: customFetch },
  });
}

export async function sendMessage(bot: Bot, chatId: number, text: string): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (e) {
    log.error("Failed to send message:", e);
  }
}
