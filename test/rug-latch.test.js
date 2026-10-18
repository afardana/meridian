process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { evaluateRugLatch, rugPersistConfig, inRangeRugHit, advanceRugLatchSummary, rugLatchRecordFields, rugLatchReason } = await import("../rug-latch.js");
const { repeatCountsAsFresh } = await import("../valuation-jump.js");

const DETECTOR = { rugBinsPerMin: 12, rugMinBinsDropped: 10, rugMaxPnlPct: -3, rugWindowSec: 300, rugMinSpanSec: 60 };
const ENFORCE = rugPersistConfig({ ...DETECTOR, rugPersistMode: "enforce", rugPersistSec: 30, rugPersistRecoveryBins: 3 });
const T0 = Date.parse("2026-10-16T01:23:00Z");
const HIT = { rug: true, reason: "in-range rug 35 bins/115s (18.3 b/min ≥ 12, pnl -8.92% ≤ -3%)" };

// Same freshness rule as index.js assessValuation: a distinct (pnl, bin) is fresh; an
// unchanged one counts again once it has stood `reconfirmMs` (valuationReconfirmSec).
function freshTracker(reconfirmMs = 30_000) {
  let key = null, freshAt = 0;
  return (t, bin, pnl) => {
    const k = `${pnl}|${bin}`;
    if (k !== key) { key = k; freshAt = t; return true; }
    if (repeatCountsAsFresh({ lastFreshAt: freshAt, now: t, reconfirmMs })) { freshAt = t; return true; }
    return false;
  };
}

// Feed [secSinceT0, bin, pnl, hit?] readings through one latch; returns every action.
function drive(rows, { cfg = ENFORCE, reconfirmMs = 30_000, state = { latch: null, last_low: null } } = {}) {
  const fresh = freshTracker(reconfirmMs);
  const out = [];
  let st = state;
  for (const [sec, bin, pnl, hit = false, suspect = false] of rows) {
    const t = T0 + sec * 1000;
    const r = evaluateRugLatch(st, { bin, pnl, fresh: fresh(t, bin, pnl), suspect, hit: hit ? HIT : null }, cfg, t);
    out.push({ sec, action: r.action, r });
    st = r.state;
  }
  return { out, state: st, actions: out.map((x) => `${x.sec}:${x.action}`) };
}
const firstOf = (d, action) => d.out.find((x) => x.action === action);

test("config: defaults enforce / 30 s / 3 bins; floors 5 s and 1 bin; an unknown mode reads as enforce (no shadow)", () => {
  assert.deepEqual(rugPersistConfig({}), { mode: "enforce", persistSec: 30, recoveryBins: 3, maxPnlPct: -3, windowSec: 300 });
  const c = rugPersistConfig({ rugPersistMode: "shadow", rugPersistSec: 2, rugPersistRecoveryBins: 0, rugMaxPnlPct: -4, rugWindowSec: 120 });
  assert.deepEqual(c, { mode: "enforce", persistSec: 5, recoveryBins: 1, maxPnlPct: -4, windowSec: 120 });
  assert.equal(rugPersistConfig({ rugPersistMode: "off" }).mode, "off");
});

test("arm → bounce 3 bins → cancel → no re-arm at the same low → re-arm at a new low", () => {
  const d = drive([
    [0, -454, -6.4, true],   // detector hit: arm at -454
    [5, -460, -8.9, true],   // new low, still latched
    [10, -457, -7.6, true],  // 3 above the low -460 → cancel
    [15, -460, -8.9, true],  // hit at the SAME low: not re-armed
    [20, -459, -8.5, true],
    [25, -461, -9.3, true],  // a new low below -460 → re-arm
  ]);
  assert.deepEqual(d.actions, ["0:arm", "5:hold", "10:cancel", "15:none", "20:none", "25:arm"]);
  assert.equal(firstOf(d, "cancel").r.recovered, 3);
  assert.equal(firstOf(d, "cancel").r.state.last_low, -460);
  assert.equal(d.out[3].r.blocked, true);
  assert.equal(d.state.latch.low_bin, -461);
  assert.equal(d.state.latch.valuations, 1);
  // a bounce of 2 bins is not a recovery
  const d2 = drive([[0, -454, -6.4, true], [5, -460, -8.9], [10, -458, -8.1]]);
  assert.deepEqual(d2.actions, ["0:arm", "5:hold", "10:hold"]);
});

