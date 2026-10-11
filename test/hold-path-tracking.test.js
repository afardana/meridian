process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Path tracking (mfe / mae / max bins) while a position is on HOLD ===");

const S = await import("../state.js");
await S.ensureStateInitialized();

const mgmt = { trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, stopLossPct: -15, twapGuardEnabled: false };
const row = (pnl, bin = 50, over = {}) => ({ pnl_pct: pnl, effective_pnl_pct: pnl, in_range: bin >= 0 && bin <= 100, active_bin: bin, lower_bin: 0, upper_bin: 100, pnl_basis: "sol", pnl_management_ready: true, ...over });
let seq = 0;
const mk = (tag) => {
  const a = `TEST_HOLD_PATH_${tag}_${Date.now()}_${seq++}`;
  S.trackPosition({ position: a, pool: "POOL_HP_" + tag, pool_name: tag + "-SOL", amount_sol: 1, strategy: "spot", bin_range: [0, 100], active_bin: 50 });
  return a;
};
const pos = (a) => S.getTrackedPosition(a);
const EXIT_FACING = ["peak_pnl_pct", "trailing_active", "pnl_tick_history", "pending_peak_pnl_pct", "pending_peak_confirm_count", "pending_exit_action", "pending_exit_count", "out_of_range_since", "hold_resume_rebase", "stop_loss_violated_since"];
const snap = (a) => JSON.stringify(EXIT_FACING.map((k) => pos(a)[k] ?? null));

// ── The shared helper is what the evaluator uses (same math, no copy) ─────────────────
{
  const p = {};
  assert.equal(S.advancePathExtremes(p, { pnl_pct: 1.234, active_bin: 50, lower_bin: 0, upper_bin: 100 }), true);
  assert.deepEqual(p, { mfe_pnl_pct: 1.23, mae_pnl_pct: 1.23 });
  assert.equal(S.advancePathExtremes(p, { pnl_pct: 1.234, active_bin: 50, lower_bin: 0, upper_bin: 100 }), false); // nothing moved
  assert.equal(S.advancePathExtremes(p, { pnl_pct: -4, active_bin: -7, lower_bin: 0, upper_bin: 100 }), true);
  assert.equal(S.advancePathExtremes(p, { pnl_pct: 9, active_bin: 112, lower_bin: 0, upper_bin: 100 }), true);
  assert.deepEqual(p, { mfe_pnl_pct: 9, mae_pnl_pct: -4, max_bins_below: 7, max_bins_above: 12 });
  // a suspicious reading moves no PnL extreme (the bins still count, as in the evaluator)
  assert.equal(S.advancePathExtremes(p, { pnl_pct: 300, pnl_pct_suspicious: true, active_bin: 50, lower_bin: 0, upper_bin: 100 }), false);
  for (const bad of [null, undefined, NaN, "5"]) assert.equal(S.advancePathExtremes(p, { pnl_pct: bad }), false);

  const src = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
  assert.equal((src.match(/pos\.mfe_pnl_pct = r;/g) || []).length, 1, "one copy of the MFE math");
  assert.equal((src.match(/pos\.max_bins_below = d;/g) || []).length, 1);
  assert.match(src, /if \(advancePathExtremes\(pos, \{ pnl_pct: currentPnlPct, pnl_pct_suspicious, active_bin, lower_bin, upper_bin \}\)\) changed = true;/);
}

// ── Non-held: the evaluator moves them exactly as before ──────────────────────────────
{
  const a = mk("EVAL");
  S.updatePnlAndCheckExits(a, row(1.2), mgmt);
  S.updatePnlAndCheckExits(a, row(-0.8, -3), mgmt);
  assert.deepEqual([pos(a).mfe_pnl_pct, pos(a).mae_pnl_pct, pos(a).max_bins_below, pos(a).max_bins_above ?? 0], [1.2, -0.8, 3, 0]);
  assert.deepEqual(pos(a).pnl_tick_history, [1.2, -0.8]);
  assert.equal(S.noteHoldPathReading(a, row(40)), false, "not held → the hold path does nothing");
  assert.equal(pos(a).mfe_pnl_pct, 1.2);
  assert.equal(pos(a).ever_held ?? false, false);
  assert.deepEqual(S.holdRecordFields(pos(a)), { was_held: false, hold_peak_pnl_pct: null });
  S.recordClose(a, "test");
}

