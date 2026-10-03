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
  assert.deepEqual(d.params, { shape: "curve", bins: 34, ratio: 0.5, maxImpactPct: 3, inPlace: true });
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

test("trend ceiling is log-only by default and the gate inputs are recorded", async () => {
  const { evaluateTrendCeiling, buildStraddleGateRecord } = await import("../harvest-straddle.js");
  const spike = { confirmed: true, reason: "up", netGainPct: 23.7, greenCount: 2, candles: [{ open: 1, close: 0.992 }, { open: 0.992, close: 1.215 }, { open: 1.215, close: 1.164 }] };
  const mild = { confirmed: true, reason: "up", netGainPct: 8.2, greenCount: 3, candles: [] };
  assert.equal(evaluateTrendCeiling(spike, cfg).wouldSkip, true);
  assert.equal(evaluateTrendCeiling(spike, cfg).mode, "shadow");
  assert.equal(evaluateTrendCeiling(mild, cfg).wouldSkip, false);
  assert.equal(evaluateTrendCeiling(spike, { ...cfg, harvestStraddleTrendCeilingMode: "off" }).wouldSkip, false);
  assert.equal(evaluateTrendCeiling({ confirmed: true }, cfg).wouldSkip, false); // no reading → never skips

  const t = { amount_sol: 2.01 };
  const logs = [], recorded = [];
  const log = (c, m) => logs.push(m);
  // Shadow: still straddles, logs the would-skip, records what the gate saw.
  const d = await decideHarvestStraddle({ p: { pair: "swordcat-SOL", pool: "P", position: "POS", pnl_pct: 4.37 }, tracked: t, cfg, log, fetchTrend: async () => spike, recordGate: (pos, g) => recorded.push([pos, g]) });
  assert.equal(d.eligible, true); assert.equal(d.enforce, true);
  assert.ok(logs.some((l) => l.includes("[STRADDLE_CEILING_SHADOW] would-skip swordcat-SOL")));
  assert.equal(recorded.length, 1);
  const [pos, g] = recorded[0];
  assert.equal(pos, "POS");
  assert.equal(g.harvest_pnl_pct, 4.37); assert.equal(g.trend_net_pct, 23.7); assert.equal(g.trend_green, 2);
  assert.equal(g.ceiling_would_skip, true); assert.equal(g.eligible, true); assert.equal(g.trend_confirmed, true);
  assert.deepEqual(g.candle_moves_pct, [-0.8, 22.5, -4.2]);
  // Enforce: the same harvest closes to cash, and the record says why.
  const rec2 = [];
  const e = await decideHarvestStraddle({ p: { pair: "swordcat-SOL", pool: "P", position: "POS", pnl_pct: 4.37 }, tracked: t, cfg: { ...cfg, harvestStraddleTrendCeilingMode: "enforce" }, log, fetchTrend: async () => spike, recordGate: (pos, g) => rec2.push(g) });
  assert.equal(e.eligible, false); assert.match(e.reason, /trend ceiling/);
  assert.equal(rec2[0].eligible, false); assert.match(rec2[0].reason, /trend ceiling/);
  // A rejected trend is recorded too; a throwing recorder never breaks the decision.
  const rec3 = [];
  await decideHarvestStraddle({ p: { pair: "Agency-SOL", pool: "P", position: "A", pnl_pct: 3.39 }, tracked: t, cfg, log, fetchTrend: async () => ({ confirmed: false, reason: "1/3 green", netGainPct: 31.7, greenCount: 1, candles: [] }), recordGate: (pos, g) => rec3.push(g) });
  assert.equal(rec3[0].trend_confirmed, false); assert.equal(rec3[0].trend_net_pct, 31.7); assert.equal(rec3[0].eligible, false);
  const ok = await decideHarvestStraddle({ p: { pair: "X", pool: "P", position: "X" }, tracked: t, cfg, log, fetchTrend: async () => mild, recordGate: () => { throw new Error("boom"); } });
  assert.equal(ok.eligible, true);
  assert.equal(buildStraddleGateRecord({ p: {}, decision: ok, trend: mild }).ceiling_would_skip, false);
});
