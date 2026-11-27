// dashboard-report `skim_threshold` (2026-11-27): the capital side of the skim decision,
// published so the dashboard's "Risk" figure and the skim floor are one number.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import { computeSkimDecision, skimCapitalThreshold, skimConfig, skimLedger, bookSkimWithdrawal, reduceSkimJournal } from "../skim-policy.js";
import { skimThresholdReportField, skimJournalState } from "../tools/transfer.js";
import { reportSkimThreshold } from "../report.js";

const FIELDS = ["total_deposited_sol", "operator_withdrawn_sol", "skimmed_sol", "net_capital_sol", "untracked_swap_inflow_sol", "adjusted_capital_sol", "target_sol", "floor_sol"];
const NOW = Date.parse("2026-11-27T06:00:00Z");

// Deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sig = (r) => Array.from({ length: 88 }, () => "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"[Math.floor(r() * 58)]).join("");

/** A random baseline + reduced journal (statuses from `statuses`) + swap total + target. */
function randomCase(r, statuses = ["landed", "failed"]) {
  const withdrawals = [];
  const skims = [];
  const n = Math.floor(r() * 8);
  for (let i = 0; i < n; i++) {
    const amount = Math.round(r() * 3e6) / 1e6;
    const ts = new Date(NOW - Math.floor(r() * 30 * 864e5)).toISOString();
    const kind = Math.floor(r() * 4);
    const s = sig(r);
    if (kind === 0) withdrawals.push({ signature: s, timestamp: ts, amount }); // operator
    else if (kind === 1) withdrawals.push({ signature: s, timestamp: ts, amount, reason: "profit_skim", skim: true }); // flagged skim
    else if (kind === 2) withdrawals.push({ signature: s, timestamp: ts, amount, reason: "auto_skim_pionex" }); // legacy skim
    else { // journal skim (booked when landed)
      const status = statuses[Math.floor(r() * statuses.length)];
      skims.push({ signature: s, amount_sol: amount, status, created_at: ts });
      if (status === "landed") withdrawals.push({ signature: s, timestamp: ts, amount });
    }
  }
  const sumW = withdrawals.reduce((a, w) => a + w.amount, 0);
  const baseline = {
    total_deposited: Math.round((0.5 + r() * 30) * 1e6) / 1e6,
    total_withdrawn: Math.round((sumW + (r() < 0.2 ? r() : 0)) * 1e6) / 1e6,
    withdrawals,
    deposits: [],
  };
  const untrackedSwapSolTotal = (r() - 0.4) * 2;
  const target = r() < 0.3 ? 0 : r() * 20 + r() * 1e-7; // some targets with > 6 dp
  return { baseline, skims, untrackedSwapSolTotal, target };
}

function decide({ baseline, skims, untrackedSwapSolTotal, target }, freeSol) {
  return computeSkimDecision({
    cfg: skimConfig({ enabled: true, targetWorkingCapitalSol: target }),
    destination: { ok: true }, integrity: { ok: true, toBook: [] }, baselineFresh: null,
    baseline, skims, untrackedSwapSolTotal, tokenSwapCount: 0, now: NOW,
    wallet: { freeSol, freeSolBefore: freeSol, freeSolAfter: freeSol, valuationComplete: true, source: "rpc", positions: [] },
  });
}

test("skim_threshold.floor_sol equals the decision's floorSol on 500 random inputs", () => {
  const r = rng(20261127);
  for (let i = 0; i < 500; i++) {
    const c = randomCase(r);
    const d = decide(c, r() * 40);
    assert.ok(Number.isFinite(d.figures.floorSol), `case ${i}: decision reached the floor`);
    const t = skimCapitalThreshold({ baseline: c.baseline, skims: c.skims, untrackedSwapSolTotal: c.untrackedSwapSolTotal, cfg: skimConfig({ enabled: true, targetWorkingCapitalSol: c.target }), now: NOW });
    assert.equal(t.floor_sol, d.figures.floorSol, `case ${i}`);
    assert.equal(t.adjusted_capital_sol, d.figures.adjustedCapital, `case ${i}`);
    assert.equal(t.net_capital_sol, d.figures.netCapital, `case ${i}`);
    assert.equal(t.untracked_swap_inflow_sol, d.figures.untrackedSwapInflowSol, `case ${i}`);
    assert.equal(t.floor_sol, Math.max(t.adjusted_capital_sol, t.target_sol), `case ${i}: floor = max(adjusted, target)`);
  }
});

