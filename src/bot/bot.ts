import * as net from "node:net";
import type { Duplex } from "node:stream";
import * as tls from "node:tls";
import { Bot } from "grammy";
import { SocksClient } from "socks";
import type { Config } from "../config.ts";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("bot");

/** Collect headers from init, inject host and connection: close */
function buildHeaders(
	init: RequestInit | undefined,
	host: string,
): Record<string, string> {
	const headers: Record<string, string> = {};
	if (init?.headers instanceof Headers) {
		init.headers.forEach((v, k) => (headers[k] = v));
	} else if (init?.headers) {
		Object.assign(headers, init.headers);
	}
	if (!headers["host"]) headers["host"] = host;
	headers["connection"] = "close";
	return headers;
}

/** Read request body into a Buffer */
async function readBody(init: RequestInit | undefined): Promise<Buffer | null> {
	if (!init?.body) return null;
	if (typeof init.body === "string") return Buffer.from(init.body);
	if (init.body instanceof ArrayBuffer || init.body instanceof Uint8Array)
		return Buffer.from(init.body);
	if (init.body instanceof ReadableStream) {
		const reader = init.body.getReader();
		const chunks: Uint8Array[] = [];
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
		return Buffer.concat(chunks);
	}
	return Buffer.from(String(init.body));
}

/** Send an HTTP request over a connected socket and return a Response */
function httpOverSocket(
	socket: Duplex,
	method: string,
	path: string,
	headers: Record<string, string>,
	body: Buffer | null,
): Promise<Response> {
	if (body) headers["content-length"] = body.byteLength.toString();

	const headerLines = Object.entries(headers)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\r\n");
	socket.write(`${method} ${path} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
	if (body) socket.write(body);

	return new Promise<Response>((resolve, reject) => {
		let buf = Buffer.alloc(0);
		let headersParsed = false;
		let contentLength = -1;
		let isChunked = false;
		let headerEnd = -1;
		let respStatus = 200;
		let respStatusText = "";
		const respHeaders: Record<string, string> = {};

		const tryResolve = () => {
			const bodyBuf = buf.subarray(headerEnd + 4);

			if (isChunked) {
				const bodyStr = bodyBuf.toString();
				// Chunked body ends with "0\r\n\r\n"
				if (bodyStr.includes("\r\n0\r\n")) {
					socket.destroy();
					resolve(
						new Response(decodeChunked(bodyStr), {
							status: respStatus,
							statusText: respStatusText,
							headers: respHeaders,
						}),
					);
					return true;
				}
			} else if (contentLength >= 0) {
				if (bodyBuf.length >= contentLength) {
					socket.destroy();
					resolve(
						new Response(bodyBuf.subarray(0, contentLength).toString(), {
							status: respStatus,
							statusText: respStatusText,
							headers: respHeaders,
						}),
					);
					return true;
				}
			}
			return false;
		};

		socket.on("data", (chunk: Buffer) => {
			buf = Buffer.concat([buf, chunk]);

			if (!headersParsed) {
				headerEnd = buf.indexOf("\r\n\r\n");
				if (headerEnd === -1) return;
				headersParsed = true;

				const headerSection = buf.subarray(0, headerEnd).toString();
				const [statusLine, ...headerParts] = headerSection.split("\r\n");
				const statusMatch = statusLine.match(/HTTP\/[\d.]+ (\d+)\s*(.*)/);
				respStatus = statusMatch ? parseInt(statusMatch[1]) : 200;
				respStatusText = statusMatch?.[2] ?? "";

				for (const h of headerParts) {
					const idx = h.indexOf(":");
					if (idx > 0) {
						respHeaders[h.slice(0, idx).trim().toLowerCase()] = h
							.slice(idx + 1)
							.trim();
					}
				}

				contentLength = respHeaders["content-length"]
					? parseInt(respHeaders["content-length"])
					: -1;
				isChunked =
					respHeaders["transfer-encoding"]?.includes("chunked") ?? false;
			}

			if (headersParsed) tryResolve();
		});

		// Fallback: resolve on connection close
		socket.on("end", () => {
			if (headersParsed) {
				const bodyBuf = buf.subarray(headerEnd + 4);
				let responseBody = bodyBuf.toString();
				if (isChunked) responseBody = decodeChunked(responseBody);
				resolve(
					new Response(responseBody, {
						status: respStatus,
						statusText: respStatusText,
						headers: respHeaders,
					}),
				);
			} else {
				reject(new Error("Connection closed before headers received"));
			}
		});

		socket.on("error", reject);
	});
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

/** Connect to target via TLS, optionally through an existing socket */
async function connectTls(
	base: net.Socket,
	hostname: string,
): Promise<tls.TLSSocket> {
	const tlsSocket = tls.connect({ socket: base, servername: hostname });
	await new Promise<void>((resolve, reject) => {
		tlsSocket.once("secureConnect", resolve);
		tlsSocket.once("error", reject);
	});
	return tlsSocket;
}

function createHttpProxyFetch(proxyUrl: string): typeof fetch {
	const proxy = new URL(proxyUrl);
	const proxyHost = proxy.hostname;
	const proxyPort = parseInt(proxy.port) || 8080;

	return async (input, init?) => {
		const url = new URL(
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url,
		);
		const headers = buildHeaders(init, url.host);
		const body = await readBody(init);

		const targetHost = url.hostname;
		const targetPort =
			parseInt(url.port) || (url.protocol === "https:" ? 443 : 80);

		const proxySocket = net.connect(proxyPort, proxyHost);
		await new Promise<void>((resolve, reject) => {
			proxySocket.once("connect", resolve);
			proxySocket.once("error", reject);
		});

		if (url.protocol === "https:") {
			// HTTP CONNECT tunnel
			proxySocket.write(
				`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`,
			);
			await new Promise<void>((resolve, reject) => {
				let buf = "";
				const onData = (chunk: Buffer) => {
					buf += chunk.toString();
					if (buf.includes("\r\n\r\n")) {
						proxySocket.removeListener("data", onData);
						if (
							buf.startsWith("HTTP/1.1 200") ||
							buf.startsWith("HTTP/1.0 200")
						) {
							resolve();
						} else {
							reject(
								new Error(`Proxy CONNECT failed: ${buf.split("\r\n")[0]}`),
							);
						}
					}
				};
				proxySocket.on("data", onData);
				proxySocket.once("error", reject);
			});
		}

		const conn =
			url.protocol === "https:"
				? await connectTls(proxySocket, targetHost)
				: proxySocket;
		return httpOverSocket(
			conn,
			init?.method ?? "GET",
			url.pathname + url.search,
			headers,
			body,
		);
	};
}

export function createBot(config: Config): Bot {
	if (!config.telegramProxyUrl) {
		return new Bot(config.telegramBotToken);
	}

	const customFetch = createHttpProxyFetch(config.telegramProxyUrl);

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
