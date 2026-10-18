process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

// In-range rug velocity is measured from the trail's window HIGH to the current bin
// (2026-10-18). mucron-SOL EiEXT3Rk (operator, ◎2.33, adopted 20:30 WIB, in its profit grace
// so the stop loss was paused; range −549..−480, bin step 100) fell 52 bins in 45 s to −20 %
// after four flat minutes, and the first-to-last velocity over the 300 s trail stayed under
// 12 b/min — nothing armed.

import { test } from "node:test";
import assert from "node:assert/strict";

const { evaluateRugLatch, rugPersistConfig, inRangeRugHit, rugLatchReason } = await import("../rug-latch.js");
const { repeatCountsAsFresh } = await import("../valuation-jump.js");

const DETECTOR = { rugBinsPerMin: 12, rugMinBinsDropped: 10, rugMaxPnlPct: -3, rugWindowSec: 300, rugMinSpanSec: 60 };
const ENFORCE = rugPersistConfig({ ...DETECTOR, rugPersistMode: "enforce", rugPersistSec: 30, rugPersistRecoveryBins: 3 });

// The pre-2026-10-18 gate math (first-to-last over the whole trail), kept here only to show
// the miss on the same ticks.
function legacyFirstToLastHit(trail, { activeBin, lowerBin, pnlPct }, cfg) {
  if (activeBin < lowerBin || !(pnlPct <= cfg.rugMaxPnlPct) || trail.length < 2) return null;
  const first = trail[0], last = trail.at(-1);
  const spanSec = (last.t - first.t) / 1000;
  if (spanSec < cfg.rugMinSpanSec) return null;
  const binsDropped = first.bin - last.bin;
  if (binsDropped < cfg.rugMinBinsDropped) return null;
  const binsPerMin = binsDropped / (spanSec / 60);
  return binsPerMin >= cfg.rugBinsPerMin ? { rug: true, binsDropped, spanSec, binsPerMin } : null;
}

// index.js assessValuation: a distinct (pnl, bin) is fresh; an unchanged one again after 30 s.
function freshTracker(reconfirmMs = 30_000) {
  let key = null, freshAt = 0;
  return (t, bin, pnl) => {
    const k = `${pnl}|${bin}`;
    if (k !== key) { key = k; freshAt = t; return true; }
    if (repeatCountsAsFresh({ lastFreshAt: freshAt, now: t, reconfirmMs })) { freshAt = t; return true; }
    return false;
  };
}

// detectInRangeRug's trail (push, trim entries older than rugWindowSec) → inRangeRugHit →
// the latch, one reading per poller tick. rows: [ms, bin, pnl].
function replay(rows, lowerBin, { hitFn = inRangeRugHit, cfg = ENFORCE } = {}) {
  const trail = [];
  const fresh = freshTracker();
  let st = { latch: null, last_low: null };
  const out = [];
  for (const [t, bin, pnl] of rows) {
    trail.push({ t, bin });
    const cutoff = t - DETECTOR.rugWindowSec * 1000;
    while (trail.length && trail[0].t < cutoff) trail.shift();
    const hit = hitFn(trail, { activeBin: bin, lowerBin, pnlPct: pnl }, DETECTOR);
    const r = evaluateRugLatch(st, { bin, pnl, fresh: fresh(t, bin, pnl), suspect: false, hit }, cfg, t);
    out.push({ t, bin, pnl, hit, action: r.action, r });
    st = r.state;
  }
  return out;
}

// ── mucron-SOL EiEXT3Rk, 2026-10-18 21:06:18 → 21:12:23 WIB (14:06:18Z), poller every 5 s ──
const WIB = (hms) => Date.parse(`2026-10-18T${hms}+07:00`);
const MUCRON_LOWER = -549;
function mucronTicks() {
  const rows = [
    ["21:06:18", -491, 3.7], ["21:06:23", -494, 3.3], ["21:06:28", -496, 3.05], ["21:06:33", -497, 2.9],
  ];
  // flat stretch at −498 / −499 up to the last −498 at 21:10:38 (+2.71 %)
  for (let t = WIB("21:06:38"); t < WIB("21:10:38"); t += 5000) {
    const odd = ((t - WIB("21:06:38")) / 5000) % 2 === 1;
    rows.push([t, odd ? -499 : -498, odd ? 2.62 : 2.71]);
  }
  rows.push(
    ["21:10:38", -498, 2.71], ["21:10:43", -504, 0.6], ["21:10:48", -512, -1.5], ["21:10:53", -518, -3.37],
    ["21:10:58", -519, -3.7], ["21:11:03", -519, -3.7], ["21:11:08", -518, -3.4], ["21:11:13", -523, -5.4],
    ["21:11:18", -535, -11.5], ["21:11:23", -550, -20.7], ["21:11:28", -549, -20.2], ["21:11:33", -549, -20.0],
    ["21:11:38", -549, -19.8], ["21:11:43", -550, -20.4], ["21:11:48", -549, -19.9], ["21:11:53", -549, -19.6],
    ["21:11:58", -550, -20.1], ["21:12:03", -549, -19.4], ["21:12:08", -549, -19.2], ["21:12:13", -550, -19.9],
    ["21:12:18", -551, -21.0], ["21:12:23", -553, -22.0],
  );
  return rows.map(([t, bin, pnl]) => [typeof t === "number" ? t : WIB(t), bin, pnl]);
}

test("mucron-SOL 10-18: first-to-last never hits on these ticks (the miss as it happened)", () => {
  const out = replay(mucronTicks(), MUCRON_LOWER, { hitFn: legacyFirstToLastHit });
  assert.equal(out.filter((x) => x.hit).length, 0);
  assert.ok(out.every((x) => x.action === "none"));
  // the diluted readings: 44 bins / 300 s at 21:11:18
  const at1118 = out.find((x) => x.t === WIB("21:11:18"));
  assert.equal(at1118.bin, -535);
});

