#!/usr/bin/env node
/**
 * scripts/replay/exit_evaluator_replay.js — OFFLINE check of the single exit evaluator
 * (state.js updatePnlAndCheckExits after the audit-01 Q4 merge) against what the live bot
 * actually did over a window of closed positions.
 *
 * Inputs are two CSVs exported read-only from the VM (see the psql \copy commands in
 * AUDIT-01 §11): positions (position_address, pair, lower_bin, upper_bin, deployed_at,
 * closed_at, exit_pnl_pct, close_reason, hold_mode, adopted, adopted_at, amount_sol,
 * token_age_hours_at_deploy, strategy) and poller ticks (position_address, ts epoch s,
 * active_bin, pnl_pct, source).
 *
 * For every non-hold position the script tracks a fixture in a JSON-backend state (the
 * repo's local state.json is saved and restored around the run), replays the distinct
 * valuations through the evaluator with the clock frozen at each tick (Date is shimmed
 * so grace windows, OOR clocks and timers see historical time), confirms peaks and exit
 * signals exactly like the poller (2 distinct valuations; management-cycle instant peak
 * confirm every 600 s; per-rule confirm_ticks), and records the FIRST exit that fires.
 * It then compares family and timing with the recorded close.
 *
 * Not replayable from ticks (no fee/liquidity series): LOW_YIELD, SURGE_DECAY,
 * TOXIC_CONVERSION, and the crash/rug fast paths (poller-only trails) — closes in those
 * families are reported as "not modelled". Stop / take-profit are replayed on pnl_pct.
 *
 * usage: PERSIST_BACKEND=json node scripts/replay/exit_evaluator_replay.js --positions p.csv --ticks t.csv [--config prod.json]
 */
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = process.env.PERSIST_BACKEND || "json";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "mock-key";

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const POS_CSV = opt("--positions"); const TICK_CSV = opt("--ticks"); const CFG = opt("--config", null); const DEBUG = opt("--debug", null);
if (!POS_CSV || !TICK_CSV) { console.error("need --positions and --ticks"); process.exit(1); }

// ── frozen clock ────────────────────────────────────────────────────────────
const RealDate = Date;
let fakeNow = RealDate.now();
class FakeDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [fakeNow])); }
  static now() { return fakeNow; }
}
globalThis.Date = FakeDate;

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const statePath = path.join(repoRoot, "state.json");
const stateBackup = fs.existsSync(statePath) ? fs.readFileSync(statePath) : null;

const csv = (file) => {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const head = lines[0].split(",");
  return lines.slice(1).map((l) => { const c = l.split(","); const o = {}; head.forEach((h, i) => (o[h] = c[i] === "" ? null : c[i])); return o; });
};
const positions = csv(POS_CSV);
const tickRows = csv(TICK_CSV);
const ticksByPos = new Map();
for (const t of tickRows) { if (!ticksByPos.has(t.position_address)) ticksByPos.set(t.position_address, []); ticksByPos.get(t.position_address).push({ ts: Number(t.ts) * 1000, bin: Number(t.active_bin), pnl: Number(t.pnl_pct) }); }

const { config } = await import("../../config.js");
const mgmt = { ...config.management };
if (CFG) { const u = JSON.parse(fs.readFileSync(CFG, "utf8")); Object.assign(mgmt, u.management || {}, u); } // prod user-config.json is flat
const { ensureStateInitialized, trackPosition, updatePnlAndCheckExits, confirmPeak, registerExitSignal, closeTrackedPosition, getTrackedPosition, flushState } = await import("../../state.js");
const { exitFamilyFromReason } = await import("../../lessons.js");
await ensureStateInitialized();

const NOT_MODELLED = new Set(["low_yield", "surge_decay", "toxic_conversion", "crash", "rug", "manual", "external", "llm", "rebalance_leg", "other", "volume_death", "oor_other"]);
const SUSPECT_PP = 15;

function valuationsOf(ticks) {
  const out = []; let lastKey = null, lastPnl = null;
  for (const t of ticks) {
    if (!Number.isFinite(t.pnl)) continue;
    const key = `${t.pnl}|${t.bin}`; if (key === lastKey) continue;
    out.push({ ...t, suspect: lastPnl != null && t.pnl - lastPnl > SUSPECT_PP }); lastKey = key; lastPnl = t.pnl;
  }
  return out;
}

