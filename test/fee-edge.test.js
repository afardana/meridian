process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Fee-versus-loss edge tag (shadow) ===");

const { computeFeeEdge, evaluateFeeEdgeGate } = await import("../fee-edge.js");

const rich = computeFeeEdge({ tvl: 240000, fee_active_tvl_ratio: 2.58, volatility: 5.77, bin_step: 100 }, "1h");
const thin = computeFeeEdge({ tvl: 240000, fee_active_tvl_ratio: 0.2, volatility: 5.77, bin_step: 100 }, "1h");
assert.ok(Number.isFinite(rich) && Number.isFinite(thin) && rich > thin && thin > 0);
// More fees for the same volatility → proportionally more edge.
assert.ok(Math.abs(rich / thin - 2.58 / 0.2) / (2.58 / 0.2) < 0.05);
// Unusable inputs → no reading, never a guess.
assert.equal(computeFeeEdge({ tvl: 100000, fee_active_tvl_ratio: 1, volatility: 0, bin_step: 100 }), null);
assert.equal(computeFeeEdge({ tvl: null, fee_active_tvl_ratio: 1, volatility: 3, bin_step: 100 }), null);
assert.equal(computeFeeEdge({ tvl: 100000, fee_active_tvl_ratio: null, volatility: 3, bin_step: 100 }), null);

assert.deepEqual(evaluateFeeEdgeGate(3.2, {}), { edge: 3.2, min: 5, mode: "shadow", wouldSkip: true });
assert.equal(evaluateFeeEdgeGate(7.5, {}).wouldSkip, false);
assert.equal(evaluateFeeEdgeGate(null, {}).wouldSkip, null);                       // no reading → no verdict
assert.equal(evaluateFeeEdgeGate(1, { feeEdgeGateMode: "off" }).wouldSkip, null);
assert.equal(evaluateFeeEdgeGate(6, { feeEdgeGateMin: 8 }).wouldSkip, true);

// Tag flows deploy → state → every perf-record site; nothing in the executor blocks on it.
const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
assert.equal((dlmm.match(/fee_edge_gate_would_skip: (tracked|snapshot)\.fee_edge_gate_would_skip/g) || []).length, 3);
const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
assert.match(exec, /entryMarketData\.fee_edge_gate_would_skip = v\.wouldSkip;/);
const block = exec.slice(exec.indexOf("Fee-versus-loss edge capture"), exec.indexOf("Entry-range capture"));
assert.doesNotMatch(block, /pass: false/);
const state = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
assert.match(state, /entry_fee_edge: entry_fee_edge != null/);

console.log("✅ fee edge tag verified");
process.exit(0);