test("arm → fires on a fresh valuation ≥ 30 s after arming with pnl ≤ −3 % and ≥ 2 distinct valuations", () => {
  const d = drive([
    [0, -454, -6.4, true],
    [10, -458, -7.9],
    [20, -460, -8.9],
    [29, -461, -9.2],        // fresh, 3 valuations, but only 29 s
    [34, -462, -9.6],        // 34 s → fire
  ]);
  assert.deepEqual(d.actions, ["0:arm", "10:hold", "20:hold", "29:hold", "34:fire"]);
  const f = firstOf(d, "fire").r;
  assert.equal(f.state.latch.valuations, 5);
  assert.equal(f.state.latch.low_bin, -462);
  assert.equal(f.state.latch.fire_pnl_pct, -6.4);
  // the latch stays on a fire (a failed close fires again on the next fresh valuation)
  assert.ok(f.state.latch);
  const reason = rugLatchReason(f.state.latch, { elapsedSec: f.elapsedSec, pnl: -9.6, bin: -462, recoveryBins: 3 });
  assert.match(reason, /^In-range rug \(latched 34s\): 35 bins\/115s/);
  assert.match(reason, /armed at pnl -6\.40%, now -9\.60% at bin -462 \(low -462\), 5 valuations, no 3-bin recovery/);

  // pnl back above rugMaxPnlPct (without a 3-bin bounce): held, not fired
  const d2 = drive([[0, -454, -6.4, true], [10, -455, -3.1], [35, -455, -2.8], [40, -456, -2.9]]);
  assert.deepEqual(d2.actions, ["0:arm", "10:hold", "35:hold", "40:hold"]);
  // a stale reading never fires, even past 30 s
  const d3 = drive([[0, -454, -6.4, true], [31, -454, -6.4]], { reconfirmMs: 0 });
  assert.deepEqual(d3.actions, ["0:arm", "31:hold"]);
});

test("an unchanged reading counts as a second valuation only after valuationReconfirmSec", () => {
  const rows = [[0, -460, -8.9, true], ...Array.from({ length: 12 }, (_, i) => [5 * (i + 1), -460, -8.9])];
  // reconfirm 30 s: the repeats at 5…25 s count nothing; the one standing 30 s counts → fire at 30 s
  const d = drive(rows, { reconfirmMs: 30_000 });
  assert.equal(firstOf(d, "fire").sec, 30);
  assert.equal(firstOf(d, "fire").r.state.latch.valuations, 2);
  assert.ok(d.out.slice(1, 6).every((x) => x.action === "hold" && x.r.state.latch.valuations === 1));
  // reconfirm 45 s: nothing counts until 45 s, so the 30 s mark passes with one valuation
  const d45 = drive(rows, { reconfirmMs: 45_000 });
  assert.equal(firstOf(d45, "fire").sec, 45);
  // reconfirm off (0): a quiet pool never confirms; the latch expires instead
  const quiet = [[0, -460, -8.9, true], ...Array.from({ length: 62 }, (_, i) => [5 * (i + 1), -460, -8.9])];
  const d0 = drive(quiet, { reconfirmMs: 0 });
  assert.equal(firstOf(d0, "fire"), undefined);
  assert.equal(firstOf(d0, "expire").sec, 305);
});

test("a latch older than rugWindowSec without a fire expires once; it re-arms only at a new low", () => {
  const rows = [[0, -454, -6.4, true]];
  for (let s = 10; s <= 300; s += 10) rows.push([s, -455 + (s / 10) % 2, -2.6 - ((s / 10) % 2) * 0.01]); // pnl above −3, ±1 bin
  rows.push([305, -455, -2.6], [310, -455, -4.0, true], [315, -456, -4.4, true]);
  const d = drive(rows);
  const exp = d.out.filter((x) => x.action === "expire");
  assert.equal(exp.length, 1);
  assert.equal(exp[0].sec, 305);
  assert.equal(exp[0].r.state.last_low, -455);
  assert.equal(d.out.find((x) => x.sec === 310).action, "none"); // hit at the expired low
  assert.equal(d.out.find((x) => x.sec === 315).action, "arm");  // -456 < -455
});