const rows = [];
for (const p of positions) {
  if (p.hold_mode === "true" || p.hold_mode === "t") continue;
  const vals = valuationsOf(ticksByPos.get(p.position_address) || []);
  const actualFamily = exitFamilyFromReason(p.close_reason);
  const closedAt = new RealDate(p.closed_at).getTime();
  if (vals.length < 3) { rows.push({ pair: p.pair, actual: actualFamily, replay: "no_ticks", closedAt }); continue; }
  const lower = Number(p.lower_bin), upper = Number(p.upper_bin);
  const P = p.position_address;
  fakeNow = vals[0].ts;
  const adopted = p.adopted === "true" || p.adopted === "t";
  trackPosition({
    position: P, pool: `POOL_${P.slice(0, 6)}`, pool_name: p.pair, strategy: p.strategy || "spot", amount_sol: Number(p.amount_sol) || 1,
    initial_value_usd: Number(p.amount_sol) || 1, bin_range: [lower, upper], active_bin: vals[0].bin, adopted,
    token_age_hours_at_deploy: p.token_age_hours_at_deploy != null ? Number(p.token_age_hours_at_deploy) : null,
  });
  const pos = getTrackedPosition(P);
  pos.deployed_at = new RealDate(p.deployed_at).toISOString();
  if (adopted) pos.adopted_at = p.adopted_at ? new RealDate(p.adopted_at).toISOString() : pos.deployed_at;
  let oorSince = null, lastMgmt = vals[0].ts, fired = null;
  for (const v of vals) {
    fakeNow = v.ts;
    const inRange = v.bin >= lower && v.bin <= upper;
    if (!inRange && oorSince == null) oorSince = v.ts; if (inRange) oorSince = null;
    const positionData = {
      position: P, pair: p.pair, pnl_pct: v.pnl, effective_pnl_pct: v.pnl, pnl_pct_suspicious: v.suspect, in_range: inRange, active_bin: v.bin,
      lower_bin: lower, upper_bin: upper, minutes_out_of_range: oorSince != null ? Math.floor((v.ts - oorSince) / 60000) : 0,
      age_minutes: Math.floor((v.ts - new RealDate(p.deployed_at).getTime()) / 60000), pnl_quality: "valid", total_value_usd: Number(p.amount_sol) || 1,
      fee_per_tvl_24h: null,
    };
    if (!v.suspect) {
      if (v.ts - lastMgmt >= 600e3) { confirmPeak(P, v.pnl, 1); lastMgmt = v.ts; } else confirmPeak(P, v.pnl, 2);
    }
    const exit = updatePnlAndCheckExits(P, positionData, mgmt);
    const reg = registerExitSignal(P, exit?.action ?? null, exit?.confirm_ticks ?? 2, null, { fresh: true });
    if (DEBUG && p.pair === DEBUG) console.error(`[dbg] ${new RealDate(v.ts).toISOString().slice(11, 19)} bin=${v.bin} pnl=${v.pnl} sus=${v.suspect} inR=${inRange} oorMin=${positionData.minutes_out_of_range} peak=${getTrackedPosition(P)?.peak_pnl_pct} trail=${getTrackedPosition(P)?.trailing_active} grace=${getTrackedPosition(P)?.profit_grace_active} exit=${exit?.action ?? "-"} reg=${reg.count}/${reg.fire}`);
    if (exit && reg.fire) { fired = { ts: v.ts, action: exit.action, family: exit.family, pnl: v.pnl }; break; }
  }
  try { closeTrackedPosition(P, "replay"); } catch {}
  rows.push({ pair: p.pair, adopted, actual: actualFamily, actualPnl: p.exit_pnl_pct != null ? Number(p.exit_pnl_pct) : null, closedAt, replay: fired ? fired.family : "none", replayAction: fired?.action, replayAt: fired?.ts, replayPnl: fired?.pnl, lastTickAt: vals[vals.length - 1].ts });
}
await flushState().catch(() => {});
if (stateBackup) fs.writeFileSync(statePath, stateBackup); else { try { fs.unlinkSync(statePath); } catch {} }

const fmtMin = (a, b) => (a != null && b != null ? ((a - b) / 60000).toFixed(0) + "m" : "-");
console.log(`# Exit evaluator replay — ${rows.length} positions (hold excluded)`);
const byFamily = {};
for (const r of rows) { (byFamily[r.actual] ??= []).push(r); }
console.log("\n| actual family | n | replay same family | replay other | replay none | median Δ (replay − actual close) |");
console.log("|---|---|---|---|---|---|");
for (const [fam, rs] of Object.entries(byFamily).sort((a, b) => b[1].length - a[1].length)) {
  const same = rs.filter((r) => r.replay === r.actual);
  const none = rs.filter((r) => r.replay === "none" || r.replay === "no_ticks");
  const other = rs.length - same.length - none.length;
  const deltas = same.map((r) => (r.replayAt - r.closedAt) / 60000).sort((a, b) => a - b);
  const med = deltas.length ? deltas[Math.floor(deltas.length / 2)].toFixed(0) + "m" : "-";
  console.log(`| ${fam}${NOT_MODELLED.has(fam) ? " (not modelled)" : ""} | ${rs.length} | ${same.length} | ${other} | ${none.length} | ${med} |`);
}
console.log("\n## Modelled families — every disagreement");
for (const r of rows) {
  if (NOT_MODELLED.has(r.actual)) continue;
  if (r.replay === r.actual) continue;
  console.log(`- ${r.pair}${r.adopted ? " (adopted)" : ""}: actual ${r.actual} @${new RealDate(r.closedAt).toISOString().slice(11, 16)}Z pnl ${r.actualPnl ?? "?"} → replay ${r.replay}${r.replayAction ? ` (${r.replayAction})` : ""}${r.replayAt ? ` @${new RealDate(r.replayAt).toISOString().slice(11, 16)}Z pnl ${r.replayPnl}` : ""}`);
}
console.log("\n## Not-modelled families where the replay fired something earlier (would the merged stack have pre-empted?)");
for (const r of rows) {
  if (!NOT_MODELLED.has(r.actual) || r.replay === "none" || r.replay === "no_ticks") continue;
  console.log(`- ${r.pair}: actual ${r.actual} pnl ${r.actualPnl ?? "?"} → replay ${r.replay} ${fmtMin(r.replayAt, r.closedAt)} pnl ${r.replayPnl}`);
}
