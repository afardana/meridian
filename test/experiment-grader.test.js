process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { EXPERIMENTS, UNGRADED, experimentById } = await import("../scripts/experiments/definitions.js");
const lib = await import("../scripts/experiments/lib.js");
const { gradeExperiment, gradeAll, actionFor, revertCheck, isBotDeploy, netSol, isWinner, isDisaster, hasField, resolveMode, bootstrapSumCI, bootstrapRatioCI, mulberry32 } = lib;

const NOW = Date.parse("2026-11-23T01:20:00Z");
const def = (id, patch = {}) => ({ ...experimentById(id), ...patch });
let seq = 0;
const rec = (o = {}) => {
  seq++;
  return {
    position: `pos${seq}`,
    pool_name: `P${seq}-SOL`,
    recorded_at: o.at ?? new Date(Date.parse("2026-10-20T00:00:00Z") + seq * 60_000).toISOString(),
    amount_sol: 0.5,
    pnl_pct: 1,
    pnl_sol_net: 0.005,
    ...o,
  };
};
// n tagged + m rest for a boolean tag field; `dis` disasters in each group (pnl −20 %, net −0.1)
function gateSet(field, { nT, disT, netT = 0.005, nR, disR, netR = 0.005 }) {
  const out = [];
  for (let i = 0; i < nT; i++) out.push(i < disT ? rec({ [field]: true, pnl_pct: -20, pnl_sol_net: -0.1 }) : rec({ [field]: true, pnl_sol_net: netT }));
  for (let i = 0; i < nR; i++) out.push(i < disR ? rec({ [field]: false, pnl_pct: -20, pnl_sol_net: -0.1 }) : rec({ [field]: false, pnl_sol_net: netR }));
  return out;
}

test("record conventions: bot filter, net fallback, winner fallback, disaster, carrying", () => {
  assert.equal(isBotDeploy({}), true);
  assert.equal(isBotDeploy({ adopted: true }), false);
  assert.equal(isBotDeploy({ rebalance_leg: true }), false);
  assert.equal(isBotDeploy({ exit_family: "rebalance_leg" }), false);
  assert.equal(isBotDeploy({ close_reason: "rebalance: straddle" }), false);
  assert.equal(isBotDeploy({ close_reason: "Rebalance-failed: x" }), false);
  assert.equal(netSol({ pnl_sol_net: -0.2, pnl_sol: 0.3 }), -0.2);
  assert.equal(netSol({ pnl_sol: 0.3 }), 0.3, "falls back to pnl_sol");
  assert.equal(netSol({}), null);
  assert.equal(isWinner({ pnl_sol_net: -0.01, pnl_pct: 2 }), false, "net decides when present");
  assert.equal(isWinner({ pnl_pct: 2 }), true, "pnl_pct when net is missing");
  assert.equal(isDisaster({ pnl_pct: -10 }), true);
  assert.equal(isDisaster({ pnl_pct: -9.99 }), false);
  assert.equal(hasField({ a: null }, "a"), true);
  assert.equal(hasField({ a: undefined }, "a"), false);
  assert.equal(hasField({}, "a"), false);
});

test("reentry-gate met → promote (enforce built, mode shadow)", () => {
  const recs = gateSet("reentry_gate_would_skip", { nT: 20, disT: 6, nR: 40, disR: 2 });
  const r = gradeExperiment(def("reentry-gate"), recs, { now: NOW });
  assert.equal(r.verdict, "met");
  assert.equal(r.sample.n_tagged, 20);
  assert.equal(r.sample.n_rest, 40);
  assert.equal(r.metrics.tagged.disasters, 6);
  assert.ok(r.checks.every((c) => c.pass === true));
  assert.equal(actionFor(r), "promote");
});

test("reentry-gate threshold reached and not met → drop (rule says 'otherwise drop')", () => {
  const recs = gateSet("reentry_gate_would_skip", { nT: 21, disT: 1, nR: 40, disR: 4 });
  const r = gradeExperiment(def("reentry-gate"), recs, { now: NOW });
  assert.equal(r.verdict, "drop");
  assert.equal(actionFor(r), "drop");
  assert.equal(actionFor({ ...r, mode: "off" }), "none", "already off");
});