test("a suspect reading neither counts, moves the low nor cancels", () => {
  const d = drive([
    [0, -454, -6.4, true],
    [10, -440, -2.0, false, true], // suspect: would be a 14-bin recovery
    [20, -470, -12, false, true],  // suspect: would be a new low
    [25, -455, -7.0],
  ]);
  assert.deepEqual(d.actions, ["0:arm", "10:none", "20:none", "25:hold"]);
  assert.equal(d.state.latch.low_bin, -455);
  assert.equal(d.state.latch.valuations, 2);
  // …but the suspect reading never arms either
  const d2 = drive([[0, -454, -6.4, true, true]]);
  assert.deepEqual(d2.actions, ["0:none"]);
});

test("rugPersistMode=off: a hit fires at once (the caller keeps crashConfirmTicks) and any latch is dropped", () => {
  const off = rugPersistConfig({ rugPersistMode: "off" });
  const r = evaluateRugLatch({ latch: { armed_at: new Date(T0).toISOString(), low_bin: -460, valuations: 1 }, last_low: -470 }, { bin: -455, pnl: -7, fresh: true, hit: HIT }, off, T0 + 1000);
  assert.equal(r.action, "fire");
  assert.equal(r.immediate, true);
  assert.deepEqual(r.state, { latch: null, last_low: null });
  assert.equal(evaluateRugLatch({ latch: null, last_low: null }, { bin: -455, pnl: -7, fresh: true, hit: null }, off, T0).action, "none");
});

test("summary + perf-record fields: armed / cancelled / expired counts and the PnL at the last arm", () => {
  let s = null;
  s = advanceRugLatchSummary(s, "hold", null, T0);
  assert.equal(s, null);
  s = advanceRugLatchSummary(s, "arm", { armed_at: "2026-10-16T01:23:14.000Z", fire_pnl_pct: -6.38 }, T0);
  s = advanceRugLatchSummary(s, "cancel", null, T0);
  s = advanceRugLatchSummary(s, "arm", { armed_at: "2026-10-16T01:30:00.000Z", fire_pnl_pct: -9.1 }, T0);
  s = advanceRugLatchSummary(s, "fire", null, T0);
  assert.deepEqual(rugLatchRecordFields({ rug_latch_summary: s }), {
    rug_latch: { armed_at: "2026-10-16T01:30:00.000Z", fire_pnl_pct: -9.1, armed_count: 2, cancelled_count: 1, expired_count: 0, fired_at: new Date(T0).toISOString() },
  });
  assert.deepEqual(rugLatchRecordFields({}), { rug_latch: null });
});

// ── FTR-SOL 8R28PAPj, 2026-10-16 08:23 WIB: the case the latch was built for ──────────────
// The pre-2026-10-18 gate math (velocity first-to-last over the whole trail) — the math that
// produced the logged FTR close; since 10-18 inRangeRugHit measures from the window high.
function legacyFirstToLastHit(trail, { activeBin, lowerBin, pnlPct }, cfg) {
  if (activeBin < lowerBin || !(pnlPct <= cfg.rugMaxPnlPct) || trail.length < 2) return null;
  const first = trail[0], last = trail.at(-1);
  const spanSec = (last.t - first.t) / 1000;
  if (spanSec < cfg.rugMinSpanSec) return null;
  const binsDropped = first.bin - last.bin;
  if (binsDropped < cfg.rugMinBinsDropped) return null;
  const binsPerMin = binsDropped / (spanSec / 60);
  if (binsPerMin < cfg.rugBinsPerMin) return null;
  return { rug: true, reason: `in-range rug ${binsDropped} bins/${spanSec.toFixed(0)}s (${binsPerMin.toFixed(1)} b/min ≥ ${cfg.rugBinsPerMin}, pnl ${pnlPct.toFixed(2)}% ≤ ${cfg.rugMaxPnlPct}%)` };
}