test("mucron-SOL 10-18: from the window high the detector hits at 21:11:38 (51 bins / 60 s), the latch arms, holds and fires 30 s later", () => {
  const out = replay(mucronTicks(), MUCRON_LOWER);
  const firstHit = out.find((x) => x.hit);
  assert.equal(firstHit.t, WIB("21:11:38"), "no hit before 21:11:38");
  assert.ok(out.filter((x) => x.t < WIB("21:11:38")).every((x) => x.hit == null && x.action === "none"));
  // 21:11:18 (high −491 still in the window): 44 bins over 300 s = 8.8 b/min — still no hit
  // 21:11:23: one bin below the range (gate 1); 21:11:28 / :33: 50 / 55 s since the high (< 60 s)
  for (const hms of ["21:11:18", "21:11:23", "21:11:28", "21:11:33"]) assert.equal(out.find((x) => x.t === WIB(hms)).hit, null, hms);

  const h = firstHit.hit;
  assert.equal(h.highBin, -498);
  assert.equal(h.binsDropped, 51);
  assert.equal(h.spanSec, 60);
  assert.equal(h.binsPerMin, 51);
  assert.equal(h.reason, "in-range rug 51 bins/60s from the window high -498 (51.0 b/min ≥ 12, pnl -19.80% ≤ -3%)");
  assert.equal(firstHit.action, "arm");
  assert.equal(firstHit.r.state.latch.low_bin, -549);
  assert.equal(firstHit.r.state.latch.fire_pnl_pct, -19.8);

  const after = out.filter((x) => x.t > WIB("21:11:38"));
  assert.equal(after.filter((x) => x.action === "cancel").length, 0, "the bin never recovers 3 above its low");
  const fire = after.find((x) => x.action === "fire");
  assert.ok(fire, "the latch fires");
  assert.equal(fire.t, WIB("21:12:08"));
  assert.ok(fire.r.elapsedSec >= 30);
  assert.equal(fire.pnl, -19.2);
  assert.ok(after.filter((x) => x.t < fire.t).every((x) => x.action === "hold"));
  const reason = rugLatchReason(fire.r.state.latch, { elapsedSec: fire.r.elapsedSec, pnl: fire.pnl, bin: fire.bin, recoveryBins: 3 });
  assert.equal(reason, "In-range rug (latched 30s): 51 bins/60s from the window high -498 (51.0 b/min ≥ 12, pnl -19.80% ≤ -3%); " +
    "armed at pnl -19.80%, now -19.20% at bin -549 (low -550), 7 valuations, no 3-bin recovery");
});

test("the span is counted from the MOST RECENT touch of the high", () => {
  const T = WIB("12:00:00");
  // high −500 at 0 s and again at 40 s, then −520 at 80 s: 20 bins in 40 s since the last touch (< 60 s)
  const trail = [{ t: T, bin: -500 }, { t: T + 40_000, bin: -500 }, { t: T + 80_000, bin: -520 }];
  assert.equal(inRangeRugHit(trail, { activeBin: -520, lowerBin: -560, pnlPct: -6 }, DETECTOR), null);
  // the same drop measured from the first touch would have passed (20 bins / 80 s = 15 b/min)
  const once = [{ t: T, bin: -500 }, { t: T + 40_000, bin: -501 }, { t: T + 80_000, bin: -520 }];
  const h = inRangeRugHit(once, { activeBin: -520, lowerBin: -560, pnlPct: -6 }, DETECTOR);
  assert.equal(h.binsDropped, 20);
  assert.equal(h.spanSec, 80);
  assert.equal(h.binsPerMin, 15);
});

test("flat, then a slow grind of 10 bins over 5 minutes at pnl ≤ −3 %: no hit", () => {
  const T = WIB("12:00:00");
  const rows = [];
  for (let s = 0; s < 120; s += 5) rows.push([T + s * 1000, -500, -3.5]);
  for (let s = 0; s <= 300; s += 5) rows.push([T + (120 + s) * 1000, -500 - Math.floor(s / 30), -3.5 - s / 100]);
  const out = replay(rows, -560);
  assert.equal(rows.at(-1)[1], -510);
  assert.equal(out.filter((x) => x.hit).length, 0);
  assert.ok(out.every((x) => x.action === "none"));
});

test("a sharp drop arms, a 3-bin recovery from the low cancels, the same low does not re-arm", () => {
  const T = WIB("12:00:00");
  const rows = [];
  for (let s = 0; s < 120; s += 5) rows.push([T + s * 1000, -500, 1.0]);
  // 30 bins in 60 s
  for (let s = 5; s <= 60; s += 5) rows.push([T + (115 + s) * 1000, -500 - s / 2, 1 - s * 0.15]);
  rows.push([T + 180_000, -530, -8.0], [T + 185_000, -527, -6.6], [T + 190_000, -529, -7.5], [T + 195_000, -530, -8.0]);
  const out = replay(rows, -560);
  const actions = out.filter((x) => x.action !== "none").map((x) => [(x.t - T) / 1000, x.action]);
  assert.deepEqual(actions, [[175, "arm"], [180, "hold"], [185, "cancel"]]);
  const arm = out.find((x) => x.action === "arm");
  assert.equal(arm.hit.binsDropped, 30);
  assert.equal(arm.hit.spanSec, 60);
  assert.equal(out.find((x) => x.action === "cancel").r.recovered, 3);
  // the detector still hits at 190 / 195 s (from the window high) but −530 is not a new low
  const late = out.filter((x) => x.t >= T + 190_000);
  assert.ok(late.every((x) => x.hit && x.action === "none" && x.r.blocked === true));
});
