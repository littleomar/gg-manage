import { z } from "zod";

const configSchema = z.object({
  serialPort: z.string().min(1),
  serialUrcPort: z.string().optional(),
  serialBaud: z.coerce.number().int().positive().default(115200),

  telegramBotToken: z.string().min(1),
  telegramChatId: z.coerce.number().int(),
  telegramProxyUrl: z.string().url().optional(),

  smsPollIntervalMs: z.coerce.number().int().positive().default(60000),

  keepaliveUrl: z.string().url().default("https://www.gstatic.com/generate_204"),
  keepaliveTimeoutMs: z.coerce.number().int().positive().default(15000),
  giffgaffDashboardUrl: z
    .string()
    .url()
    .default("https://www.giffgaff.com/dashboard"),
  giffgaffUsername: z.string().min(1).optional(),
  giffgaffPassword: z.string().min(1).optional(),

  dataDir: z.string().default("./data"),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    serialPort: process.env.SERIAL_PORT,
    serialUrcPort: process.env.SERIAL_URC_PORT || undefined,
    serialBaud: process.env.SERIAL_BAUD,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    telegramProxyUrl: process.env.TELEGRAM_PROXY_URL || undefined,
    smsPollIntervalMs: process.env.SMS_POLL_INTERVAL_MS,
    giffgaffUsername: process.env.GG_USERNAME || undefined,
    giffgaffPassword: process.env.GG_PASSWORD || undefined,
    dataDir: process.env.DATA_DIR,
  });
}
