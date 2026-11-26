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

// ── grace-profit-lock (forward stage, registered 2026-11-24) ─────────────────────────────────
const glf = (fire, pnl, o = {}) => rec({
  at: o.at ?? new Date(Date.parse("2026-11-25T00:00:00Z") + (seq + 1) * 60_000).toISOString(),
  amount_sol: 1, pnl_pct: pnl, adopted: o.adopted,
  grace_lock_shadow: { kind: o.kind ?? "straddle", fired_at: o.fired === false ? null : "2026-11-25T00:00:00Z", fire_pnl_pct: o.fired === false ? null : fire, fire_peak_pct: 12, minutes_into_grace: 20, interrupted: o.interrupted ?? null, armed_at: o.armed ?? null },
  ...(o.extra || {}),
});
const NOW_GL = Date.parse("2026-12-30T00:00:00Z");

test("population option: bot_and_operator pools adopted records, legs stay out; default is bot only", () => {
  const d = def("grace-profit-lock");
  assert.equal(d.population, "bot_and_operator");
  assert.equal(lib.inPopulation(d, { adopted: true }), true);
  assert.equal(lib.inPopulation(d, {}), true);
  assert.equal(lib.inPopulation(d, { adopted: true, rebalance_leg: true }), false);
  assert.equal(lib.inPopulation(def("reentry-gate"), { adopted: true }), false, "other experiments: bot deploys only");
  assert.equal(lib.inPopulation({}, {}), true);
  assert.equal(lib.ownerOf({ adopted: true }), "operator");
  assert.equal(lib.ownerOf({}), "bot");
});

test("grace-profit-lock: Δ◎, insufficient under 15 fires (no time arm), interrupted / unfired / pre-capture excluded", () => {
  assert.equal(lib.graceLockDelta({ amount_sol: 2, pnl_pct: -20, grace_lock_shadow: { fire_pnl_pct: 5 } }), 0.5);
  assert.equal(lib.graceLockDelta({ amount_sol: 2, pnl_pct: -20, grace_lock_shadow: { fire_pnl_pct: 5 } }, { costPct: 1 }), 0.48);
  assert.equal(lib.graceLockDelta({ amount_sol: 2, grace_lock_shadow: { fire_pnl_pct: 5 } }), null);
  const recs = [
    ...Array.from({ length: 14 }, (_, i) => glf(5, i % 2 ? -20 : 2, { adopted: i % 3 === 0 })),
    glf(5, -20, { interrupted: "hold" }),
    glf(null, 3, { fired: false, armed: "x" }),
    glf(5, -20, { at: "2026-11-01T00:00:00Z" }), // before the capture went live
    glf(5, -20, { extra: { rebalance_leg: true } }),
  ];
  const r = gradeExperiment(def("grace-profit-lock"), recs, { now: NOW_GL });
  assert.equal(r.sample.n_tagged, 14);
  assert.equal(r.verdict, "insufficient");
  assert.match(r.reason, /1 more tagged closes/);
  assert.equal(r.metrics.interrupted_by_hold, 1);
  assert.equal(r.metrics.armed_not_fired, 1);
  assert.ok(r.metrics.by_owner.operator.n > 0 && r.metrics.by_owner.bot.n > 0, "both owners pooled and reported");
  assert.equal(actionFor(r), "wait");
});

test("grace-profit-lock: the two stored artefact fires (2026-11-25) are excluded and listed; a voided fire is no fire", () => {
  const d = def("grace-profit-lock");
  const ids = Object.keys(d.exclude);
  assert.deepEqual(ids.map((x) => x.slice(0, 8)).sort(), ["5P3jAEQo", "A1BM9YU7"]);
  for (const reason of Object.values(d.exclude)) assert.equal(reason, "fire on a peak built from an unindexed top-up; capture fixed 2026-11-26");
  const art = ids.map((id) => ({ ...glf(1.06, 14.9, { adopted: true, kind: "adoption" }), position: id }));
  const voided = glf(null, 3, { fired: false });
  voided.grace_lock_shadow.voided_fire = { fired_at: "2026-11-25T00:00:00Z", fire_pnl_pct: 1.48, reason: "capital_rebase" };
  const plain = [glf(5, -20), glf(5, 2)];
  const r = gradeExperiment(d, [...art, voided, ...plain], { now: NOW_GL });
  assert.equal(r.metrics.fires.n, 2, "only the two ordinary fires count");
  assert.equal(r.sample.n_tagged, 2);
  assert.equal(r.sample.n_carrying, 3, "excluded records are out of the comparison population too; the voided one is a graded no-fire");
  assert.deepEqual(r.excluded.map((x) => x.position).sort(), [...ids].sort());
  assert.ok(r.excluded.every((x) => x.reason && x.recorded_at));
  assert.ok(!r.metrics.fire_records.some((x) => ids.includes(x.position)));
  // the human rendering names them; a definition without `exclude` carries no field
  const human = lib.formatHuman(gradeAll([d], [...art, ...plain], { now: NOW_GL }));
  assert.match(human, /excluded Pompom-SOL 5P3jAEQo|excluded P\d+-SOL 5P3jAEQo/);
  assert.equal(gradeExperiment(def("reentry-gate"), plain, { now: NOW_GL }).excluded, undefined);
  assert.deepEqual(lib.applyExclusions({}, plain), { kept: plain, excluded: null });
});