test("reentry-gate insufficient before 20 tagged and three weeks; the time arm alone reaches the threshold", () => {
  const recs = gateSet("reentry_gate_would_skip", { nT: 5, disT: 3, nR: 20, disR: 0, netT: -0.01 });
  const early = gradeExperiment(def("reentry-gate"), recs, { now: Date.parse("2026-10-10T00:00:00Z") });
  assert.equal(early.verdict, "insufficient");
  assert.match(early.reason, /15 more tagged closes or until 2026-10-23/);
  assert.equal(actionFor(early), "wait");
  const late = gradeExperiment(def("reentry-gate"), recs, { now: NOW });
  assert.equal(late.threshold.by, "time");
  assert.equal(late.verdict, "met");
});

test("only records carrying the field count; null verdicts and adopted / legs are not in either group", () => {
  const recs = [
    ...gateSet("reentry_gate_would_skip", { nT: 20, disT: 6, nR: 40, disR: 2 }),
    rec({ pnl_pct: -50, pnl_sol_net: -1 }), // no field
    rec({ reentry_gate_would_skip: null, pnl_pct: -50, pnl_sol_net: -1 }),
    rec({ reentry_gate_would_skip: true, adopted: true, pnl_pct: 30, pnl_sol_net: 1 }),
    rec({ reentry_gate_would_skip: true, rebalance_leg: true, pnl_pct: 30, pnl_sol_net: 1 }),
  ];
  const r = gradeExperiment(def("reentry-gate"), recs, { now: NOW });
  assert.equal(r.sample.n_tagged, 20);
  assert.equal(r.sample.n_rest, 40);
  assert.equal(r.metrics.tagged_null_verdict, 1);
  assert.equal(r.metrics.adopted_tagged, 1);
  assert.equal(r.verdict, "met");
});

test("a tagged disaster rate of 0 never passes the ratio check (0 ≥ 2 × 0 is no separation)", () => {
  const recs = gateSet("reentry_gate_would_skip", { nT: 20, disT: 0, netT: -0.01, nR: 20, disR: 0 });
  const r = gradeExperiment(def("reentry-gate"), recs, { now: NOW });
  assert.equal(r.checks[0].pass, false);
  assert.equal(r.verdict, "drop");
});

test("missing pnl_sol_net falls back to pnl_sol in the Σ net check", () => {
  const recs = gateSet("reentry_gate_would_skip", { nT: 20, disT: 6, nR: 40, disR: 2 });
  for (const x of recs.filter((r) => r.reentry_gate_would_skip === true && r.pnl_pct === -20)) { delete x.pnl_sol_net; x.pnl_sol = 0.5; }
  const r = gradeExperiment(def("reentry-gate"), recs, { now: NOW });
  assert.equal(r.metrics.tagged.net_from_pnl_sol_fallback, 6);
  assert.equal(r.metrics.tagged.net_sol, 3.07); // 6 × 0.5 + 14 × 0.005
  assert.equal(r.checks[1].pass, false);
  assert.equal(r.verdict, "drop");
});

test("fee-edge: met → build_enforce (enforce not built); not met → not_met with action none (no drop clause)", () => {
  const met = gradeExperiment(def("fee-edge"), gateSet("fee_edge_gate_would_skip", { nT: 30, disT: 9, nR: 60, disR: 3 }), { now: NOW });
  assert.equal(met.verdict, "met");
  assert.equal(actionFor(met), "build_enforce");
  const nm = gradeExperiment(def("fee-edge"), gateSet("fee_edge_gate_would_skip", { nT: 30, disT: 3, nR: 60, disR: 6 }), { now: NOW });
  assert.equal(nm.verdict, "not_met");
  assert.equal(actionFor(nm), "none");
  const ins = gradeExperiment(def("fee-edge"), gateSet("fee_edge_gate_would_skip", { nT: 29, disT: 9, nR: 60, disR: 3 }), { now: NOW });
  assert.equal(ins.verdict, "insufficient", "no time arm: 29 tagged after 50 days is still insufficient");
});