test("pending skims: the helper's capital is skimLedger's (decision refuses before the floor)", () => {
  const r = rng(7);
  for (let i = 0; i < 300; i++) {
    const c = randomCase(r, ["landed", "failed", "pending"]);
    const cfg = skimConfig({ enabled: true, targetWorkingCapitalSol: c.target });
    const t = skimCapitalThreshold({ baseline: c.baseline, skims: c.skims, untrackedSwapSolTotal: c.untrackedSwapSolTotal, cfg, now: NOW });
    const l = skimLedger(c.baseline, c.skims, NOW, { untrackedSwapSolTotal: c.untrackedSwapSolTotal });
    assert.equal(t.net_capital_sol, l.netCapital);
    assert.equal(t.adjusted_capital_sol, l.adjustedCapital);
    assert.equal(t.operator_withdrawn_sol, l.operatorWithdrawn);
    assert.equal(t.skimmed_sol, l.skimWithdrawn);
  }
});

test("a landed skim does not change net capital; an operator withdrawal lowers it; untracked inflow raises adjusted capital", () => {
  const cfg = skimConfig({ enabled: true, targetWorkingCapitalSol: 5 });
  const baseline = { total_deposited: 13.388, total_withdrawn: 0, withdrawals: [] };
  const before = skimCapitalThreshold({ baseline, skims: [], cfg, now: NOW });
  assert.equal(before.net_capital_sol, 13.388);

  // A skim: journal pending → landed + booked.
  const s = "5".repeat(88);
  const pending = reduceSkimJournal([{ event: "pending", signature: s, amount_sol: 0.5, at: new Date(NOW).toISOString() }]);
  const midway = skimCapitalThreshold({ baseline, skims: pending, cfg, now: NOW });
  assert.equal(midway.net_capital_sol, 13.388);
  const landed = reduceSkimJournal([{ event: "pending", signature: s, amount_sol: 0.5, at: new Date(NOW).toISOString() }, { event: "landed", signature: s, at: new Date(NOW).toISOString() }]);
  const b2 = structuredClone(baseline);
  assert.ok(bookSkimWithdrawal(b2, { signature: s, amountSol: 0.5, at: new Date(NOW).toISOString() }));
  const after = skimCapitalThreshold({ baseline: b2, skims: landed, cfg, now: NOW });
  assert.equal(after.net_capital_sol, 13.388);
  assert.equal(after.skimmed_sol, 0.5);
  assert.equal(after.operator_withdrawn_sol, 0);

  // An operator withdrawal.
  const b3 = structuredClone(b2);
  b3.withdrawals.push({ signature: "6".repeat(88), timestamp: new Date(NOW).toISOString(), amount: 1.25 });
  b3.total_withdrawn += 1.25;
  const op = skimCapitalThreshold({ baseline: b3, skims: landed, cfg, now: NOW });
  assert.equal(op.net_capital_sol, 12.138);
  assert.equal(op.operator_withdrawn_sol, 1.25);

  // Untracked inflow (positive counts, negative does not).
  const inflow = skimCapitalThreshold({ baseline, skims: [], untrackedSwapSolTotal: 0.1867, cfg, now: NOW });
  assert.equal(inflow.net_capital_sol, 13.388);
  assert.equal(inflow.adjusted_capital_sol, 13.5747);
  assert.equal(inflow.floor_sol, 13.5747);
  const outflow = skimCapitalThreshold({ baseline, skims: [], untrackedSwapSolTotal: -0.3, cfg, now: NOW });
  assert.equal(outflow.adjusted_capital_sol, 13.388);

  // Target above capital is the floor.
  const high = skimCapitalThreshold({ baseline, skims: [], cfg: skimConfig({ targetWorkingCapitalSol: 20 }), now: NOW });
  assert.equal(high.floor_sol, 20);
  assert.equal(high.target_sol, 20);
});

function tmpJournal(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skim-threshold-"));
  const f = path.join(dir, "skim-journal.jsonl");
  if (lines != null) fs.writeFileSync(f, lines);
  return f;
}
const baseDeps = (baseline, journalFile, extra = {}) => ({
  getBaseline: () => baseline,
  journalState: (b) => skimJournalState({ journalFile, mirror: null, baseline: b }),
  swapFigures: () => ({ untrackedSwapSolTotal: 0.1867, tokenSwapCount: 3, tokenSwapsEvictedSol: 0 }),
  getCfg: () => skimConfig({ targetWorkingCapitalSol: 6.2529 }),
  now: NOW,
  ...extra,
});

test("report field: ok path carries the contract fields, floor = max(adjusted, target)", () => {
  const baseline = { total_deposited: 13.388, total_withdrawn: 0, withdrawals: [] };
  const f = skimThresholdReportField(baseDeps(baseline, tmpJournal(null)));
  assert.equal(f.state, "ok");
  assert.equal(f.reason, null);
  assert.equal(f.at, new Date(NOW).toISOString());
  for (const k of FIELDS) assert.ok(Number.isFinite(f[k]), k);
  assert.equal(f.adjusted_capital_sol, 13.5747);
  assert.equal(f.floor_sol, 13.5747);
  assert.equal(f.target_sol, 6.2529);
  const r = reportSkimThreshold(f);
  assert.deepEqual(Object.keys(r).sort(), ["at", "reason", "state", ...FIELDS].sort());
  assert.equal(r.floor_sol, Math.max(r.adjusted_capital_sol, r.target_sol));
});

