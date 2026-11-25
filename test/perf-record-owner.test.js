/**
 * Record-only identity fields on every perf record (perf-record.js, 2026-11-25):
 * owner ("bot" | "operator"), adopted_at, capital_rebase.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PR = await import("../perf-record.js");
const CR = await import("../capital-rebase.js");

const recovered = { pnl_sol: 0.01, pnl_usd_true: 1, fees_sol_true: 0.01, fees_usd_true: 1, initial_sol_true: 0.5, initial_usd_true: 50, fees_value: 1, final_value: 51, initial_value: 50 };
const base = { pool_name: "X-SOL", pool: "P".repeat(44), amount_sol: 0.5, bin_range: { min: -10, max: 10 } };
const sites = (tracked) => ({
  closed: PR.closePositionPerfRecord({ tracked, position_address: "pos1", poolAddress: base.pool, poolMeta: { name: "X-SOL" }, closeBaseMint: "M", pnlSol: 0.01, pnlTrueUsd: 1, feesSolTrue: 0.01, feesUsdTrue: 1, depSolTrue: 0.5, depUsdTrue: 50, minutesHeld: 60, minutesOOR: 0, reason: "t", close_gas_sol: 0.0001 }),
  leg: PR.rebalanceLegPerfRecord({ snapshot: tracked, recovered, position_address: "pos1", pool_address: base.pool, new_position_address: "pos2", reason: "r", gas_sol: 0, minutesHeld: 60, minutesOOR: 0, closedAt: "2026-11-25T00:00:00Z" }),
  ext: PR.externalReconcilePerfRecord({ tracked, recovered, position_address: "pos1", reason: "ext", minutesHeld: 60, minutesOOR: 0, closedAt: "2026-11-25T00:00:00Z" }),
});
const all = (tracked, fn) => { for (const [k, r] of Object.entries(sites(tracked))) fn(r, k); };

test("bot deploy: owner bot, no adopted_at, capital_rebase null at all three sources", () => {
  all({ ...base, adopted: false, adopted_at: null }, (r, k) => {
    assert.equal(r.owner, "bot", k);
    assert.equal(r.adopted_at, undefined, k);
    assert.equal(r.capital_rebase, null, k);
  });
});

test("operator-adopted: owner operator with adopted_at", () => {
  all({ ...base, adopted: true, adopted_at: "2026-11-25T01:00:00.000Z", strategy_source: "manual" }, (r, k) => {
    assert.equal(r.owner, "operator", k);
    assert.equal(r.adopted_at, "2026-11-25T01:00:00.000Z", k);
  });
});

test("recovered bot deploy (adopted, bot_deploy_recovered / bot_recovery) is the bot's", () => {
  for (const src of ["bot_deploy_recovered", "bot_recovery"]) {
    all({ ...base, adopted: true, adopted_at: "2026-11-25T01:00:00.000Z", strategy_source: src }, (r, k) => {
      assert.equal(r.owner, "bot", `${src} ${k}`);
      assert.equal(r.adopted_at, "2026-11-25T01:00:00.000Z", `${src} ${k}`);
    });
  }
});

test("capital_rebase: { count, last_at, from_sol, to_sol } from last_capital_rebase; legacy stamp without a count reads 1", () => {
  all({ ...base, last_capital_rebase: { count: 2, at: "2026-11-25T02:00:00.000Z", from_sol: 0.3, to_sol: 0.65, delta_sol: 0.35, peak_before: 5, peak_after: 2 } }, (r, k) => {
    assert.deepStrictEqual(r.capital_rebase, { count: 2, last_at: "2026-11-25T02:00:00.000Z", from_sol: 0.3, to_sol: 0.65 }, k);
  });
  assert.equal(PR.capitalRebaseRecordField({ last_capital_rebase: { at: "t", from_sol: 1, to_sol: 2 } }).count, 1);
});

test("settleCapitalRebase counts every stamp", () => {
  const pos = { peak_pnl_pct: 5, capital_rebase_pending: { from_sol: 0.3, to_sol: 0.6, delta_sol: 0.3, peak_before: 5, peak_rescaled: 2.5 } };
  CR.settleCapitalRebase(pos, 2);
  assert.equal(pos.last_capital_rebase.count, 1);
  pos.capital_rebase_pending = { from_sol: 0.6, to_sol: 0.4, delta_sol: -0.2, peak_before: 2, peak_rescaled: 3 };
  CR.settleCapitalRebase(pos, 2);
  assert.equal(pos.last_capital_rebase.count, 2);
  assert.equal(PR.capitalRebaseRecordField(pos).count, 2);
});

test("missing tracked row: no owner / adopted_at guessed", () => {
  assert.deepStrictEqual(PR.ownerRecordFields(null), {});
  assert.deepStrictEqual(PR.ownerRecordFields(undefined), {});
  assert.equal(PR.capitalRebaseRecordField(null), null);
});

test("no rule module reads the perf record's capital_rebase / owner", () => {
  const root = new URL("..", import.meta.url).pathname;
  const files = [
    ...fs.readdirSync(root).filter((f) => f.endsWith(".js")),
    ...fs.readdirSync(path.join(root, "tools")).filter((f) => f.endsWith(".js")).map((f) => path.join("tools", f)),
  ];
  for (const f of files) {
    if (f === "perf-record.js") continue;
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!/\bcapital_rebase\b(?!_)/.test(src.replace(/["'`]capital_rebase["'`]/g, "")) || f === "reading-guard-shadow.js" || f === "capital-rebase.js", `${f} must not read capital_rebase`);
    assert.ok(!/\b(rec|record|perf|r)\.owner\b/.test(src), `${f} must not read record.owner`);
  }
});
