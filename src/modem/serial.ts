import { createLogger } from "../utils/logger.ts";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";

const log = createLogger("serial");

export interface SerialConnection {
  parser: EventEmitter;
  write: (data: string) => void;
  close: () => Promise<void>;
}

export async function openSerial(
  path: string,
  baudRate: number,
): Promise<SerialConnection> {
  // Configure serial port via stty — apply each setting individually
  // since USB serial devices may not support all terminal options
  const required = ["raw"];
  const optional = [baudRate.toString(), "-echo", "cs8", "-parenb", "-cstopb", "-crtscts"];

  for (const flag of required) {
    const proc = Bun.spawnSync(["stty", "-F", path, flag]);
    if (proc.exitCode !== 0) {
      throw new Error(
        `Failed to set ${flag} on ${path}: ${proc.stderr.toString()}`,
      );
    }
  }

  for (const flag of optional) {
    const proc = Bun.spawnSync(["stty", "-F", path, flag]);
    if (proc.exitCode !== 0) {
      log.warn(`stty ${flag} not supported on ${path}, skipping`);
    }
  }

  // Open fd for writing
  const writeFd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_NOCTTY);

  // Use cat subprocess for reliable continuous reading
  const reader = Bun.spawn(["cat", path], {
    stdout: "pipe",
    stderr: "ignore",
  });

  const parser = new EventEmitter();
  let lineBuffer = "";

  // Read from cat's stdout stream
  (async () => {
    const stream = reader.stdout;
    const textDecoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = textDecoder.decode(chunk, { stream: true });
      lineBuffer += text;
      const lines = lineBuffer.split("\r\n");
      lineBuffer = lines.pop()!;
      for (const line of lines) {
        if (line.length > 0) {
          parser.emit("data", line);
        }
      }
    }
  })().catch((e) => {
    log.error("Serial reader error:", e);
  });

  log.info(`Opened ${path} at ${baudRate} baud`);

  return {
    parser,
    write: (data: string) => {
      const buf = Buffer.from(data + "\r\n", "utf-8");
      fs.writeSync(writeFd, buf);
    },
    close: () => {
      return new Promise<void>((resolve) => {
        reader.kill();
        fs.closeSync(writeFd);
        log.warn("Serial port closed");
        resolve();
      });
    },
  };
}
