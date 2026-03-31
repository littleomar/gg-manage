import type { Context, NextFunction } from "grammy";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("auth");

export function authMiddleware(allowedChatId: number) {
  return async (ctx: Context, next: NextFunction) => {
    if (ctx.chat?.id !== allowedChatId) {
      log.warn(`Unauthorized access from chat ${ctx.chat?.id}`);
      return;
    }
    await next();
  };
}
