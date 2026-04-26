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

function serializeCookies(jar: Map<string, string>): string {
  return Array.from(jar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
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

  async login(): Promise<string> {
    if (this.#loginInProgress) {
      throw new Error("Login already in progress.");
    }

    this.#loginInProgress = true;
    try {
      return await this.#performLogin();
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

    log.info("Step 1: Fetching login page for session cookies.");
    const pageResponse = await this.#fetch(LOGIN_PAGE_URL, {
      headers: {
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        ...commonHeaders,
        "Upgrade-Insecure-Requests": "1",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    for (const [name, value] of extractCookies(pageResponse)) {
      jar.set(name, value);
    }

    if (pageResponse.status >= 300 && pageResponse.status < 400) {
      const redirectUrl = pageResponse.headers.get("location");
      if (redirectUrl) {
        const target = redirectUrl.startsWith("http")
          ? redirectUrl
          : new URL(redirectUrl, LOGIN_PAGE_URL).href;
        const redirectResponse = await this.#fetch(target, {
          headers: {
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            ...commonHeaders,
            Cookie: serializeCookies(jar),
            "Upgrade-Insecure-Requests": "1",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        for (const [name, value] of extractCookies(redirectResponse)) {
          jar.set(name, value);
        }
      }
    }

    const xsrfToken = jar.get("XSRF-TOKEN");
    if (!xsrfToken) {
      throw new Error("Failed to obtain XSRF-TOKEN from login page.");
    }
    log.info(`Step 1 complete. Cookies: ${jar.size}`);

    log.info("Step 2: Submitting credentials.");
    const deviceId = crypto.randomUUID().replace(/-/g, "");
    const credentialResponse = await this.#fetch(LOGIN_API_URL, {
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
    });
    for (const [name, value] of extractCookies(credentialResponse)) {
      jar.set(name, value);
    }

    const credentialBody = (await credentialResponse.json().catch(() => ({}))) as {
      code?: string;
      message?: string;
    };
    log.info(
      `Step 2 response: HTTP ${credentialResponse.status} code=${credentialBody.code ?? "-"}`,
    );

    const isMfaRequired =
      credentialBody.code === "mfa.required" ||
      credentialResponse.status === 401;

    if (!isMfaRequired) {
      if (credentialResponse.ok) {
        log.info("Login succeeded without MFA.");
        return serializeCookies(jar);
      }
      throw new Error(
        `Login failed: ${credentialBody.message ?? credentialBody.code ?? `HTTP ${credentialResponse.status}`}`,
      );
    }

    log.info("Step 2 complete. Awaiting MFA SMS.");
    this.#onAwaitingMfa?.();

    const mfaCode = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#mfaResolver = null;
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

    log.info("Step 3: MFA code received, submitting.");
    const mfaResponse = await this.#fetch(LOGIN_API_URL, {
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
    });
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

    log.info(`Login completed. Cookies: ${jar.size}`);
    return serializeCookies(jar);
  }
}

const MFA_SMS_PATTERN = /(\d{6})\s+is your giffgaff verification code/i;

export function extractMfaCode(body: string): string | null {
  return body.match(MFA_SMS_PATTERN)?.[1] ?? null;
}