test("pump-gate: not met between 20 and 40 tagged → not_met; at 40 → drop", () => {
  const a = gradeExperiment(def("pump-gate"), gateSet("pump_gate_would_skip", { nT: 25, disT: 1, nR: 50, disR: 5 }), { now: NOW });
  assert.equal(a.verdict, "not_met");
  assert.equal(actionFor(a), "none");
  const b = gradeExperiment(def("pump-gate"), gateSet("pump_gate_would_skip", { nT: 40, disT: 2, nR: 50, disR: 5 }), { now: NOW });
  assert.equal(b.verdict, "drop");
  assert.equal(actionFor(b), "drop");
  const c = gradeExperiment(def("pump-gate"), gateSet("pump_gate_would_skip", { nT: 20, disT: 8, nR: 50, disR: 5 }), { now: NOW });
  assert.equal(c.verdict, "met");
  assert.equal(actionFor(c), "promote");
});

test("robust: the single largest-|net| tagged record is removed and the checks re-run", () => {
  const recs = gateSet("reentry_gate_would_skip", { nT: 20, disT: 6, nR: 40, disR: 2 });
  recs.push(rec({ reentry_gate_would_skip: true, pnl_pct: 66, pnl_sol_net: 5 })); // makes Σ net positive
  const r = gradeExperiment(def("reentry-gate"), recs, { now: NOW });
  assert.equal(r.checks[1].pass, false);
  assert.equal(r.verdict, "drop");
  assert.equal(r.robust.removed.net_sol, 5);
  assert.equal(r.robust.checks[1].pass, true);
  assert.equal(r.robust.all_pass, true, "the verdict hangs on one record");
});

test("bootstrap is deterministic (seeded) and brackets the observed Σ", () => {
  const v = [0.1, -0.2, 0.05, 0.3, -0.01, 0.02];
  const a = bootstrapSumCI(v), b = bootstrapSumCI(v);
  assert.deepEqual(a, b);
  assert.ok(a.lo <= 0.26 && a.hi >= 0.26);
  assert.equal(bootstrapSumCI([]), null);
  const r1 = bootstrapRatioCI([1, 0, 0, 1], [0, 0, 0, 1, 0, 0]);
  assert.deepEqual(r1, bootstrapRatioCI([1, 0, 0, 1], [0, 0, 0, 1, 0, 0]));
  const g = mulberry32(42);
  const first = [g(), g(), g()];
  const h = mulberry32(42);
  assert.deepEqual([h(), h(), h()], first);
  const recs = gateSet("reentry_gate_would_skip", { nT: 20, disT: 6, nR: 40, disR: 2 });
  const x = gradeExperiment(def("reentry-gate"), recs, { now: NOW });
  const y = gradeExperiment(def("reentry-gate"), recs, { now: NOW });
  assert.deepEqual(x.metrics.ci90_tagged_net_sol, y.metrics.ci90_tagged_net_sol);
  assert.deepEqual(x.metrics.ci90_disaster_ratio, y.metrics.ci90_disaster_ratio);
  assert.equal(x.verdict, "met", "the CI is context, not part of the rule");
});

const probe = (o) => rec({ first_entry: true, first_entry_probation: { mode: "shadow", pnl_pct: -8.5, minutes_since_deploy: 60 }, amount_sol: 1, ...o });

test("first-entry-probation: Σ net ÷ Σ capital < −8 % AND ≤ 1/4 winners → met → promote", () => {
  const recs = [
    ...Array.from({ length: 12 }, () => probe({ pnl_pct: -15, pnl_sol_net: -0.15 })),
    ...Array.from({ length: 3 }, () => probe({ pnl_pct: 3, pnl_sol_net: 0.03 })),
    ...Array.from({ length: 10 }, () => rec({ first_entry: true, first_entry_probation: null })),
    rec({ first_entry: false, first_entry_probation: null }),
  ];
  const r = gradeExperiment(def("first-entry-probation"), recs, { now: NOW });
  assert.equal(r.sample.n_tagged, 15);
  assert.equal(r.sample.n_rest, 10, "rest = first entries without a would-fire");
  assert.equal(r.metrics.would_fire.net_pct_on_capital, -11.4); // (−1.8 + 0.09) / 15
  assert.equal(r.metrics.would_fire.winner_share, 0.2);
  assert.equal(r.verdict, "met");
  assert.equal(actionFor(r), "promote");
});

