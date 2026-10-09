process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const { classifyOutcome, derivLesson, exitFamilyOf } = await import("../lessons.js");

// QI-SOL 2026-10-09: adopted operator position, trailing TP overshoot, settled at a loss.
// Fees were >= 2% of the capital, which alone used to classify the close as a success.
const qi = {
  pool_name: "QI-SOL",
  strategy: "spot",
  bin_step: 100,
  volatility: 6.368283225851405,
  adopted: true,
  minutes_held: 78,
  range_efficiency: 89.6,
  initial_value_usd: 2.0,
  fees_earned_usd: 0.0686,          // 3.43% of capital
  final_value_usd: 1.923,
  pnl_pct: -0.42,
  pnl_sol: -0.0084,
  entry_mcap: 1_400_000,
  entry_tvl: 94_000,
  entry_volume: 32_000,
  close_reason: "Trailing TP: peak 5.47% → current -0.42% (threshold 3.97% = peak − 1.50pp; dropped 5.89pp >= 1.50pp; overshot 4.39pp >= 0.50pp (immediate))",
};

test("a trailing-TP close that settles at a loss is not a success and yields no PREFER", () => {
  assert.equal(exitFamilyOf(qi), "trailing_tp");
  assert.notEqual(classifyOutcome(qi), "success");
  const lesson = derivLesson(qi);
  if (lesson) {
    assert.ok(!/^(PREFER|WORKED)/.test(lesson.rule), lesson.rule);
    assert.notEqual(lesson.outcome, "good");
  }
});

test("no exit family turns a non-positive close with high fees into a success", () => {
  const reasons = [
    qi.close_reason,
    "Round-trip complete: 5 bins above range, pnl frozen",
    "take profit: pnl",
    "manual close (dashboard)",
    "External close detected during discovery reconciliation; realized PnL",
    "pumped far above range: active bin -275 is 54 bins past upper -329 (trigger 50)",
    "agent decision",
  ];
  for (const close_reason of reasons) {
    for (const pnl_pct of [-0.42, -4.9, 0]) {
      const rec = { ...qi, close_reason, pnl_pct };
      assert.notEqual(classifyOutcome(rec), "success", `${close_reason} @ ${pnl_pct}`);
      assert.ok(!/^(PREFER|WORKED)/.test(derivLesson(rec)?.rule || ""), `${close_reason} @ ${pnl_pct}`);
    }
  }
});

test("control: a +3% trailing-TP close is still a success with a PREFER lesson", () => {
  const win = { ...qi, pnl_pct: 3, pnl_sol: 0.06, final_value_usd: 1.9914,
    close_reason: "Trailing TP: peak 4.60% → current 3.00% (threshold 3.10% = peak − 1.50pp)" };
  assert.equal(classifyOutcome(win), "success");
  const lesson = derivLesson(win);
  assert.match(lesson.rule, /^PREFER: QI-SOL-type pools/);
  assert.match(lesson.rule, /PnL \+3%/);
  assert.ok(!lesson.rule.includes("+-"));
  // fee-carried small win (pnl < 2 but fees >= 2% of capital) keeps its old classification
  assert.equal(classifyOutcome({ ...win, pnl_pct: 0.8 }), "success");
});
