import { formatTime } from "./time.ts";

type Level = "INFO" | "WARN" | "ERROR" | "DEBUG";

function log(level: Level, module: string, message: string, ...args: unknown[]) {
  const ts = formatTime(new Date());
  const prefix = `[${ts}] [${level}] [${module}]`;
  if (level === "ERROR") {
    console.error(prefix, message, ...args);
  } else {
    console.log(prefix, message, ...args);
  }
}

export function createLogger(module: string) {
  return {
    info: (msg: string, ...args: unknown[]) => log("INFO", module, msg, ...args),
    warn: (msg: string, ...args: unknown[]) => log("WARN", module, msg, ...args),
    error: (msg: string, ...args: unknown[]) => log("ERROR", module, msg, ...args),
    debug: (msg: string, ...args: unknown[]) => log("DEBUG", module, msg, ...args),
  };
}
