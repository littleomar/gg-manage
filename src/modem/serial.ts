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
  const required = [baudRate.toString(), "raw"];
  const optional = ["-echo", "cs8", "-parenb", "-cstopb", "-crtscts"];

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

  const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
  const stream = fs.createReadStream("", { fd, autoClose: false });

  const parser = new EventEmitter();
  let buffer = "";

  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\r\n");
    // Keep the last incomplete segment in buffer
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line.length > 0) {
        parser.emit("data", line);
      }
    }
  });

  stream.on("error", (e) => log.error("Serial read error:", e.message));

  log.info(`Opened ${path} at ${baudRate} baud`);

  return {
    parser,
    write: (data: string) => {
      const buf = Buffer.from(data + "\r\n", "utf-8");
      fs.writeSync(fd, buf);
    },
    close: () => {
      return new Promise<void>((resolve) => {
        stream.destroy();
        fs.closeSync(fd);
        log.warn("Serial port closed");
        resolve();
      });
    },
  };
}