test("FTR-SOL 10-16 replay: the live rule fires at −8.92 % (as logged); the latch arms, cancels on the bounce and never fires", () => {
  const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/rug-latch-ftr.json", import.meta.url), "utf8"));
  const F = Date.parse(fx.fire_at);
  const replay = (mode, hitFn = inRangeRugHit) => {
    const cfg = rugPersistConfig({ ...DETECTOR, rugPersistMode: mode });
    const fresh = freshTracker(30_000);
    const trail = [];
    let st = { latch: null, last_low: null }, liveCount = 0;
    const events = [];
    for (const [dt, bin, pnl] of fx.ticks) {
      const t = F + dt;
      // detectInRangeRug: own trail, window trim, then the shared gate math
      trail.push({ t, bin });
      while (trail.length && trail[0].t < t - DETECTOR.rugWindowSec * 1000) trail.shift();
      const hit = hitFn(trail, { activeBin: bin, lowerBin: fx.lower_bin, pnlPct: pnl }, DETECTOR);
      const f = fresh(t, bin, pnl);
      const r = evaluateRugLatch(st, { bin, pnl, fresh: f, suspect: false, hit }, cfg, t);
      st = r.state;
      if (mode === "off") {
        // the pre-latch close: crashConfirmTicks (3) distinct valuations of the signal
        if (r.action === "fire") { if (f) liveCount++; } else liveCount = 0;
        if (liveCount >= 3) { events.push({ dt, action: "close", bin, pnl, reason: hit.reason }); break; }
      } else if (r.action !== "none" && r.action !== "hold") {
        events.push({ dt, action: r.action, bin, pnl, latch: r.state.latch, last_low: r.state.last_low });
        if (r.action === "fire") break;
      }
    }
    return events;
  };

  // the fixture reproduces the logged close under the math that produced it
  const live = replay("off", legacyFirstToLastHit);
  assert.equal(live.length, 1);
  assert.equal(Math.round(live[0].dt / 1000), 0);
  assert.equal(live[0].pnl, fx.recorded_pnl_pct); // −8.92 %, the recorded close
  assert.match(live[0].reason, /^in-range rug 35 bins\/115s \(18\.3 b\/min/); // the logged reason
  // pre-10-18 latch: armed at −454 / −6.38 % 10 s before the live close, cancelled 5 s after it
  const legacyLatched = replay("enforce", legacyFirstToLastHit);
  assert.deepEqual(legacyLatched.map((e) => [Math.round(e.dt / 1000), e.action]), [[-10, "arm"], [5, "cancel"]]);
  assert.equal(legacyLatched[0].bin, -454);
  assert.equal(legacyLatched[0].pnl, -6.38);

  // velocity from the window high (2026-10-18): the high −416 was last touched 65 s before the
  // live close, so the first hit is at the close's own reading (44 bins / 65 s) — at −4.98 s
  // only 59.97 s had passed since the high. The immediate rule would close at +10 s (−7.00 %).
  const offNow = replay("off");
  assert.equal(Math.round(offNow[0].dt / 1000), 10);
  assert.equal(offNow[0].pnl, -7);

  const latched = replay("enforce");
  assert.deepEqual(latched.map((e) => [Math.round(e.dt / 1000), e.action]), [[0, "arm"], [5, "cancel"]]);
  assert.equal(latched[0].bin, -460);
  assert.equal(latched[0].pnl, -8.92);
  assert.equal(latched[0].latch.reason, "in-range rug 44 bins/65s from the window high -416 (40.6 b/min ≥ 12, pnl -8.92% ≤ -3%)");
  assert.equal(latched[1].last_low, -460);
  assert.equal(latched[1].bin, -456); // the pool's first poller reading after the close (−459 → −455 within 5 s)
  // 15 minutes of replayed path: no new low below −460, so no re-arm and no close
  const span = fx.ticks.at(-1)[0];
  assert.ok(span >= 15 * 60_000 - 5_000, `fixture covers ${span} ms`);
  assert.ok(Math.min(...fx.ticks.filter(([dt]) => dt > 1000).map(([, b]) => b)) > -460);
});

// ── state.js: the latch lives on the position; hold and close drop it; summary reaches the record ──
test("state: noteRugLatchReading arms / cancels on the position, hold and close clear it, the summary stays", async () => {
  const S = await import("../state.js");
  await S.ensureStateInitialized();
  const mk = (tag) => {
    const a = `TEST_RUG_LATCH_${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    S.trackPosition({ position: a, pool: "POOL_RL_" + tag, pool_name: tag + "-SOL", amount_sol: 1, strategy: "spot", bin_range: [-484, -415], active_bin: -440 });
    return a;
  };
  const mgmt = { ...DETECTOR, rugPersistMode: "enforce" };

  const a = mk("ARM");
  assert.equal(S.noteRugLatchReading(a, { bin: -454, pnl: -6.4, fresh: true, hit: HIT }, mgmt, T0).action, "arm");
  let p = S.getTrackedPosition(a);
  assert.equal(p.rug_latch.low_bin, -454);
  assert.equal(p.rug_latch_summary.armed_count, 1);
  assert.equal(S.noteRugLatchReading(a, { bin: -451, pnl: -5.2, fresh: true, hit: null }, mgmt, T0 + 5000).action, "cancel");
  p = S.getTrackedPosition(a);
  assert.equal(p.rug_latch, null);
  assert.equal(p.rug_latch_last_low, -454);
  assert.equal(p.rug_latch_summary.cancelled_count, 1);
  assert.equal(S.noteRugLatchReading(a, { bin: -455, pnl: -6.9, fresh: true, hit: HIT }, mgmt, T0 + 10_000).action, "arm");
  // hold drops the latch (no exit rule runs on a held position); held readings are ignored
  S.setPositionHold(a, true, "test");
  p = S.getTrackedPosition(a);
  assert.equal(p.rug_latch, null);
  assert.equal(p.rug_latch_last_low, null);
  assert.equal(S.noteRugLatchReading(a, { bin: -470, pnl: -12, fresh: true, hit: HIT }, mgmt, T0 + 15_000), null);
  assert.deepEqual(rugLatchRecordFields(p).rug_latch, { armed_at: new Date(T0 + 10_000).toISOString(), fire_pnl_pct: -6.9, armed_count: 2, cancelled_count: 1, expired_count: 0, fired_at: null });

  const b = mk("CLOSE");
  S.noteRugLatchReading(b, { bin: -454, pnl: -6.4, fresh: true, hit: HIT }, mgmt, T0);
  assert.ok(S.getTrackedPosition(b).rug_latch);
  S.recordClose(b, "test close");
  assert.equal(S.getTrackedPosition(b).rug_latch, null);
  assert.equal(S.getTrackedPosition(b).rug_latch_summary.armed_count, 1);

  const c = mk("OFF");
  S.noteRugLatchReading(c, { bin: -454, pnl: -6.4, fresh: true, hit: HIT }, mgmt, T0);
  assert.equal(S.clearRugLatch(c), true);
  assert.equal(S.getTrackedPosition(c).rug_latch, null);
  assert.equal(S.clearRugLatch(c), false);
});

// ── wiring (index.js / tools/dlmm.js / config): the shapes the live close depends on ──────
test("wiring: latched fire closes through RUG_FASTPATH with confirm_ticks 1; off keeps crashConfirmTicks; three record sites", () => {
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /return inRangeRugHit\(trail, \{ activeBin, lowerBin, pnlPct \}, cfg\);/);
  assert.match(idx, /if \(rug\) exit = finalizeExit\(\{ action: "RUG_FASTPATH", rule: "crash", reason: rug\.reason, urgent: true, confirm_ticks: Math\.max\(1, Number\(config\.management\.crashConfirmTicks \?\? 3\)\) \}\);/);
  assert.match(idx, /exit = finalizeExit\(\{ action: "RUG_FASTPATH", rule: "crash", reason, urgent: true, confirm_ticks: 1 \}\);/);
  assert.match(idx, /fresh: valuation\.fresh, suspect: valuation\.suspect, hit: rug/);
  for (const tag of ["armed", "cancelled", "expired", "fired"]) assert.match(idx, new RegExp(`\\[RUG_PERSIST\\] ${tag} `));
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.equal((dlmm.match(/\.\.\.rugLatchRecordFields\(/g) || []).length, 3);
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  for (const k of ["rugPersistMode", "rugPersistSec", "rugPersistRecoveryBins"]) assert.match(exe, new RegExp(`${k}: \\["management", "${k}"\\]`));
});

test("config.js: management carries rugPersistMode enforce / 30 / 3 by default", async () => {
  const { config } = await import("../config.js");
  assert.ok(["off", "enforce"].includes(config.management.rugPersistMode));
  assert.ok(config.management.rugPersistSec >= 5);
  assert.ok(config.management.rugPersistRecoveryBins >= 1);
});
