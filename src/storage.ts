import { join } from "path";

export async function readJson<T>(filePath: string): Promise<T | null> {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  return file.json() as Promise<T>;
}

export async function writeJson<T>(filePath: string, data: T): Promise<void> {
  await Bun.write(filePath, JSON.stringify(data, null, 2));
}

export function dataPath(dataDir: string, filename: string): string {
  return join(dataDir, filename);
}
