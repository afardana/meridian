process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
import { repeatCountsAsFresh } from "../valuation-jump.js";
const { trackPosition, registerExitSignal, closeTrackedPosition, ensureStateInitialized } = await import("../state.js");
await ensureStateInitialized?.();

test("a repeated reading counts again only after the reconfirm window", () => {
  assert.equal(repeatCountsAsFresh({ lastFreshAt: 0, now: 5_000 }), false);
  assert.equal(repeatCountsAsFresh({ lastFreshAt: 0, now: 29_999 }), false);
  assert.equal(repeatCountsAsFresh({ lastFreshAt: 0, now: 30_000 }), true);
  assert.equal(repeatCountsAsFresh({ lastFreshAt: 0, now: 600_000, reconfirmMs: 0 }), false, "0 = never (old behaviour)");
  assert.equal(repeatCountsAsFresh({ lastFreshAt: undefined, now: 600_000 }), false, "no reference, no reconfirm");
});

// Mirrors assessValuation's freshness (index.js): a new key is fresh; a repeated key is
// fresh again once it has stood for the reconfirm window.
function freshness() {
  let last = null;
  return (key, now, reconfirmMs = 30_000) => {
    if (last && last.key === key) {
      if (repeatCountsAsFresh({ lastFreshAt: last.freshAt, now, reconfirmMs })) { last.freshAt = now; return true; }
      return false;
    }
    last = { key, freshAt: now };
    return true;
  };
}

// HIGGS-SOL 2026-10-05 00:48:55 → 00:50:50 (poller ticks, seconds from 00:48:55).
const HIGGS = [[0, -366, 1.92], [5, -366, 1.92], [20, -367, 1.62], [30, -367, 1.62], [35, -370, 0.74], [48, -370, 0.74], [50, -370, 0.74], [55, -370, 0.74], [60, -370, 0.74], [65, -370, 0.74], [75, -370, 0.74], [80, -370, 0.74], [90, -370, 0.74], [105, -370, 0.74], [113, -370, 0.74], [115, -372, 0.05]];
const THRESHOLD = 0.96; // peak 2.46 − 1.5

function firstFire(reconfirmMs, tag) {
  const P = `RECONF_${tag}_${Date.now()}`;
  trackPosition({ position: P, pool: "POOL_RC", pool_name: "HIGGS-SOL", strategy: "spot", amount_sol: 0.6, initial_value_usd: 0.6, bin_range: [-410, -341], active_bin: -364 });
  try {
    const isFresh = freshness();
    for (const [s, bin, pnl] of HIGGS) {
      const fresh = isFresh(`${pnl}|${bin}`, s * 1000, reconfirmMs);
      const r = registerExitSignal(P, pnl <= THRESHOLD ? "TRAILING_TP" : null, 2, { pnl }, { fresh });
      if (r.fire) return { s, pnl };
    }
    return null;
  } finally { try { closeTrackedPosition(P, "test"); } catch {} }
}

test("HIGGS-SOL: a breach that stands unchanged is confirmed after 30 s, before the dump", () => {
  assert.deepEqual(firstFire(30_000, "on"), { s: 65, pnl: 0.74 });
});

test("without reconfirmation the same breach waits for the next price move", () => {
  assert.deepEqual(firstFire(0, "off"), { s: 115, pnl: 0.05 });
});