test("first-entry-probation: capital-weighted, not the mean of percents; 2 of 3 winners fails; time arm decides", () => {
  const recs = [
    probe({ pnl_pct: -20, pnl_sol_net: -0.2, amount_sol: 1 }),
    probe({ pnl_pct: 5, pnl_sol_net: 0.5, amount_sol: 10 }),
    probe({ pnl_pct: 1, pnl_sol_net: 0.01, amount_sol: 1 }),
  ];
  const before = gradeExperiment(def("first-entry-probation"), recs, { now: Date.parse("2026-10-30T00:00:00Z") });
  assert.equal(before.verdict, "insufficient");
  const r = gradeExperiment(def("first-entry-probation"), recs, { now: NOW });
  assert.equal(r.verdict, "not_met");
  assert.equal(r.checks[0].pass, false);
  assert.equal(r.checks[1].pass, false);
  assert.equal(actionFor(r), "none");
});

const cf = (delta, affected = true, o = {}) => rec({ max_hold_cf: { version: 1, grid: { "360": { pnl_at: 1, state_at: affected ? "in" : "above", delta_sol: delta, affected } } }, ...o });

test("max-hold: reuses max-hold.js; met with ≥ 30 affected closes and every check passing", () => {
  const recs = [];
  for (let i = 0; i < 30; i++) recs.push(cf(i % 3 === 0 ? -0.002 : 0.01));
  recs.push(cf(0.5, false));
  const r = gradeExperiment(def("max-hold"), recs, { now: NOW });
  assert.equal(r.sample.n_tagged, 30);
  assert.equal(r.sample.n_rest, 1);
  assert.equal(r.metrics.row_at_cap.n, 30);
  assert.ok(r.checks.every((c) => c.pass === true), JSON.stringify(r.checks));
  assert.equal(r.verdict, "met");
  assert.equal(actionFor(r), "promote");
});

test("max-hold: insufficient under 30 affected before 6 weeks; a worst truncation > ½ Σ fails", () => {
  const few = [cf(0.01), cf(0.02)];
  const ins = gradeExperiment(def("max-hold"), few, { now: NOW });
  assert.equal(ins.verdict, "insufficient");
  assert.match(ins.reason, /28 more tagged closes or until 2026-12-19/);
  const recs = [];
  for (let i = 0; i < 30; i++) recs.push(cf(0.01));
  recs.push(cf(-0.2));
  const r = gradeExperiment(def("max-hold"), recs, { now: NOW });
  assert.equal(r.checks.find((c) => /worst/.test(c.name)).pass, false);
  assert.equal(r.verdict, "not_met");
  assert.equal(r.robust.removed.delta_sol, -0.2);
  assert.equal(r.robust.all_pass, true);
});

test("max-hold honours maxHoldMinutes from --config (cap 480)", () => {
  const recs = [rec({ max_hold_cf: { version: 1, grid: { "360": { delta_sol: 0.1, affected: true }, "480": { delta_sol: -0.1, affected: true } } } })];
  const r = gradeExperiment(def("max-hold"), recs, { now: NOW, cfg: { maxHoldMinutes: 480 } });
  assert.equal(r.metrics.cap_min, 480);
  assert.equal(r.metrics.row_at_cap.sum, -0.1);
});

test("trail-straddle-trigger: insufficient under 30, and still insufficient at 30 because the gain is not in the records", () => {
  const tss = (verdict, m60) => rec({ straddle_count: 1, trail_straddle_shadow: { trigger: 3, verdict, live_peak_pct: 2.5, live_fire_pct: 1 }, post_close: { m60: { pct: m60 } } });
  const few = gradeExperiment(def("trail-straddle-trigger"), [tss("would_hold", 5), tss("same", 1)], { now: NOW });
  assert.equal(few.verdict, "insufficient");
  assert.match(few.reason, /28 more tagged closes/);
  const many = gradeExperiment(def("trail-straddle-trigger"), Array.from({ length: 30 }, (_, i) => tss(i % 2 ? "would_hold" : "same", 5)), { now: NOW });
  assert.equal(many.verdict, "insufficient");
  assert.match(many.reason, /not in the records/);
  assert.equal(many.checks[0].pass, true);
  assert.equal(many.checks[1].pass, null);
  assert.equal(many.metrics.tail_risk_pp, 15 * 16, "(1 − (−15)) per would-hold case");
  assert.equal(actionFor(many), "wait");
});