test("grace-profit-lock: met → build_enforce (never promote); each check can fail on its own", () => {
  const d = def("grace-profit-lock");
  // 15 fires: 10 better (+0.05 each, lock at 5 vs final 0), 5 worse (−0.02 each)
  const good = () => [...Array.from({ length: 10 }, (_, i) => glf(5, 0, { kind: i % 2 ? "adoption" : "straddle", adopted: i % 2 === 1 })), ...Array.from({ length: 5 }, () => glf(5, 7))];
  const met = gradeExperiment(d, good(), { now: NOW_GL });
  assert.equal(met.verdict, "met", met.reason);
  assert.equal(met.enforceBuilt, false);
  assert.equal(actionFor(met), "build_enforce", "an enforce path is proposed, never promoted");
  assert.equal(actionFor({ ...met, robust: { all_pass: true } }), "build_enforce");
  assert.ok(Math.abs(met.metrics.fires.sum_delta_sol - 0.4) < 1e-9);
  assert.equal(met.metrics.by_kind.adoption.n, 5);
  // 4: better ≥ 1.5 × worse — 9 / 6 is exactly 1.5 × (passes), 8 / 7 fails
  const bw9 = [...Array.from({ length: 9 }, () => glf(5, -5)), ...Array.from({ length: 6 }, () => glf(5, 6))];
  assert.equal(gradeExperiment(d, bw9, { now: NOW_GL }).checks.find((c) => /better/.test(c.name)).pass, true);
  const bw = [...Array.from({ length: 8 }, () => glf(5, -5)), ...Array.from({ length: 7 }, () => glf(5, 6))];
  const rbw = gradeExperiment(d, bw, { now: NOW_GL });
  assert.equal(rbw.checks.find((c) => /better/.test(c.name)).pass, false);
  assert.equal(rbw.verdict, "not_met");
  assert.equal(actionFor(rbw), "none");
  // 5: one large truncation > ½ Σ fails
  const tr = [...Array.from({ length: 14 }, () => glf(5, 0)), glf(5, 50)];
  assert.equal(gradeExperiment(d, tr, { now: NOW_GL }).checks.find((c) => /worst/.test(c.name)).pass, false);
  // 7: cost-robust — 15 fires of +0.5 pp each fail once 1 % of capital is charged
  const thin = Array.from({ length: 15 }, () => glf(5, 4.5));
  const rt = gradeExperiment(d, thin, { now: NOW_GL });
  assert.equal(rt.checks.find((c) => /charged/.test(c.name)).pass, false);
  assert.equal(rt.checks.find((c) => c.name === "Σ Δ◎ > 0").pass, true);
  // 6: halves by close time
  const hv = [...Array.from({ length: 7 }, () => glf(5, 6)), ...Array.from({ length: 8 }, () => glf(5, -5))];
  assert.equal(gradeExperiment(d, hv, { now: NOW_GL }).checks.find((c) => /halves/.test(c.name)).pass, false);
  // ties: |Δ| ≤ ◎0.0005 is neither better nor worse
  const ties = gradeExperiment(d, [...Array.from({ length: 15 }, () => glf(5, 5.02))], { now: NOW_GL });
  assert.equal(ties.metrics.fires.ties, 15);
});

// ── reading-guard (registered 2026-11-25; episodes pooled across records) ────────────────────
const rgc = (o = {}) => ({ reverted: 0, capital_rebase: 0, persisted: 0, closed: 0, hold: 0, unresolved: 0, trusted: 0, trusted_effect: 0, persisted_stop_class: 0, ...o });
const rgr = (episodes, counts, o = {}) => rec({
  at: o.at ?? new Date(Date.parse("2026-11-26T00:00:00Z") + (seq + 1) * 60_000).toISOString(),
  adopted: o.adopted,
  reading_guard_shadow: { episodes, recent: [], open: null, counts: rgc(counts) },
  ...(o.extra || {}),
});
const NOW_RG = Date.parse("2026-12-10T00:00:00Z");

