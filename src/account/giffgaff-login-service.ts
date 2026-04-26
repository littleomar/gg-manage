import { createLogger } from "../utils/logger.ts";

const LOGIN_PAGE_URL = "https://www.giffgaff.com/auth/login";
const LOGIN_API_URL = "https://id.giffgaff.com/auth/login";
const MFA_TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const log = createLogger("account.login");

export interface GiffgaffLoginService {
  login(): Promise<string>;
  isLoginInProgress(): boolean;
  receiveMfaCode(code: string): boolean;
}

function extractCookies(response: Response): Map<string, string> {
  const cookies = new Map<string, string>();
  const raw = response.headers.getSetCookie?.() ?? [];
  for (const entry of raw) {
    const eq = entry.indexOf("=");
    if (eq < 1) continue;
    const name = entry.slice(0, eq).trim();
    const rest = entry.slice(eq + 1);
    const semi = rest.indexOf(";");
    cookies.set(name, (semi >= 0 ? rest.slice(0, semi) : rest).trim());
  }
  return cookies;
}

function maskUsername(username: string): string {
  if (username.length <= 2) return "*".repeat(username.length);
  return `${username[0]}***${username[username.length - 1]}`;
}

function summarizeJar(jar: Map<string, string>): string {
  if (jar.size === 0) return "<empty>";
  return Array.from(jar.keys()).join(",");
}

