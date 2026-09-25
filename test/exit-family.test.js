process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const { exitFamilyFromReason, classifyOutcome } = await import("../lessons.js");

test("exit families are derived from the canonical reason prefixes", () => {
  const cases = {
    "Round-trip complete: 5 bins above range, pnl frozen at 2.90% across 6 ticks": "harvest",
    "pumped far above range: active bin -275 is 54 bins past upper -329 (trigger 50)": "oor_above",
    "pumped above range with an unfilled ladder: active bin -5 is 26 bins past upper -31 (trigger 25, pnl 0.12% < 1%)": "oor_above_unfilled",
    "Toxic conversion: Position is 92.0% converted to base token within 8m": "toxic_conversion",
    "Dynamic fee collapsed 89.2% (peak 1.6875% → current 0.1828%) at age 75m": "surge_decay",
    "Fee/TVL yield collapsed 66.6% (peak 15.65% → current 5.23%) at age 15m": "surge_decay",
    "Low yield: fee/TVL 0.08% < min 1% (age: 120m)": "low_yield",
    "low yield: fee/TVL 0.61% < min 1% (age 120m)": "low_yield",
    "stop loss: pnl -15.32% <= limit -15.00%": "stop_loss",
    "Young stop loss: PnL -11.02%": "young_stop",
    "crash-below 36 bins/90s (24.0 b/min ≥ 12, dist 19)": "crash",
    "in-range rug 27 bins/75s (21.6 b/min ≥ 12, pnl -6.68% ≤ -3%)": "rug",
    "Trailing TP: peak 2.68% → current 1.15%": "trailing_tp",
    "Out of range below for 60m (limit: 60m)": "oor_below",
    "OOR (below): 61m out of range >= limit 60m": "oor_below",
    "manual close (dashboard)": "manual",
    "manual close (/close)": "manual",
    "External close detected during discovery reconciliation; realized PnL": "external",
    "rebalance: Autonomous roll-up: trend": "rebalance_leg",
    "Profit ratchet: peaked +2.45% >= 2%, now 0.25%": "ratchet",
    "agent decision": "llm",
  };
  for (const [reason, fam] of Object.entries(cases)) assert.equal(exitFamilyFromReason(reason), fam, reason);
});

test("classifyOutcome reads the family, not keywords", () => {
  const base = { initial_value_usd: 1, fees_earned_usd: 0.03, range_efficiency: 90 };
  assert.equal(classifyOutcome({ ...base, pnl_pct: 2.9, close_reason: "Round-trip complete: 5 bins above range" }), "success");
  assert.equal(classifyOutcome({ ...base, pnl_pct: 2.5, close_reason: "Fee/TVL yield collapsed 66% (peak 15% → 5%)" }), "success"); // surge decay is not fee-death
  assert.equal(classifyOutcome({ ...base, pnl_pct: 0.1, fees_earned_usd: 0.001, close_reason: "Low yield: fee/TVL 0.08% < min 1%" }), "failure");
  assert.equal(classifyOutcome({ ...base, pnl_pct: -2, close_reason: "in-range rug 27 bins/75s" }), "failure");
  assert.equal(classifyOutcome({ ...base, pnl_pct: 2.1, exit_family: "harvest", close_reason: "weird legacy string above" }), "success"); // stored field wins
});
