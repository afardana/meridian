process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { createCrashRegimeState, evaluateCrashRegime, isCalmEligible, formatCrashRegimeReason } = await import("../crash-regime.js");
const CFG = {};
const CALM = { volatility: 2.1, entry_tvl: 180_000, token_age_hours: 400 };

// Feed a series of 5 s observations; returns the first result that fires.
function run(profile, path, lower = -600, cfg = CFG) {
  const st = createCrashRegimeState();
  let t = 0, last = null;
  for (const [bin, pnl] of path) {
    t += 5000;
    last = evaluateCrashRegime(st, { t, bin, pnl, lower, fresh: true }, profile, cfg);
    if (last.fire) return { ...last, t };
  }
  return { ...last, t, fire: false };
}
const quiet = (n, bin = -560, pnl = 0.5) => Array.from({ length: n }, (_, i) => [bin - (i % 2), pnl]);

test("eligibility: fresh, thin or volatile pairs are never calm; unknown values do not disqualify", () => {
  assert.equal(isCalmEligible(CALM), true);
  assert.equal(isCalmEligible({ volatility: 7.5, entry_tvl: 24_000 }), false); // P(DOOM)-SOL
  assert.equal(isCalmEligible({ volatility: 2, entry_tvl: 30_000 }), false);
  assert.equal(isCalmEligible({ volatility: 2, entry_tvl: 200_000, token_age_hours: 3 }), false);
  assert.equal(isCalmEligible({}), true);
});

test("no noise history yet → prior 6 → noisy regime, never fires", () => {
  const r = run(CALM, [...quiet(10), [-575, -4], [-585, -6], [-595, -9], [-605, -12], [-615, -14]]);
  assert.equal(r.fire, false);
  assert.equal(r.regime, "noisy");
});

test("calm pair: a break through the edge fires on 2 distinct valuations below the range", () => {
  // 30 min of quiet history (noise p95 ≈ 1) then a steady slide through the lower edge
  const slide = [];
  for (let b = -562; b >= -612; b -= 2) slide.push([b, b >= -600 ? -1 - (-562 - b) * 0.04 : -4 - (-600 - b) * 0.8]); // pnl stays above −3 until the edge
  const r = run(CALM, [...quiet(380), ...slide]);
  assert.equal(r.fire, true);
  assert.equal(r.regime, "calm");
  assert.equal(r.where, "below");
  assert.ok(r.V >= 6 && r.D >= 3);
  assert.match(formatCrashRegimeReason(r, -600, -605), /^crash-below \(calm regime\)/);
});

test("crashRegimeViolentPersistSec=0: a violent in-range drop fires on the first confirming valuation (pre-2026-09-30)", () => {
  const r = run(CALM, [...quiet(380), [-560, -1], [-575, -3.5], [-590, -7]], -600, { crashRegimeViolentPersistSec: 0 });
  assert.equal(r.fire, true);
  assert.equal(r.where, "in-range");
  assert.equal(r.violent, true);
  assert.match(formatCrashRegimeReason(r, -600, -590), /^in-range rug \(calm regime\)/);
});

test("SI-SOL 2026-09-30: a violent wick that bounces within 30 s does not fire", () => {
  // 58 bins in ~40 s, pnl −5 at the bottom, then half the drop back and pnl above −3
  const r = run(CALM, [...quiet(380), [-562, -0.5], [-580, -1.9], [-600, -5.05], [-590, -3.2], [-578, -1.6], [-575, -1.2], [-573, -1], [-572, -1], [-570, -0.8]]);
  assert.equal(r.fire, false);
});

test("a violent drop that holds for 30 s fires, and the reason says how long it held", () => {
  const down = Array.from({ length: 8 }, (_, i) => [-590 - (i % 2), -7 - i * 0.1]);
  const r = run(CALM, [...quiet(380), [-560, -1], [-575, -3.5], ...down]);
  assert.equal(r.fire, true);
  assert.equal(r.violent, true);
  assert.ok(r.persistingFor >= 30, `held ${r.persistingFor} s`);
  assert.match(formatCrashRegimeReason(r, -600, -590), /violent \(≥2× threshold, held \d+ s\)/);
});

test("slow grinds keep the 2-valuation confirm (not delayed by the violent persistence)", () => {
  const grind = [];
  for (let b = -562; b >= -586; b -= 1) { const pnl = -0.5 - (-562 - b) * 0.2; grind.push([b, pnl], [b, pnl - 0.01]); } // 6 b/min
  const r = run(CALM, [...quiet(380), ...grind]);
  assert.equal(r.fire, true);
  assert.equal(r.violent, false);
});

test("the same path on a P(DOOM)-class pair stays with the live detectors", () => {
  const r = run({ volatility: 7.5, entry_tvl: 24_000 }, [...quiet(380), [-560, -1], [-575, -3.5], [-590, -7], [-605, -12], [-615, -15]]);
  assert.equal(r.fire, false);
  assert.equal(r.regime, "noisy");
});

test("a profitable dip never fires in range (pnl gate)", () => {
  const r = run(CALM, [...quiet(380), [-560, 2], [-575, 1.5], [-590, 0.5]]);
  assert.equal(r.fire, false);
});

test("poller wiring: shadow by default, enforce closes through the crash path, held positions skipped by the socket twin", () => {
  const index = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const config = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(config, /crashRegimeMode:\s+u\.crashRegimeMode\s+\?\? "shadow"/);
  assert.match(config, /crashRegimeViolentPersistSec: u\.crashRegimeViolentPersistSec \?\? 30/);
  assert.match(index, /\[CRASH_REGIME_SHADOW\] would-close/);
  assert.match(index, /actMode === "enforce"[\s\S]{0,120}_crashFired\.add\(p\.position\)[\s\S]{0,200}rule: "crash"/);
  assert.match(index, /p\.pool === poolAddress && p\.hold_mode !== true/);
  const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exec, /if \(!urgent && maxImpact > 0/);
  assert.equal((exec.match(/"after close", \{ urgent: args\.urgent === true \}/g) || []).length, 2);
});

test("below-range half is log-only unless crashRegimeBelowMode=enforce (e/acc-SOL 2026-09-29)", () => {
  const index = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const config = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(config, /crashRegimeBelowMode:\s+u\.crashRegimeBelowMode\s+\?\? "shadow"/);
  assert.match(exec, /crashRegimeBelowMode: \["management", "crashRegimeBelowMode"\]/);
  // mode resolution: below-range fires use the below mode; in-range fires keep crashRegimeMode
  const src = index.slice(index.indexOf('const belowMode = String('), index.indexOf('if (actMode === "enforce")'));
  const resolve = new Function("r", "belowMode", "regimeMode", `${src.slice(src.indexOf("const actMode"), src.indexOf("if (r.fire"))} return actMode;`);
  assert.equal(resolve({ where: "below" }, "shadow", "enforce"), "shadow");
  assert.equal(resolve({ where: "below" }, "off", "enforce"), "off");
  assert.equal(resolve({ where: "below" }, "enforce", "enforce"), "enforce");
  assert.equal(resolve({ where: "in-range" }, "shadow", "enforce"), "enforce");
  assert.equal(resolve({ where: "in-range" }, "shadow", "shadow"), "shadow");
});