function serializeCookies(jar: Map<string, string>): string {
  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

function previewBody(body: string, max = 300): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max)}…(+${oneLine.length - max})`;
}

function redactRequestBody(body: string): string {
  try {
    const obj = JSON.parse(body) as Record<string, unknown>;
    if (!obj || typeof obj !== "object") return previewBody(body);
    const redacted: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "password") redacted[k] = "***";
      else if (k === "mfaCode") redacted[k] = `****${String(v).slice(-2)}`;
      else if (k === "memberName") redacted[k] = maskUsername(String(v));
      else redacted[k] = v;
    }
    return JSON.stringify(redacted);
  } catch {
    return previewBody(body);
  }
}

function summarizeRequestHeaders(
  headers: Record<string, string | undefined>,
): string {
  const parts: string[] = [];
  for (const [k, raw] of Object.entries(headers)) {
    if (raw == null) continue;
    const lk = k.toLowerCase();
    if (lk === "user-agent" || lk === "accept" || lk === "accept-language") {
      continue;
    }
    if (lk === "cookie") {
      const count = raw ? raw.split(";").filter((s) => s.trim()).length : 0;
      parts.push(`Cookie=<${count} cookies>`);
    } else if (lk === "x-csrf-token") {
      parts.push(`x-csrf-token=<len ${raw.length}>`);
    } else {
      parts.push(`${k}=${raw}`);
    }
  }
  return parts.length === 0 ? "<minimal>" : parts.join(", ");
}

function summarizeResponseHeaders(response: Response): string {
  const parts: string[] = [];
  const ct = response.headers.get("content-type");
  if (ct) parts.push(`content-type=${ct}`);
  const cl = response.headers.get("content-length");
  if (cl) parts.push(`content-length=${cl}`);
  const loc = response.headers.get("location");
  if (loc) parts.push(`location=${loc}`);
  const sc = response.headers.getSetCookie?.() ?? [];
  if (sc.length) {
    const names = sc
      .map((c) => {
        const eq = c.indexOf("=");
        return eq > 0 ? c.slice(0, eq) : c;
      })
      .join(",");
    parts.push(`set-cookie=[${names}]`);
  }
  return parts.length === 0 ? "<no notable headers>" : parts.join(" | ");
}

export interface GiffgaffHttpLoginServiceOptions {
  username: string;
  password: string;
  fetch?: typeof fetch;
  userAgent?: string;
  onAwaitingMfa?: () => void;
}

export class GiffgaffHttpLoginService implements GiffgaffLoginService {
  readonly #username: string;
  readonly #password: string;
  readonly #fetch: typeof fetch;
  readonly #userAgent: string;
  #loginInProgress = false;
  #mfaResolver: ((code: string) => void) | null = null;
  #onAwaitingMfa: (() => void) | null;

  constructor(options: GiffgaffHttpLoginServiceOptions) {
    this.#username = options.username;
    this.#password = options.password;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#onAwaitingMfa = options.onAwaitingMfa ?? null;
  }

  isLoginInProgress(): boolean {
    return this.#loginInProgress;
  }

  receiveMfaCode(code: string): boolean {
    if (this.#mfaResolver) {
      this.#mfaResolver(code);
      this.#mfaResolver = null;
      return true;
    }
    return false;
  }

  setOnAwaitingMfa(handler: (() => void) | null): void {
    this.#onAwaitingMfa = handler;
  }

  async #loggedFetch(
    label: string,
    url: string,
    init: RequestInit,
    options: { previewBytes?: number } = {},
  ): Promise<{ response: Response; durationMs: number }> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string | undefined>;
    const bodyStr =
      typeof init.body === "string" ? (init.body as string) : null;

    log.info(
      `${label} → ${method} ${url} | ${summarizeRequestHeaders(headers)}` +
        (bodyStr
          ? ` | body[${bodyStr.length}b]: ${redactRequestBody(bodyStr)}`
          : ""),
    );

    const started = Date.now();
    let response: Response;
    try {
      response = await this.#fetch(url, init);
    } catch (e) {
      log.error(
        `${label} ✕ fetch error after ${Date.now() - started}ms: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    }
    const durationMs = Date.now() - started;

    log.info(
      `${label} ← HTTP ${response.status} ${response.statusText || ""} in ${durationMs}ms | ${summarizeResponseHeaders(response)}`,
    );

    const previewBytes = options.previewBytes ?? 0;
    if (previewBytes > 0) {
      response
        .clone()
        .text()
        .then((text) => {
          if (text.length === 0) {
            log.info(`${label} ← body: <empty>`);
            return;
          }
          log.info(
            `${label} ← body[${text.length}b preview]: ${previewBody(text, previewBytes)}`,
          );
        })
        .catch((e) => {
          log.warn(
            `${label} ← body preview unavailable: ${e instanceof Error ? e.message : String(e)}`,
          );
        });
    }

    return { response, durationMs };
  }

  async login(): Promise<string> {
    if (this.#loginInProgress) {
      log.warn("login() called while another login is in progress; rejecting.");
      throw new Error("Login already in progress.");
    }

    this.#loginInProgress = true;
    const startedAt = Date.now();
    log.info(
      `Auto-login starting for user=${maskUsername(this.#username)} (timeout per request ${REQUEST_TIMEOUT_MS / 1000}s, MFA wait ${MFA_TIMEOUT_MS / 1000}s).`,
    );
    try {
      const cookie = await this.#performLogin();
      log.info(
        `Auto-login finished in ${Date.now() - startedAt}ms (cookie length=${cookie.length}).`,
      );
      return cookie;
    } catch (e) {
      log.error(
        `Auto-login aborted after ${Date.now() - startedAt}ms: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e;
    } finally {
      this.#loginInProgress = false;
      this.#mfaResolver = null;
    }
  }

  async #performLogin(): Promise<string> {
    const jar = new Map<string, string>();
    const commonHeaders = {
      "Accept-Language": "en-GB,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "User-Agent": this.#userAgent,
    };

    const { response: pageResponse } = await this.#loggedFetch(
      "Step1.GET",
      LOGIN_PAGE_URL,
      {
        headers: {
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          ...commonHeaders,
          "Upgrade-Insecure-Requests": "1",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    for (const [name, value] of extractCookies(pageResponse)) {
      jar.set(name, value);
    }

    if (pageResponse.status >= 300 && pageResponse.status < 400) {
      const redirectUrl = pageResponse.headers.get("location");
      if (redirectUrl) {
        const target = redirectUrl.startsWith("http")
          ? redirectUrl
          : new URL(redirectUrl, LOGIN_PAGE_URL).href;
        const { response: redirectResponse } = await this.#loggedFetch(
          "Step1.GET[redirect]",
          target,
          {
            headers: {
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              ...commonHeaders,
              Cookie: serializeCookies(jar),
              "Upgrade-Insecure-Requests": "1",
            },
            redirect: "manual",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
        );
        for (const [name, value] of extractCookies(redirectResponse)) {
          jar.set(name, value);
        }
      } else {
        log.warn(
          `Step 1 returned ${pageResponse.status} with no Location header.`,
        );
      }
    }

    const xsrfToken = jar.get("XSRF-TOKEN");
    if (!xsrfToken) {
      log.error(
        `Step 1 jar missing XSRF-TOKEN. Got cookies: ${summarizeJar(jar)}`,
      );
      throw new Error("Failed to obtain XSRF-TOKEN from login page.");
    }
    log.info(
      `Step 1 complete. ${jar.size} cookies acquired (${summarizeJar(jar)}); XSRF-TOKEN length=${xsrfToken.length}.`,
    );

    const deviceId = crypto.randomUUID().replace(/-/g, "");
    log.info(`Step 2 device-id=${deviceId.slice(0, 8)}…`);
    const { response: credentialResponse, durationMs: step2Duration } =
      await this.#loggedFetch(
        "Step2.POST",
        LOGIN_API_URL,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            ...commonHeaders,
            Cookie: serializeCookies(jar),
            "x-csrf-token": xsrfToken,
            device: "web",
            "device-id": deviceId,
            Origin: "https://www.giffgaff.com",
          },
          body: JSON.stringify({
            memberName: this.#username,
            password: this.#password,
          }),
          redirect: "follow",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
        { previewBytes: 500 },
      );
    for (const [name, value] of extractCookies(credentialResponse)) {
      jar.set(name, value);
    }

    const credentialBody = (await credentialResponse.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
    };
    log.info(
      `Step 2 parsed body: code=${credentialBody.code ?? "-"} message=${credentialBody.message ?? "-"} (HTTP ${credentialResponse.status} in ${step2Duration}ms, jar=${jar.size}).`,
    );

    const isMfaRequired =
      credentialBody.code === "mfa.required" ||
      credentialResponse.status === 401;

    if (!isMfaRequired) {
      if (credentialResponse.ok) {
        log.info(`Login succeeded without MFA. Final jar=${jar.size} cookies.`);
        return serializeCookies(jar);
      }
      throw new Error(
        `Login failed: ${credentialBody.message ?? credentialBody.code ?? `HTTP ${credentialResponse.status}`}`,
      );
    }

    log.info(
      `Step 2 complete; MFA required. Awaiting SMS verification code (timeout ${MFA_TIMEOUT_MS / 1000}s).`,
    );
    this.#onAwaitingMfa?.();

    const mfaWaitStarted = Date.now();
    const mfaCode = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#mfaResolver = null;
        log.error(
          `MFA wait timed out after ${MFA_TIMEOUT_MS / 1000}s; no SMS received.`,
        );
        reject(
          new Error(
            `MFA verification code not received within ${MFA_TIMEOUT_MS / 1000}s.`,
          ),
        );
      }, MFA_TIMEOUT_MS);

      this.#mfaResolver = (code: string) => {
        clearTimeout(timer);
        resolve(code);
      };
    });

    log.info(
      `Step 3: MFA code received after ${Date.now() - mfaWaitStarted}ms; verifying.`,
    );
    const { response: mfaResponse } = await this.#loggedFetch(
      "Step3.POST",
      LOGIN_API_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...commonHeaders,
          Cookie: serializeCookies(jar),
          "x-csrf-token": xsrfToken,
          device: "web",
          "device-id": deviceId,
          Origin: "https://www.giffgaff.com",
        },
        body: JSON.stringify({
          memberName: this.#username,
          password: this.#password,
          mfaCode,
          rememberBrowser: false,
        }),
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      { previewBytes: 500 },
    );
    for (const [name, value] of extractCookies(mfaResponse)) {
      jar.set(name, value);
    }

    if (!mfaResponse.ok) {
      const body = (await mfaResponse.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(
        `MFA login failed: ${body?.message ?? `HTTP ${mfaResponse.status}`}`,
      );
    }

    log.info(
      `Login completed via MFA. Final jar=${jar.size} cookies (${summarizeJar(jar)}).`,
    );
    return serializeCookies(jar);
  }
}

const MFA_SMS_PATTERN = /(\d{6})\s+is your giffgaff verification code/i;

export function extractMfaCode(body: string): string | null {
  return body.match(MFA_SMS_PATTERN)?.[1] ?? null;
}
