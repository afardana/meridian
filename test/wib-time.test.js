process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 2026-10-18, operator: "Please make all times GMT+7 WIB in the Telegram messages." Every
// absolute time sent to Telegram goes through wib-time.js, labelled WIB, independent of the
// host's TZ.
const W = await import("../wib-time.js");
const { blockLabelWithWib, formatDeployTimingReport, formatDeployTimingBriefing } = await import("../deploy-timing.js");
const { backfillSummaryText } = await import("../close-audit.js");

const AT = Date.UTC(2026, 9, 17, 23, 12, 5); // 2026-10-17T23:12:05Z = Sun 18 Oct 06:12:05 WIB

test("a UTC instant in every style, labelled WIB", () => {
  assert.equal(W.fmtWib(AT, "time"), "06:12 WIB");
  assert.equal(W.fmtWib(AT, "time_s"), "06:12:05 WIB");
  assert.equal(W.fmtWib(AT, "datetime"), "18 Oct 06:12 WIB");
  assert.equal(W.fmtWib(AT, "date_long"), "Sun 18 Oct 2026 (WIB)");
  assert.equal(W.fmtWib(AT), "06:12 WIB", "time is the default style");
  assert.equal(W.fmtWib(new Date(AT), "time"), "06:12 WIB", "Date input");
  assert.equal(W.fmtWib("2026-10-17T23:12:05.000Z", "time_s"), "06:12:05 WIB", "ISO input");
  assert.equal(W.fmtWib("2026-10-18T06:12:05+07:00", "time_s"), "06:12:05 WIB", "a +07:00 log stamp round-trips");
});

test("suffix off drops the zone label only", () => {
  assert.equal(W.fmtWib(AT, "time", { suffix: false }), "06:12");
  assert.equal(W.fmtWib(AT, "time_s", { suffix: false }), "06:12:05");
  assert.equal(W.fmtWib(AT, "datetime", { suffix: false }), "18 Oct 06:12");
  assert.equal(W.fmtWib(AT, "date_long", { suffix: false }), "Sun 18 Oct 2026");
});

test("h23: WIB midnight is 00, never 24", () => {
  const midnight = Date.UTC(2026, 9, 17, 17, 0, 0); // 00:00 WIB on the 18th
  assert.equal(W.fmtWib(midnight, "time_s"), "00:00:00 WIB");
  assert.equal(W.fmtWib(midnight + 30 * 60_000, "time"), "00:30 WIB");
  assert.equal(W.fmtWib(Date.UTC(2026, 9, 18, 16, 59, 0), "time"), "23:59 WIB");
});

test("day key follows the WIB calendar across midnight and year end", () => {
  assert.equal(W.wibDayKey(Date.UTC(2026, 9, 17, 16, 59, 59)), "2026-10-17");
  assert.equal(W.wibDayKey(Date.UTC(2026, 9, 17, 17, 0, 0)), "2026-10-18");
  assert.equal(W.wibDayKey(Date.UTC(2026, 11, 31, 17, 0, 0)), "2027-01-01");
  assert.equal(W.fmtWib(Date.UTC(2026, 11, 31, 17, 0, 0), "date_long"), "Fri 1 Jan 2027 (WIB)");
  assert.equal(W.wibDayKey(Date.UTC(2026, 2, 4, 20, 0, 0)), "2026-03-05", "single-digit day is padded in the key");
});