// ── Held: trusted readings advance the record fields, nothing exit-facing moves ───────
{
  const a = mk("HELD");
  S.confirmPeak(a, 1.23, 1);
  S.updatePnlAndCheckExits(a, row(1.23), mgmt);
  S.setPositionHold(a, true);
  assert.equal(pos(a).ever_held, true);
  const before = snap(a);
  assert.equal(S.updatePnlAndCheckExits(a, row(66), mgmt), null); // the evaluator skips a held position…
  assert.equal(pos(a).mfe_pnl_pct, 1.23);                         // …which is the freeze being fixed

  assert.equal(S.noteHoldPathReading(a, row(66.04, 130)), true);
  assert.equal(S.noteHoldPathReading(a, row(66.04, 130)), false, "an unchanged reading writes nothing (5 s poller)");
  assert.equal(S.noteHoldPathReading(a, row(20, 60)), false);      // inside the extremes: no write
  assert.equal(S.noteHoldPathReading(a, row(-12.5, -9)), true);
  assert.deepEqual([pos(a).mfe_pnl_pct, pos(a).mae_pnl_pct, pos(a).max_bins_below, pos(a).max_bins_above], [66.04, -12.5, 9, 30]);

  // untrusted readings: not management-ready, suspicious, wrong basis → nothing, bins included
  for (const over of [{ pnl_management_ready: false }, { pnl_pct_suspicious: true }, { pnl_basis: "usd" }]) {
    assert.equal(S.noteHoldPathReading(a, row(500, 400, over)), false);
    assert.equal(S.noteHoldPathReading(a, row(-90, -300, over)), false);
  }
  assert.equal(S.noteHoldPathReading(a, null), false);
  assert.equal(S.noteHoldPathReading("NOPE_" + Date.now(), row(5)), false);
  assert.deepEqual([pos(a).mfe_pnl_pct, pos(a).mae_pnl_pct, pos(a).max_bins_below, pos(a).max_bins_above], [66.04, -12.5, 9, 30]);

  // exit-facing fields are exactly as they were at the hold start
  assert.equal(snap(a), before);
  assert.equal(pos(a).peak_pnl_pct, 1.23);
  assert.deepEqual(pos(a).pnl_tick_history, [1.23]);

  // record fields: closed while held → the held high; released → was_held stays, no held high
  pos(a).hold_peak_pnl_pct = 64.9;
  assert.deepEqual(S.holdRecordFields(pos(a)), { was_held: true, hold_peak_pnl_pct: 64.9 });
  S.setPositionHold(a, false);
  assert.equal(pos(a).ever_held, true);
  assert.equal(pos(a).hold_resume_rebase, true); // the release re-base is untouched
  assert.deepEqual(S.holdRecordFields(pos(a)), { was_held: true, hold_peak_pnl_pct: null });
  // after the release the evaluator carries on from the held extremes, and re-bases the peak as before
  S.updatePnlAndCheckExits(a, row(3), mgmt);
  assert.equal(pos(a).peak_pnl_pct, 3);
  assert.equal(pos(a).mfe_pnl_pct, 66.04);
  S.recordClose(a, "test");
  // a position held before `ever_held` existed still reads as held while the hold lasts
  assert.deepEqual(S.holdRecordFields({ hold_mode: true }), { was_held: true, hold_peak_pnl_pct: null });
  assert.deepEqual(S.holdRecordFields(null), { was_held: false, hold_peak_pnl_pct: null });
}

// ── Wiring: both hold branches feed it; the three record sites carry the fields ───────
{
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.equal((idx.match(/noteHoldPathReading\(p\.position, p\)/g) || []).length, 2);
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.equal((dlmm.match(/\.\.\.holdRecordFields\((tracked|snapshot)\),/g) || []).length, 3);
  assert.equal((dlmm.match(/^\s+peak_pnl_pct: (tracked|snapshot)\.peak_pnl_pct \?\? null,\n\s+\.\.\.holdRecordFields/gm) || []).length, 3, "peak_pnl_pct in the record is unchanged");

  // No exit rule reads the record-only fields: every reference in the bot's runtime code is
  // the shared helper, the external-capital rescale of mfe, or a perf-record site.
  const runtime = ["index.js", "state.js", "tools/executor.js", "tools/pnl.js", "hold-thin-limit.js", "tvl-floor-exit.js", "crash-regime.js", "harvest-straddle.js", "valuation-jump.js"];
  for (const f of runtime) {
    const text = fs.readFileSync(new URL("../" + f, import.meta.url), "utf8");
    const hits = text.split("\n").filter((l) => /mfe_pnl_pct|mae_pnl_pct|max_bins_below|max_bins_above/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    if (f !== "state.js") { assert.equal(hits.length, 0, `${f} reads a path field: ${hits[0]}`); continue; }
    assert.equal(hits.length, 6, hits.join("\n")); // 4 in advancePathExtremes + 2 in the capital-change rescale
  }
}

console.log("OK — hold path tracking");
process.exit(0);
