process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";

console.log("=== Briefing amounts: explicit units, flow-adjusted AUM change, cache-fallback record fields ===");

const { sumPerfTotals, aumChangePct, lessonLines } = await import("../briefing.js");
const { isWinningRecord } = await import("../lessons.js");
const { cacheFallbackRecordFields } = await import("../tools/dlmm.js");

// 2026-10-04 briefing: one stop-loss record carried dollars in the legacy pnl_usd / fees fields.
const recs = [
  { pnl_usd: 0.28, pnl_sol: 0.2756, pnl_usd_true: 33.41, fees_earned_usd: 0.1757, fees_sol_true: 0.1757, fees_usd_true: 21.03 },
  { pnl_usd: 0.0, pnl_sol: 0.0046, pnl_usd_true: 0.43, fees_earned_usd: 0.0119, fees_sol_true: 0.0119, fees_usd_true: 1.42 },
  { pnl_usd: -21.06, pnl_sol: -0.1774, pnl_usd_true: -21.06, fees_earned_usd: 3.6843, fees_sol_true: null, fees_usd_true: null },
];
const t = sumPerfTotals(recs);
assert.ok(Math.abs(t.pnlSol - 0.1028) < 1e-9);       // not −20.78
assert.ok(Math.abs(t.pnlUsd - 12.78) < 1e-9);        // same sign as the SOL figure
assert.ok(Math.abs(t.feesSol - 0.1876) < 1e-9);      // not 3.87
// A +0.0046 SOL close is a win even though its 2-decimal legacy field reads 0.00.
assert.equal(recs.filter(isWinningRecord).length, 2);
assert.equal(isWinningRecord({ pnl_usd: 0.5 }), true);   // pre-v3 record without pnl_sol
assert.equal(isWinningRecord({ pnl_usd: 0, pnl_sol: -0.00001 }), false);

// AUM 2.32 → 7.39 with a 5.6 SOL deposit in the window is −22.8 %, not +218 %.
assert.ok(Math.abs(aumChangePct(2.32, 7.3933, { deposits: 5.6 }) - (-22.70)) < 0.1);
assert.ok(Math.abs(aumChangePct(2.32, 7.3933) - 218.68) < 0.1);
assert.ok(Math.abs(aumChangePct(10, 8, { withdrawals: 2 }) - 0) < 1e-9);
assert.equal(aumChangePct(0, 5), null);

// Cache-fallback close under solMode: legacy fields in SOL, dual fields filled.
const fb = cacheFallbackRecordFields({
  solMode: true,
  cachedPos: { collected_fees_usd: 0.02, unclaimed_fees_usd: 0.0107 },
  pnlSol: -0.1774, pnlTrueUsd: -21.0628, feesUsdTrue: 3.6843, initialUsdTrue: 131.2824, capitalSol: 1.0991,
});
assert.equal(fb.pnlUsd, -0.1774);
assert.equal(fb.initialUsd, 1.0991);
assert.ok(Math.abs(fb.feesUsd - 0.0307) < 1e-9);
assert.ok(Math.abs(fb.finalValueUsd - (1.0991 - 0.1774 - 0.0307)) < 1e-9);
assert.equal(fb.depSolTrue, 1.0991);
assert.equal(fb.depUsdTrue, 131.2824);
assert.equal(fb.feesUsdTrue, 3.6843);
// lessons.recordPerformance derives pnl = final + fees − initial → SOL again.
assert.ok(Math.abs(fb.finalValueUsd + fb.feesUsd - fb.initialUsd - (-0.1774)) < 1e-9);
// No SOL fee fields on the cache → USD fees at the price the pnl implies.
const fb2 = cacheFallbackRecordFields({ solMode: true, cachedPos: {}, pnlSol: -0.1774, pnlTrueUsd: -21.0628, feesUsdTrue: 3.6843, initialUsdTrue: 131.28, capitalSol: 1.0991 });
assert.ok(Math.abs(fb2.feesSolTrue - 3.6843 / (21.0628 / 0.1774)) < 1e-9);
// USD mode / no capital → untouched.
assert.equal(cacheFallbackRecordFields({ solMode: false, capitalSol: 1 }), null);
assert.equal(cacheFallbackRecordFields({ solMode: true, capitalSol: 0 }), null);

// Lessons: newest five, whole words with an ellipsis, a count when more exist.
{
  const many = Array.from({ length: 23 }, (_, i) => ({ rule: `PREFER: pool ${i} ` + "word ".repeat(60) }));
  const out = lessonLines(many);
  assert.equal(out.length, 6);
  assert.equal(out[0], "23 new — latest 5:");
  assert.ok(out[5].startsWith("• PREFER: pool 22 ") && out[5].endsWith("…") && out[5].length <= 175);
  assert.deepEqual(lessonLines([{ rule: "short < rule" }]), ["• short &lt; rule"]);
  assert.deepEqual(lessonLines([]), ["• No new lessons recorded overnight."]);
}

console.log("✅ briefing units verified");
process.exit(0);
