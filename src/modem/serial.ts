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

  const fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);

  const parser = new EventEmitter();
  let lineBuffer = "";
  let closed = false;

  // Continuous read loop using non-blocking fd + polling
  const readBuf = Buffer.alloc(1024);
  const poll = () => {
    if (closed) return;
    fs.read(fd, readBuf, 0, readBuf.length, null, (err, bytesRead) => {
      if (closed) return;
      if (err) {
        // EAGAIN means no data available on non-blocking fd
        if ((err as NodeJS.ErrnoException).code === "EAGAIN") {
          setTimeout(poll, 50);
          return;
        }
        log.error("Serial read error:", err.message);
        setTimeout(poll, 100);
        return;
      }

      if (bytesRead > 0) {
        lineBuffer += readBuf.subarray(0, bytesRead).toString("utf-8");
        const lines = lineBuffer.split("\r\n");
        lineBuffer = lines.pop()!;
        for (const line of lines) {
          if (line.length > 0) {
            parser.emit("data", line);
          }
        }
      }

      // Continue reading immediately if we got data, otherwise short delay
      if (bytesRead > 0) {
        poll();
      } else {
        setTimeout(poll, 50);
      }
    });
  };

  poll();
  log.info(`Opened ${path} at ${baudRate} baud`);

  return {
    parser,
    write: (data: string) => {
      const buf = Buffer.from(data + "\r\n", "utf-8");
      fs.writeSync(fd, buf);
    },
    close: () => {
      return new Promise<void>((resolve) => {
        closed = true;
        fs.closeSync(fd);
        log.warn("Serial port closed");
        resolve();
      });
    },
  };
}
