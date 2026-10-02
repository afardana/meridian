process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { previousCloseFromDeploys, evaluateReentryGate, getReentryVerdict } = await import("../reentry-gate.js");

const NOW = Date.parse("2026-09-30T02:16:00+07:00"); // PARASITE-SOL re-entry
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const close = (m, pnl, reason = "Trailing TP: peak 3.8% → current 2.3%") => ({ closed_at: minsAgo(m), pnl_pct: pnl, close_reason: reason });

test("PARASITE-SOL 09-30: +2.3 % trailing close 76 min earlier → would-skip (it stopped out at −15.1 %)", () => {
  const v = evaluateReentryGate(previousCloseFromDeploys([close(900, -1), close(76, 2.3)], NOW));
  assert.equal(v.wouldSkip, true);
  assert.equal(v.prevClosePct, 2.3);
  assert.equal(v.prevCloseGapMin, 76);
  assert.match(v.reason, /previous close here \+2\.3% 76 min ago/);
});

test("the window is 60–240 min after a WIN: quick re-entries, late ones, flats and losses are not skipped", () => {
  const verdict = (m, pnl) => evaluateReentryGate(previousCloseFromDeploys([close(m, pnl)], NOW));
  assert.equal(verdict(8, 3.0).wouldSkip, false, "< 15 min after a win was fine in the history (+0.86 %, 77 % wins)");
  assert.equal(verdict(59, 3.0).wouldSkip, false);
  assert.equal(verdict(60, 3.0).wouldSkip, true);
  assert.equal(verdict(239, 3.0).wouldSkip, true);
  assert.equal(verdict(240, 3.0).wouldSkip, false);
  assert.equal(verdict(120, 0.4).wouldSkip, false, "flat close");
  assert.equal(verdict(120, -6).wouldSkip, false, "losing close");
  assert.equal(verdict(120, 0.4).prevClosePct, 0.4, "still tagged, so the whole table can be graded");
});

test("the most recent close decides; rebalance legs, pnl-less rows and closes older than 12 h are ignored", () => {
  assert.equal(previousCloseFromDeploys([], NOW), null);
  assert.equal(previousCloseFromDeploys([close(13 * 60, 5)], NOW), null);
  assert.equal(previousCloseFromDeploys([{ closed_at: minsAgo(90), pnl_pct: null }], NOW), null);
  const p = previousCloseFromDeploys([close(200, 4), close(90, 3, "rebalance: straddle"), close(100, -2, "Stop loss")], NOW);
  assert.deepEqual(p, { pnlPct: -2, gapMin: 100, closeReason: "Stop loss" });
  const unknown = evaluateReentryGate(null);
  assert.deepEqual([unknown.wouldSkip, unknown.prevClosePct, unknown.prevCloseGapMin], [false, null, null]);
});

test("thresholds come from config; a pool-memory failure fails open", async () => {
  const cfg = { reentryGateMinWinPct: 2, reentryGateMinGapMin: 30, reentryGateMaxGapMin: 120 };
  assert.equal(evaluateReentryGate({ pnlPct: 1.5, gapMin: 60 }, cfg).wouldSkip, false);
  assert.equal(evaluateReentryGate({ pnlPct: 2.5, gapMin: 45 }, cfg).wouldSkip, true);
  assert.equal(evaluateReentryGate({ pnlPct: 2.5, gapMin: 150 }, cfg).wouldSkip, false);
  const ok = await getReentryVerdict("pool", {}, { now: NOW, getDeploys: () => [close(76, 2.3)] });
  assert.equal(ok.wouldSkip, true);
  const failed = await getReentryVerdict("pool", {}, { now: NOW, getDeploys: () => { throw new Error("store down"); } });
  assert.equal(failed.wouldSkip, false);
});

test("wiring: shadow by default, log-only in screening, tagged on every deploy into the perf record", () => {
  const cfg = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(cfg, /reentryGateMode:\s+u\.reentryGateMode\s+\?\? "shadow"/);
  const scr = fs.readFileSync(new URL("../tools/screening.js", import.meta.url), "utf8");
  assert.match(scr, /\[REENTRY_GATE_SHADOW\] would-skip/);
  const gate = scr.slice(scr.indexOf('const reentryMode = String('), scr.indexOf("// Funnel telemetry (rank variant)"));
  assert.match(gate, /if \(reentryMode === "enforce"\) \{[\s\S]{0,200}pushFilteredReason/);
  assert.match(gate, /\} else \{\s+kept\.push\(p\);/, "shadow keeps the candidate");
  const prompt = fs.readFileSync(new URL("../prompt.js", import.meta.url), "utf8");
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(prompt + idx, /_reentryGate|prev_close_pct/, "not shown to the LLM while in shadow");
  const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exec, /entryMarketData\.reentry_gate_would_skip = v\.wouldSkip/);
  assert.match(exec, /reentryGateMode: \["screening", "reentryGateMode"\]/);
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.equal(dlmm.split("\n").filter((l) => l.includes("reentry_gate_would_skip")).length, 5, "param + trackPosition + 3 perf sites");
  const state = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
  assert.match(state, /reentry_gate_would_skip: typeof reentry_gate_would_skip === "boolean"/);
});