test("month names are ours (ICU's en-GB says 'Sept'), days unpadded in display", () => {
  const months = [];
  for (let m = 0; m < 12; m++) months.push(W.fmtWib(Date.UTC(2026, m, 5, 3), "datetime", { suffix: false }).split(" ")[1]);
  assert.deepEqual(months, ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
  assert.equal(W.fmtWib(Date.UTC(2026, 8, 5, 3), "datetime"), "5 Sep 10:00 WIB");
});

test("missing or invalid input is null, not 'Invalid Date'", () => {
  for (const v of [null, undefined, "", "not a date", NaN]) assert.equal(W.fmtWib(v, "time"), null, String(v));
  assert.equal(W.wibDayKey("nope"), null);
  assert.equal(W.wibParts(null), null);
  assert.equal(W.fmtWib(AT, "no-such-style"), "06:12 WIB", "an unknown style falls back to time");
});

test("the host time zone does not matter", () => {
  const mod = fileURLToPath(new URL("../wib-time.js", import.meta.url));
  const code = `import(${JSON.stringify(mod)}).then((m) => console.log([m.fmtWib(${AT}, "datetime"), m.fmtWib(${AT}, "date_long"), m.wibDayKey(${AT})].join("|")))`;
  for (const tz of ["UTC", "America/New_York", "Pacific/Auckland", "Asia/Jakarta"]) {
    const out = execFileSync(process.execPath, ["-e", code], { env: { ...process.env, TZ: tz } }).toString().trim();
    assert.equal(out, "18 Oct 06:12 WIB|Sun 18 Oct 2026 (WIB)|2026-10-18", tz);
  }
});

test("UTC hour → WIB hour", () => {
  assert.deepEqual([0, 4, 16, 17, 20, 23, 24].map(W.wibHourOfUtcHour), [7, 11, 23, 0, 3, 6, 7]);
});

// ── deploy-timing: UTC blocks keep their label, Telegram text adds the WIB hours ─────────
test("deploy-timing block labels carry the WIB hours", () => {
  assert.equal(blockLabelWithWib(0, 4), "00-04 UTC (07-11 WIB)");
  assert.equal(blockLabelWithWib(12, 16), "12-16 UTC (19-23 WIB)");
  assert.equal(blockLabelWithWib(16, 20), "16-20 UTC (23-03 WIB)");
  assert.equal(blockLabelWithWib(20, 24), "20-24 UTC (03-07 WIB)");
  assert.equal(blockLabelWithWib(17, 21), "17-21 UTC (00-04 WIB)");
});

// 60 decisive closes, 10 per 4h block; the 00-04 UTC block wins most, 12-16 UTC least.
function timingRecords() {
  const recs = [];
  const wins = [8, 5, 5, 2, 5, 5];
  for (let b = 0; b < 6; b++) {
    for (let i = 0; i < 10; i++) {
      const deploy = Date.UTC(2026, 9, 1 + i, b * 4 + 1, 0, 0);
      const win = i < wins[b];
      recs.push({
        recorded_at: new Date(deploy + 60 * 60_000).toISOString(), minutes_held: 60,
        pnl_pct: win ? 3 : -6, close_reason: win ? "trailing TP" : "stop loss",
      });
    }
  }
  return recs;
}

test("/timing table: UTC blocks with their WIB hours, columns aligned", () => {
  const report = formatDeployTimingReport({ records: timingRecords() });
  const lines = report.split("\n");
  assert.match(lines[0], /4h UTC blocks \(WIB = UTC\+7\)/);
  const header = lines.find((l) => l.startsWith("block"));
  const row = lines.find((l) => l.startsWith("00-04 UTC (07-11 WIB)"));
  assert.ok(row, report);
  assert.equal(header.indexOf("n  succ"), row.indexOf(" 10  ") + 2, "the n column lines up under its header (right-aligned)");
  assert.match(report, /Best: {2}00-04 UTC \(07-11 WIB\) — 80% over 10 closes/);
  assert.match(report, /Worst: 12-16 UTC \(19-23 WIB\) — 20% over 10 closes/);
});

test("briefing timing line: WIB only when asked (the dashboard-report line stays UTC)", () => {
  const records = timingRecords();
  assert.equal(formatDeployTimingBriefing({ records, wib: true }),
    "⏰ Best 00-04 UTC (07-11 WIB): 80% · Worst 12-16 UTC (19-23 WIB): 20% · Baseline 50%");
  assert.equal(formatDeployTimingBriefing({ records }), "⏰ Best 00-04 UTC (80%) · Worst 12-16 UTC (20%) · Baseline 50%");
  const report = fs.readFileSync(new URL("../report.js", import.meta.url), "utf8");
  assert.doesNotMatch(report, /formatDeployTimingBriefing\(\{[^)]*wib/);
});

// ── the other Telegram sites ─────────────────────────────────────────────────────────────
test("close-audit backfill summary shows its start in WIB", () => {
  const text = backfillSummaryText("2026-09-27T00:00:00.000Z", { reaudited: 1, changed: 0, ledger_delta_sol: 0, kept: 0 });
  assert.match(text, /Since 27 Sep 07:00 WIB: 1 re-audited/);
  assert.match(backfillSummaryText("whenever", { reaudited: 0, changed: 0 }), /Since whenever:/);
});

test("Telegram sources format times through wib-time.js, never the host zone", () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const idx = read("index.js");
  assert.equal((idx.match(/🕐 updated <code>\$\{updatedAt\}<\/code>/g) || []).length, 2);
  assert.equal((idx.match(/const updatedAt = fmtWib\(Date\.now\(\), "time_s"\);/g) || []).length, 2);
  assert.match(idx, /fmtWib\(timestamp, "time_s"\)/, "/candidates");
  assert.match(idx, /fmtWib\(item\.until, "datetime"\)/, "/cooldowns");
  assert.match(read("briefing.js"), /Morning Briefing<\/b> — \$\{fmtWib\(now, "date_long"\)\} · last 24h/);
  assert.match(read("briefing.js"), /formatDeployTimingBriefing\(\{ wib: true \}\)/);
  assert.match(read("scripts/db_backup.js"), /fmtWib\(Date\.now\(\), "datetime"\)/);
  for (const f of ["index.js", "briefing.js", "llm-status.js", "circuit-breaker.js", "telegram.js", "close-audit.js", "deploy-timing.js"]) {
    assert.doesNotMatch(read(f), /\.toLocale(Time|Date)?String\(\s*\)|toLocaleTimeString\(/, `${f}: host-zone time formatting`);
  }
});
