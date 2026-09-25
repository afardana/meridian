process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const { evaluateHarvestStraddle, decideHarvestStraddle } = await import("../harvest-straddle.js");

const up = { confirmed: true, reason: "3 5m candles up" };
const down = { confirmed: false, reason: "net -4%" };
const cfg = { harvestStraddleMode: "enforce", rebalanceMaxCount: 2, harvestStraddleMinProceedsSol: 0.3, harvestStraddleBins: 34, harvestStraddleShape: "curve", harvestStraddleRatio: 0.5, harvestStraddleMaxImpactPct: 3 };

test("straddle only on an up-trend, under the chain cap, above the size floor, not on hold", () => {
  const t = { amount_sol: 1, rebalance_count: 0 };
  let d = evaluateHarvestStraddle({ tracked: t, cfg, trend: up });
  assert.equal(d.eligible, true); assert.equal(d.enforce, true);
  assert.deepEqual(d.params, { shape: "curve", bins: 34, ratio: 0.5, maxImpactPct: 3 });
  assert.equal(evaluateHarvestStraddle({ tracked: t, cfg, trend: down }).eligible, false);
  assert.equal(evaluateHarvestStraddle({ tracked: { ...t, rebalance_count: 2 }, cfg, trend: up }).eligible, false);
  assert.equal(evaluateHarvestStraddle({ tracked: { ...t, amount_sol: 0.2 }, cfg, trend: up }).eligible, false);
  assert.equal(evaluateHarvestStraddle({ tracked: { ...t, hold_mode: true }, cfg, trend: up }).eligible, false);
  assert.equal(evaluateHarvestStraddle({ tracked: t, cfg: { ...cfg, harvestStraddleMode: "off" }, trend: up }).eligible, false);
  const sh = evaluateHarvestStraddle({ tracked: t, cfg: { ...cfg, harvestStraddleMode: "shadow" }, trend: up });
  assert.equal(sh.eligible, true); assert.equal(sh.enforce, false);
  // bins clamp to the single-account limit, ratio clamps to [0.2, 0.8]
  const wide = evaluateHarvestStraddle({ tracked: t, cfg: { ...cfg, harvestStraddleBins: 60, harvestStraddleRatio: 0.95 }, trend: up });
  assert.equal(wide.params.bins, 34); assert.equal(wide.params.ratio, 0.8);
});

test("decideHarvestStraddle logs shadow and never throws on a trend fetch failure", async () => {
  const logs = [];
  const log = (c, m) => logs.push(`${c}: ${m}`);
  const d = await decideHarvestStraddle({ p: { pair: "X-SOL", pool: "P" }, tracked: { amount_sol: 1 }, cfg: { ...cfg, harvestStraddleMode: "shadow" }, log, fetchTrend: async () => up });
  assert.equal(d.enforce, false); assert.ok(logs.some((l) => l.includes("[STRADDLE_SHADOW] would straddle X-SOL")));
  const e = await decideHarvestStraddle({ p: { pair: "X-SOL", pool: "P" }, tracked: { amount_sol: 1 }, cfg, log, fetchTrend: async () => { throw new Error("429"); } });
  assert.equal(e.enforce, false); assert.match(e.reason, /trend fetch failed/);
  const f = await decideHarvestStraddle({ p: { pair: "X-SOL", pool: "P" }, tracked: { amount_sol: 1 }, cfg, log, fetchTrend: async () => up });
  assert.equal(f.enforce, true);
});