test("mode resolution: config value, code default, rule-mode parse; enforce → already_enforced → no action", () => {
  assert.equal(resolveMode(def("reentry-gate"), {}).mode, "shadow");
  assert.equal(resolveMode(def("reentry-gate"), { reentryGateMode: "off" }).mode, "off");
  assert.equal(resolveMode(def("first-entry-probation"), { firstEntryProbationMode: "ENFORCE" }).mode, "shadow", "case-sensitive key: an unknown value reads as shadow");
  assert.equal(resolveMode(def("trail-straddle-trigger"), { trailStraddleShadowTrigger: 0 }).mode, "off");
  assert.equal(resolveMode(def("trail-straddle-trigger"), {}).value, 3);
  const recs = gateSet("reentry_gate_would_skip", { nT: 20, disT: 6, nR: 40, disR: 2 });
  const r = gradeExperiment(def("reentry-gate"), recs, { now: NOW, cfg: { reentryGateMode: "enforce" } });
  assert.equal(r.verdict, "already_enforced");
  assert.match(r.reason, /would be 'met'/);
  assert.equal(actionFor(r), "none");
  const ps = gradeExperiment(def("post-stop-cooldown"), [rec({ post_stop_gate_would_skip: false })], { now: NOW, cfg: { postStopCooldownMode: "enforce" } });
  assert.equal(ps.verdict, "already_enforced");
  const ps2 = gradeExperiment(def("post-stop-cooldown"), [rec({ post_stop_gate_would_skip: false })], { now: NOW });
  assert.equal(ps2.verdict, "report_only");
});

test("action_list mapping", () => {
  const base = { enforceBuilt: true, mode: "shadow" };
  assert.equal(actionFor({ ...base, verdict: "met", robust: { all_pass: true } }), "promote");
  assert.equal(actionFor({ ...base, verdict: "met" }), "escalate", "no robust re-run → the operator decides");
  assert.equal(actionFor({ ...base, enforceBuilt: false, verdict: "met" }), "build_enforce");
  assert.equal(actionFor({ ...base, mode: "enforce", verdict: "met" }), "none");
  assert.equal(actionFor({ ...base, verdict: "drop" }), "drop");
  assert.equal(actionFor({ ...base, verdict: "insufficient" }), "wait");
  assert.equal(actionFor({ ...base, verdict: "not_met" }), "none");
  assert.equal(actionFor({ ...base, verdict: "report_only" }), "none");
  assert.equal(actionFor({ ...base, verdict: "already_enforced" }), "none");
  const all = gradeAll(EXPERIMENTS, gateSet("reentry_gate_would_skip", { nT: 20, disT: 6, nR: 40, disR: 2 }), { now: NOW, ungraded: UNGRADED });
  assert.equal(all.action_list.length, EXPERIMENTS.length);
  assert.equal(all.action_list.find((a) => a.id === "reentry-gate").action, "promote");
  assert.equal(all.ungraded.length, UNGRADED.length);
});

