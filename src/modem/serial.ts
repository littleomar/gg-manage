import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { createLogger } from "../utils/logger.ts";

const log = createLogger("serial");

export interface SerialConnection {
  port: SerialPort;
  parser: ReadlineParser;
  write: (data: string) => void;
  close: () => Promise<void>;
}

export function openSerial(path: string, baudRate: number): Promise<SerialConnection> {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    const parser = port.pipe(new ReadlineParser({ delimiter: "\r\n" }));

    port.open((err) => {
      if (err) {
        log.error(`Failed to open ${path}:`, err.message);
        reject(err);
        return;
      }
      log.info(`Opened ${path} at ${baudRate} baud`);

      port.on("error", (e) => log.error("Serial error:", e.message));
      port.on("close", () => log.warn("Serial port closed"));

      resolve({
        port,
        parser,
        write: (data: string) => {
          port.write(data + "\r\n");
        },
        close: () =>
          new Promise<void>((res, rej) => {
            port.close((e) => (e ? rej(e) : res()));
          }),
      });
    });
  });
}
