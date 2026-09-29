process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { change24hFromCandles, evaluatePumpGate, getPoolChange24h, _resetPumpGateCache } = await import("../pump-gate.js");

const H = 3600;
const NOW = 1_790_000_000;
const candle = (hoursAgo, close) => ({ timestamp: NOW - hoursAgo * H, close });

test("24h change uses the last candle that ended a day ago and the newest close", () => {
  // hourly candles from 30 h ago to now, price doubling from 1 to 2 over the last day
  const cs = [candle(30, 0.9), candle(26, 1.0), candle(25, 1.0), candle(10, 1.5), candle(0, 2.0)];
  assert.equal(change24hFromCandles(cs, NOW), 100);
});

test("gaps without trades hold the last price; a pool younger than a day has no reading", () => {
  const gap = [candle(40, 1.0), candle(3, 3.0), candle(0, 3.0)]; // no trades between 40 h and 3 h ago
  assert.equal(change24hFromCandles(gap, NOW), 200);
  const young = [candle(20, 1.0), candle(0, 5.0)];
  assert.equal(change24hFromCandles(young, NOW), null);
  assert.equal(change24hFromCandles([], NOW), null);
  assert.equal(change24hFromCandles([candle(30, 0), candle(0, 1)], NOW), null);
});

test("gate verdict: ≥ threshold would skip, below or unknown never does", () => {
  assert.equal(evaluatePumpGate(150, { pumpGateMax24hPct: 100 }).wouldSkip, true);
  assert.equal(evaluatePumpGate(100, {}).wouldSkip, true);
  assert.equal(evaluatePumpGate(99.9, {}).wouldSkip, false);
  assert.equal(evaluatePumpGate(-60, {}).wouldSkip, false, "falling tokens are not gated (backtest: noise)");
  assert.equal(evaluatePumpGate(null, {}).wouldSkip, false);
  assert.match(evaluatePumpGate(433, {}).reason, /\+433% ≥ \+100%/);
});

test("pool change is fetched once per 10 min and fails open", async () => {
  _resetPumpGateCache();
  let calls = 0;
  const fetchCandles = async (pool, opts) => {
    calls++;
    assert.equal(opts.timeframe, "1h");
    assert.equal(opts.currency, "token", "SOL-quoted, as in the backtest");
    return [candle(30, 1), candle(0, 2)];
  };
  const now = NOW * 1000;
  assert.equal(await getPoolChange24h("P", { fetchCandles, now }), 100);
  assert.equal(await getPoolChange24h("P", { fetchCandles, now: now + 60_000 }), 100);
  assert.equal(calls, 1);
  assert.equal(await getPoolChange24h("P", { fetchCandles, now: now + 11 * 60_000 }), 100);
  assert.equal(calls, 2);
  assert.equal(await getPoolChange24h("Q", { fetchCandles: async () => { throw new Error("429"); }, now }), null);
});

test("wiring: shadow by default, not in the prompt, captured at deploy into the perf record", () => {
  const cfg = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(cfg, /pumpGateMode:\s+u\.pumpGateMode\s+\?\? "shadow"/);
  assert.match(cfg, /pumpGateMax24hPct:\s+u\.pumpGateMax24hPct\s+\?\? 100/);
  const scr = fs.readFileSync(new URL("../tools/screening.js", import.meta.url), "utf8");
  assert.match(scr, /\[PUMP_GATE_SHADOW\] would-skip/);
  assert.match(scr, /if \(pumpMode === "enforce"\) \{[\s\S]{0,120}pushFilteredReason/);
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(idx, /_pumpGate|price_change_24h/, "the LLM must not see the shadow gate");
  const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exec, /entryMarketData\.entry_price_change_24h_pct = v\.change24hPct;/);
  assert.match(exec, /pumpGateMode: \["screening", "pumpGateMode"\]/);
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.equal((dlmm.match(/entry_price_change_24h_pct: (tracked|snapshot)\.entry_price_change_24h_pct \?\? null/g) || []).length, 3);
  const trend = fs.readFileSync(new URL("../tools/rebalance-trend.js", import.meta.url), "utf8");
  assert.match(trend, /currency === "token" \? "&currency=token" : ""/);
});