test("report field: an unreadable / corrupt journal gives state unavailable and never throws", () => {
  const baseline = { total_deposited: 13.388, total_withdrawn: 0, withdrawals: [] };
  const corrupt = skimThresholdReportField(baseDeps(baseline, tmpJournal('{"event":"pending","signature":"x"\n{torn')));
  assert.equal(corrupt.state, "unavailable");
  assert.match(corrupt.reason, /unreadable line/);
  for (const k of FIELDS) assert.equal(corrupt[k], null, k);

  // The journal path is a directory → readFileSync throws EISDIR inside skimJournalState.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skim-threshold-dir-"));
  const eisdir = skimThresholdReportField(baseDeps(baseline, dir));
  assert.equal(eisdir.state, "unavailable");

  // Any dependency throwing.
  for (const key of ["getBaseline", "journalState", "swapFigures", "getCfg"]) {
    const f = skimThresholdReportField(baseDeps(baseline, tmpJournal(null), { [key]: () => { throw new Error(`boom ${key}`); } }));
    assert.equal(f.state, "unavailable", key);
    assert.match(f.reason, new RegExp(`boom ${key}`));
  }
  // An invalid clock.
  assert.equal(skimThresholdReportField(baseDeps(baseline, tmpJournal(null), { now: NaN })).at, null);
});

test("report field: no baseline, stuck scan and a full swap ring without a running total are unavailable", () => {
  const j = tmpJournal(null);
  assert.equal(skimThresholdReportField(baseDeps({}, j)).state, "unavailable");
  assert.equal(skimThresholdReportField(baseDeps({ total_deposited: 0 }, j)).state, "unavailable");
  assert.equal(skimThresholdReportField(baseDeps({ total_deposited: 5, stuck_signature: "7".repeat(88) }, j)).state, "unavailable");
  const full = skimThresholdReportField(baseDeps({ total_deposited: 5 }, j, { swapFigures: () => ({ untrackedSwapSolTotal: 0, tokenSwapCount: 300, tokenSwapsEvictedSol: null }) }));
  assert.equal(full.state, "unavailable");
  const fullWithTotal = skimThresholdReportField(baseDeps({ total_deposited: 5 }, j, { swapFigures: () => ({ untrackedSwapSolTotal: 0.2, tokenSwapCount: 300, tokenSwapsEvictedSol: 0.1 }) }));
  assert.equal(fullWithTotal.state, "ok");
});

test("report field: no full address anywhere in the field", () => {
  const addr = Keypair.generate().publicKey.toBase58();
  const run = /[1-9A-HJ-NP-Za-km-z]{32,}/;
  const baseline = {
    total_deposited: 13.388, total_withdrawn: 1,
    withdrawals: [{ signature: "8".repeat(88), timestamp: new Date(NOW).toISOString(), amount: 1, destination: addr, skim: true, reason: "profit_skim" }],
  };
  // A baseline skim the journal does not know → integrity refusal naming the signature (masked).
  const f1 = skimThresholdReportField(baseDeps(baseline, tmpJournal(null)));
  assert.equal(f1.state, "unavailable");
  assert.doesNotMatch(JSON.stringify(f1), run);
  // An error message carrying an address.
  const f2 = skimThresholdReportField(baseDeps(baseline, tmpJournal(null), { getBaseline: () => { throw new Error(`failed to get info about account ${addr}: timeout`); } }));
  assert.doesNotMatch(JSON.stringify(f2), run);
  assert.doesNotMatch(JSON.stringify(reportSkimThreshold(f2)), run);
  // The ok path.
  const f3 = skimThresholdReportField(baseDeps({ total_deposited: 3, withdrawals: [{ signature: "9".repeat(88), amount: 0.1, destination: addr }], total_withdrawn: 0.1 }, tmpJournal(null)));
  assert.equal(f3.state, "ok");
  assert.doesNotMatch(JSON.stringify(f3), run);
});

test("reportSkimThreshold whitelists, rounds and nulls numbers when unavailable", () => {
  assert.equal(reportSkimThreshold(null), null);
  const r = reportSkimThreshold({ state: "unavailable", reason: "x", at: "t", floor_sol: 5, extra: "drop me" });
  assert.equal(r.floor_sol, null);
  assert.equal(r.extra, undefined);
  const ok = reportSkimThreshold({ state: "ok", reason: null, at: "t", floor_sol: 1.23456789, adjusted_capital_sol: 1.23456789, target_sol: 1 });
  assert.equal(ok.floor_sol, 1.234568);
  assert.equal(ok.net_capital_sol, null);
});
