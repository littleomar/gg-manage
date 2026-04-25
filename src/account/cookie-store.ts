import { dataPath, readJson, writeJson } from "../storage.ts";

const COOKIE_FILE = "account-cookie.json";

interface CookieRecord {
  cookie: string | null;
  updatedAt: string;
}

export class AccountCookieStore {
  #filePath: string;

  constructor(dataDir: string) {
    this.#filePath = dataPath(dataDir, COOKIE_FILE);
  }

  async get(): Promise<string | null> {
    const record = await readJson<CookieRecord>(this.#filePath);
    return record?.cookie ?? null;
  }

  async getUpdatedAt(): Promise<string | null> {
    const record = await readJson<CookieRecord>(this.#filePath);
    return record?.updatedAt ?? null;
  }

  async set(cookie: string | null): Promise<void> {
    await writeJson<CookieRecord>(this.#filePath, {
      cookie,
      updatedAt: new Date().toISOString(),
    });
  }
}
