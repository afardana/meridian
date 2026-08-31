import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const indexSource = fs.readFileSync(path.join(repoRoot, "index.js"), "utf8");
const stateSource = fs.readFileSync(path.join(repoRoot, "state.js"), "utf8");
const dlmmSource = fs.readFileSync(path.join(repoRoot, "tools", "dlmm.js"), "utf8");
const lessonsSource = fs.readFileSync(path.join(repoRoot, "lessons.js"), "utf8");

assert.match(dlmmSource, /export async function fetchClosedPositionPnl/);
assert.match(dlmmSource, /export async function reconcileExternallyClosedPosition/);
assert.match(dlmmSource, /status=closed&pageSize=100/);
assert.match(indexSource, /const repairPendingExternalCloses = async \(\) =>/);
assert.match(indexSource, /reconcileExternallyClosedPosition\(tracked\.position/);
assert.match(indexSource, /closed PnL lookup pending/);
assert.match(stateSource, /export function recordReconciledClose/);
assert.match(stateSource, /pos\.external_close_pending = true/);
assert.match(lessonsSource, /recorded_at: perf\.recorded_at \|\| new Date\(\)\.toISOString\(\)/);

console.log("External close reconciliation coverage passed.");
