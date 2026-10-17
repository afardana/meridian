// wib-time.js — every absolute time the bot sends to Telegram, in WIB (2026-10-18).
//
// Operator: "Please make all times GMT+7 WIB in the Telegram messages." The VM runs with
// TZ=Asia/Jakarta, but the display must not depend on the host zone (a test box, a dev Mac
// or a changed PM2 env would silently print another zone with no label), so every Telegram
// time goes through `fmtWib`, which names the zone explicitly and always says "WIB".
//
// Display strings only. Log lines (already +07:00 ISO), perf-record timestamps, API payloads,
// kv docs the dashboard reads and the LLM prompts keep their ISO/UTC values. Relative ages
// ("12m ago", "held 3h 20m") are zone-free and do not come through here.
//
// Asia/Jakarta has been a fixed UTC+7 since 1964 (no DST), so `WIB_OFFSET_HOURS` is safe for
// translating the deploy-timing UTC hour blocks; instants are always formatted through Intl.

export const WIB_TZ = "Asia/Jakarta";
export const WIB_OFFSET_HOURS = 7;

const STYLES = new Set(["time", "time_s", "datetime", "date_long"]);
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// One formatter, built once, numeric fields only: h23 gives 00–23 (an `hour12:false`
// formatter prints "24:05" at midnight on some ICU builds), and the month/weekday names come
// from our own tables — ICU's en-GB short month for September is "Sept" on Node 26.
let _fmt = null;
function formatter() {
  if (!_fmt) {
    _fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: WIB_TZ, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  }
  return _fmt;
}

function toDate(input) {
  if (input == null || input === "") return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Wall-clock parts of an instant in WIB, or null when the input is not a valid time.
 * Strings: year "2026", month "10", monthName "Oct", day "8" (unpadded), weekday "Sun",
 * hour / minute / second two-digit.
 */
export function wibParts(input) {
  const d = toDate(input);
  if (!d) return null;
  const p = {};
  for (const { type, value } of formatter().formatToParts(d)) p[type] = value;
  const y = Number(p.year), m = Number(p.month), dd = Number(p.day);
  return {
    year: p.year, month: p.month, monthName: MONTH_NAMES[m - 1], day: String(dd),
    weekday: WEEKDAY_NAMES[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()],
    hour: p.hour, minute: p.minute, second: p.second,
  };
}

/**
 * An instant (Date, epoch ms or ISO string) as a WIB display string:
 *   time      → "06:12 WIB"
 *   time_s    → "06:12:05 WIB"
 *   datetime  → "18 Oct 06:12 WIB"
 *   date_long → "Sun 18 Oct 2026 (WIB)"
 * `{ suffix: false }` drops the zone label. Returns null for a missing or invalid time —
 * callers choose their own placeholder ("unknown", "?").
 */
export function fmtWib(input, style = "time", { suffix = true } = {}) {
  const p = wibParts(input);
  if (!p) return null;
  const s = STYLES.has(style) ? style : "time";
  if (s === "date_long") return `${p.weekday} ${p.day} ${p.monthName} ${p.year}${suffix ? " (WIB)" : ""}`;
  const body = s === "time" ? `${p.hour}:${p.minute}`
    : s === "time_s" ? `${p.hour}:${p.minute}:${p.second}`
      : `${p.day} ${p.monthName} ${p.hour}:${p.minute}`;
  return suffix ? `${body} WIB` : body;
}

/** The WIB calendar day of an instant as "YYYY-MM-DD" (null for an invalid time). */
export function wibDayKey(input) {
  const p = wibParts(input);
  return p ? `${p.year}-${p.month}-${p.day.padStart(2, "0")}` : null;
}

/** A UTC hour (0–23) as the WIB hour of the same instant. */
export const wibHourOfUtcHour = (h) => (((Number(h) + WIB_OFFSET_HOURS) % 24) + 24) % 24;