test("reading-guard: definition, threshold (12 episodes on 6 positions, or 2027-01-06), met → build_enforce", () => {
  const d = def("reading-guard");
  assert.equal(d.population, "bot_and_operator");
  assert.equal(d.enforceBuilt, false);
  assert.equal(new Date(Date.parse(d.shadowSince) + d.minDays * 86_400_000).toISOString().slice(0, 10), "2027-01-06");
  // 12 episodes on 5 positions: not enough positions
  const five = Array.from({ length: 5 }, (_, i) => rgr(i < 2 ? 4 : 1 + (i === 4 ? 1 : 0), { reverted: i < 2 ? 4 : 1 + (i === 4 ? 1 : 0), trusted: 1, trusted_effect: i < 2 ? 1 : 0 }));
  const r5 = gradeExperiment(d, five, { now: NOW_RG });
  assert.equal(r5.metrics.episodes, 12);
  assert.equal(r5.metrics.positions, 5);
  assert.equal(r5.verdict, "insufficient");
  assert.equal(actionFor(r5), "wait");
  // 12 on 6, 11 explained, 2 trusted with effect, nothing persisted with a stop → met
  const six = [...Array.from({ length: 5 }, () => rgr(2, { reverted: 2, trusted: 1 })), rgr(2, { capital_rebase: 1, closed: 1, trusted: 2, trusted_effect: 2 }, { adopted: true }), rgr(0, {})];
  const met = gradeExperiment(d, six, { now: NOW_RG });
  assert.equal(met.verdict, "met", met.reason);
  assert.equal(actionFor(met), "build_enforce", "never promote: no enforce path exists");
  assert.equal(met.metrics.by_end.closed, 1);
  assert.equal(met.metrics.by_owner.operator.positions, 1);
  assert.equal(met.sample.n_rest, 1, "a record carrying the field without an episode");
  // the time arm reaches the threshold with few episodes
  const late = gradeExperiment(d, [rgr(1, { reverted: 1, trusted: 1, trusted_effect: 1 })], { now: Date.parse("2027-01-07T00:00:00Z") });
  assert.equal(late.threshold.by, "time");
  assert.equal(late.verdict, "drop", "check 4 fails at the threshold → drop");
  assert.match(late.reason, /drop clause/);
  // pre-capture and rebalance legs are out
  const out = gradeExperiment(d, [rgr(3, { reverted: 3 }, { at: "2026-11-01T00:00:00Z" }), rgr(3, { reverted: 3 }, { extra: { rebalance_leg: true } })], { now: NOW_RG });
  assert.equal(out.metrics.episodes, 0);
});

test("reading-guard: checks 2 / 3 / 4, the drop clause and the recount fallback", () => {
  const d = def("reading-guard");
  const base = (o) => Array.from({ length: 6 }, (_, i) => rgr(2, { reverted: 2, trusted: 1, trusted_effect: i < 2 ? 1 : 0, ...(i === 0 ? o : {}) }));
  // check 3: a persisted episode with a stop-class signal → not met (no drop: checks 2 and 4 pass)
  const c3 = gradeExperiment(d, base({ reverted: 1, persisted: 1, persisted_stop_class: 1 }), { now: NOW_RG });
  assert.equal(c3.checks[1].pass, false);
  assert.equal(c3.verdict, "not_met");
  // check 2 between 50 % and 80 % → not met; under 50 % → drop
  const mid = Array.from({ length: 6 }, (_, i) => rgr(2, { reverted: i < 4 ? 2 : 0, persisted: i < 4 ? 0 : 2, trusted: 1, trusted_effect: i < 2 ? 1 : 0 }));
  const rmid = gradeExperiment(d, mid, { now: NOW_RG });
  assert.equal(rmid.checks[0].value, 0.6667);
  assert.equal(rmid.verdict, "not_met");
  const low = Array.from({ length: 6 }, (_, i) => rgr(2, { reverted: i < 2 ? 2 : 0, persisted: i < 2 ? 0 : 2, trusted: 1, trusted_effect: i < 2 ? 1 : 0 }));
  assert.equal(gradeExperiment(d, low, { now: NOW_RG }).verdict, "drop");
  // fallback: a record without stored counts is recounted from its kept episodes
  const c = lib.readingGuardCounts({ recent: [
    { ended: "reverted", already_suspect: false, peak_confirmed: true },
    { ended: "persisted", already_suspect: true, exit_signal: "STOP_LOSS", exit_signal_family: "stop_loss" },
  ] }, d);
  assert.deepEqual([c.episodes, c.reverted, c.persisted, c.trusted, c.trusted_effect, c.persisted_stop_class], [2, 1, 1, 1, 1, 1]);
});
