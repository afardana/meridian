import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("no automatic deletion of historical tables unless explicitly re-enabled in .env", () => {
  const ticks = read("db/tick-store.js");
  assert.match(ticks, /const RETENTION_HOURS = Number\(process\.env\.TICK_RETENTION_HOURS \|\| 0\)/);
  assert.match(ticks, /if \(!\(RETENTION_HOURS > 0\)\) return; \/\/ keep all history/);
  const liq = read("db/liquidity-tick-store.js");
  assert.match(liq, /LIQUIDITY_TICK_RETENTION_HOURS \|\| 0/);
  assert.doesNotMatch(liq, /interval '72 hours'/);
  const bal = read("balance-history.js");
  assert.doesNotMatch(bal, /DELETE FROM balance_history/);
  const backup = read("scripts/db_backup.js");
  assert.match(backup, /PG_BACKUP_KEEP \|\| 0/);
});

test("bounded document stores archive what leaves their hot window", () => {
  assert.ok(fs.existsSync(new URL("../db/migrations/007_history_archive.sql", import.meta.url)));
  const pm = read("pool-memory.js");
  for (const store of ["pool-snapshots", "rejected-reasons", "rejected-snaps", "rejected-pools"]) assert.match(pm, new RegExp(`archiveHistory\\("${store}"`));
  assert.match(read("decision-log.js"), /archiveHistory\("decision-log"/);
  assert.match(read("error-telemetry.js"), /archiveHistory\("error-telemetry"/);
  const lessons = read("lessons.js");
  assert.match(lessons, /archiveHistory\("lessons-evolutions"/);
  assert.match(lessons, /archiveHistory\("lessons-auto"/);
  assert.match(read("index.js"), /flushHistoryArchive\(\)/);
});