test("revertCheck: exit rules by exit_family after promotion; entry gates are not gradable from records", () => {
  const P = "2026-11-01T00:00:00Z";
  const close = (v, at = "2026-11-05T00:00:00Z") => rec({ exit_family: "probation_stop", at, post_close: { exit_quality: { verdict: v } } });
  const d = def("first-entry-probation");
  const revert = [...Array.from({ length: 5 }, () => close("early_exit")), close("good_exit"), close("flat"), close("marginal"), close("early_exit", "2026-10-20T00:00:00Z"), close("unprobeable")];
  const r1 = revertCheck(d, revert, P);
  assert.equal(r1.n_scored, 8, "before-promotion and unprobeable closes do not count");
  assert.equal(r1.verdict, "revert");
  const keep = [...Array.from({ length: 4 }, () => close("good_exit")), ...Array.from({ length: 4 }, () => close("early_exit"))];
  assert.equal(revertCheck(d, keep, P).verdict, "keep");
  assert.equal(revertCheck(d, keep.slice(0, 7), P).verdict, "insufficient");
  assert.equal(revertCheck(def("max-hold"), [rec({ exit_family: "max_hold", at: "2026-11-05T00:00:00Z", post_close: { exit_quality: { verdict: "early_exit" } } })], P).verdict, "insufficient");
  for (const id of ["reentry-gate", "pump-gate", "fee-edge"]) {
    const g = revertCheck(def(id), revert, P);
    assert.equal(g.verdict, "not_gradable_from_records");
    assert.equal(g.reason, "enforce blocks the deploys that would be graded; needs the rejected-candidates counterfactual");
  }
  const all = gradeAll(EXPERIMENTS, revert, { now: NOW, promoted: { "first-entry-probation": P } });
  assert.equal(all.revert_checks[0].verdict, "revert");
});

test("definitions: every promotable experiment carries a verbatim rule, a tag field and a threshold", () => {
  for (const d of EXPERIMENTS) {
    assert.ok(d.id && d.configKey && d.tagField && d.grader, d.id);
    if (d.kind !== "report") {
      assert.ok(typeof d.rule === "string" && d.rule.length > 20, d.id);
      assert.ok(Number.isInteger(d.minTagged), d.id);
      assert.ok(d.registeredAt, d.id);
    }
  }
  assert.equal(experimentById("reentry-gate").dropClause, true);
  assert.equal(experimentById("pump-gate").dropAtN, 40);
});

test("CLI: --json on a temp export, unreadable input exits 2", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-grader-"));
  const file = path.join(dir, "performance.json");
  fs.writeFileSync(file, JSON.stringify(gateSet("reentry_gate_would_skip", { nT: 20, disT: 6, nR: 40, disR: 2 })));
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/experiments/grade.js");
  const ok = spawnSync(process.execPath, [script, "--input", file, "--json", "--now", "2026-11-23T01:20:00Z", "--only", "reentry-gate"], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.equal(out.experiments.length, 1);
  assert.equal(out.experiments[0].verdict, "met");
  const human = spawnSync(process.execPath, [script, "--input", file, "--now", "2026-11-23T01:20:00Z"], { encoding: "utf8" });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /reentry-gate\s+shadow\s+20\/20\|21d/);
  const bad = spawnSync(process.execPath, [script, "--input", path.join(dir, "missing.json")], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a recorded decision ends the automatic path; promotion needs the robust re-run to pass", () => {
  const met = gradeExperiment(def("reentry-gate"), gateSet("reentry_gate_would_skip", { nT: 20, disT: 6, nR: 40, disR: 2 }), { now: NOW });
  assert.equal(met.verdict, "met");
  assert.equal(actionFor(met), "promote");
  assert.equal(actionFor(met, { decision: "dropped", at: "2026-11-23" }), "none", "decided → no action");
  assert.equal(actionFor({ ...met, robust: { ...met.robust, all_pass: false } }), "escalate", "met but fragile → the operator decides");
  assert.equal(actionFor({ ...met, robust: null }), "escalate", "no robust re-run → no automatic promotion");
  const rep = gradeAll([def("reentry-gate")], gateSet("reentry_gate_would_skip", { nT: 20, disT: 6, nR: 40, disR: 2 }), { now: NOW, decisions: { "reentry-gate": { decision: "dropped", at: "2026-11-23" } } });
  assert.equal(rep.action_list[0].action, "none");
  assert.equal(rep.action_list[0].decided.decision, "dropped");
  const open = gradeAll([def("reentry-gate")], gateSet("reentry_gate_would_skip", { nT: 20, disT: 6, nR: 40, disR: 2 }), { now: NOW });
  assert.equal(open.action_list[0].action, "promote");
});
