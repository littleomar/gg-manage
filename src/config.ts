import { z } from "zod";

const configSchema = z.object({
  serialPort: z.string().min(1),
  serialBaud: z.coerce.number().int().positive().default(115200),

  telegramBotToken: z.string().min(1),
  telegramChatId: z.coerce.number().int(),
  telegramProxyUrl: z.string().url().optional(),

  smsPollIntervalMs: z.coerce.number().int().positive().default(60000),

  dataDir: z.string().default("./data"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    serialPort: process.env.SERIAL_PORT,
    serialBaud: process.env.SERIAL_BAUD,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    telegramProxyUrl: process.env.TELEGRAM_PROXY_URL || undefined,
    smsPollIntervalMs: process.env.SMS_POLL_INTERVAL_MS,
    dataDir: process.env.DATA_DIR,
  });
}
