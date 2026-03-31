import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Asia/Shanghai"; // UTC+8

export function formatTime(date: Date | string): string {
  return dayjs(date).tz(TZ).format("YYYY-MM-DD HH:mm:ss");
}

export function now(): dayjs.Dayjs {
  return dayjs().tz(TZ);
}

export function addDays(date: Date | string, days: number): dayjs.Dayjs {
  return dayjs(date).tz(TZ).add(days, "day");
}

export function diffDays(target: Date | string): number {
  return dayjs(target).tz(TZ).diff(now(), "day");
}
