process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const {
  minDeployAmountSol, stripCallerDeployTags, isLowConvictionRequest,
  applyLowConvictionSize, timingSizeDownAmount,
} = await import("../deploy-sizing.js");
const { config, computeDeployAmount } = await import("../config.js");

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const MIN = minDeployAmountSol(0.4);

// The executor's order: strip caller tags, (scout clamp), lower-conviction size, then
// the minimum check — replayed here on the pure helpers.
function runSizing(args, { scout = false, deployAmountSol = 0.4 } = {}) {
  stripCallerDeployTags(args);
  const min = minDeployAmountSol(deployAmountSol);
  const low = applyLowConvictionSize(args, min, { skip: scout });
  const amount = args.amount_y ?? args.amount_sol ?? 0;
  const minDeploy = scout ? 0.05 : min;
  return { low, amount, refused: amount <= 0 || amount < minDeploy };
}

test("minimum deploy amount is the executor's expression", () => {
  assert.equal(MIN, 0.4);
  assert.equal(minDeployAmountSol(0.05), 0.1);
});

test('conviction="low": the amount becomes the minimum, larger or smaller, and is tagged', () => {
  for (const passed of [1.25, 0.4, 0.25, 0.05]) {
    const args = { pool_address: "P", amount_y: passed, conviction: "low" };
    const r = runSizing(args);
    assert.equal(args.amount_y, 0.4, `amount_y ${passed}`);
    assert.equal(args.low_conviction, true);
    assert.equal(r.refused, false);
    assert.deepEqual(r.low, { requested: true, applied: true, from: passed, to: 0.4 });
    assert.ok(!("conviction" in args) && !("tier" in args), "sizing params never reach deployPosition");
  }
  // amount_sol spelling, and no amount at all.
  const a = { amount_sol: 2, conviction: "LOW" };
  runSizing(a);
  assert.equal(a.amount_sol, 0.4);
  assert.equal(a.amount_y, undefined);
  const b = { conviction: "low" };
  assert.equal(runSizing(b).refused, false);
  assert.equal(b.amount_y, 0.4);
});

test('legacy tier="probe" is read as conviction="low", not refused', () => {
  const args = { amount_y: 0.25, tier: "probe" };
  const r = runSizing(args);
  assert.equal(r.refused, false);
  assert.equal(args.amount_y, 0.4);
  assert.equal(args.low_conviction, true);
  assert.equal(args.probe, undefined, "new deploys never carry the probe tag");
  assert.ok(!("tier" in args));
  assert.equal(isLowConvictionRequest({ tier: "full" }), false);
  assert.equal(isLowConvictionRequest({ tier: "probe", conviction: "full" }), true);
});

test("conviction omitted or full: amount untouched, below-minimum still refused", () => {
  for (const conviction of [undefined, "full", "", "medium"]) {
    const args = { amount_y: 1.25, ...(conviction !== undefined ? { conviction } : {}) };
    const r = runSizing(args);
    assert.equal(args.amount_y, 1.25);
    assert.equal(args.low_conviction, undefined);
    assert.equal(r.low.applied, false);
    assert.equal(r.refused, false);
    assert.ok(!("conviction" in args));
  }
  // No exemption from the minimum any more (the old probe size was 0.25).
  assert.equal(runSizing({ amount_y: 0.25 }).refused, true);
  assert.equal(runSizing({ amount_y: 0.25, tier: "full" }).refused, true);
});

test("caller-supplied tags are stripped; only the executor sets them", () => {
  const args = { amount_y: 1, low_conviction: true, probe: true, scout: true };
  const r = runSizing(args);
  assert.equal(r.low.applied, false);
  assert.equal(args.amount_y, 1);
  for (const k of ["low_conviction", "probe", "scout"]) assert.ok(!(k in args), `${k} must be stripped`);
});

test("a scout keeps its own clamp", () => {
  const args = { amount_y: 0.15, conviction: "low" };
  const r = runSizing(args, { scout: true });
  assert.equal(args.amount_y, 0.15);
  assert.equal(args.low_conviction, undefined);
  assert.equal(r.low.requested, true);
  assert.ok(!("conviction" in args));
});

test("no slot cap, no switch, no size exemption left in the executor", () => {
  const exec = read("../tools/executor.js");
  for (const gone of ["probeTierEnabled", "probeSizeSol", "probeMaxPositions", "Probe limit reached", "Probe tier is disabled", "args.probe = true", "[PROBE]"]) {
    assert.ok(!exec.includes(gone), `${gone} must be gone from the executor`);
  }
  assert.match(exec, /stripCallerDeployTags\(args\);/);
  assert.match(exec, /applyLowConvictionSize\(args, minDeploySol, \{ skip: !!poolThresholds\.scoutTier \}\)/);
  assert.match(exec, /const minDeploy = poolThresholds\.scoutTier \? 0\.05 : minDeploySol;/);
  assert.match(exec, /\[MIN_SIZE\] /);
  // The helper takes no position list, so several open lower-conviction positions cannot block another.
  const open = [{ low_conviction: true }, { low_conviction: true }, { probe: true }];
  for (const _ of open) assert.equal(runSizing({ amount_y: 1, conviction: "low" }).refused, false);
  const cfg = read("../config.js");
  for (const gone of ["u.probeTierEnabled", "u.probeSizeSol", "u.probeMaxPositions"]) assert.ok(!cfg.includes(gone));
  for (const k of ["probeTierEnabled", "probeSizeSol", "probeMaxPositions"]) assert.ok(!(k in config.screening), `${k} must not be a config key`);
});

test("tool schema and both prompts say the same thing", () => {
  const defs = read("../tools/definitions.js");
  assert.match(defs, /conviction: \{\s+type: "string",\s+enum: \["full", "low"\]/);
  assert.ok(!defs.includes('"probe"'));
  for (const f of ["../prompt.js", "../index.js"]) {
    const src = read(f);
    assert.ok(!/PROBE TIER|tier="probe"|probeTierEnabled|probeSizeSol/.test(src), `${f} still mentions the probe tier`);
    assert.match(src, /LOWER CONVICTION: if the best candidate is safety-clean but you are less sure, /);
    assert.match(src, /conviction="low" instead of NO DEPLOY — the executor sizes it at \$\{minDeployAmountSol\(config\.management\.deployAmountSol\)\} SOL whatever amount you pass\. Use it for conviction gaps only, never to get around a safety flag or a hard skip rule\./);
  }
});

test("timing size-down never goes below the minimum, nor above the un-reduced size", () => {
  const saved = { ...config.management }, savedMax = config.risk.maxDeployAmount;
  Object.assign(config.management, { deployAmountSol: 0.4, positionSizePct: 0.5, gasReserve: 0.2 });
  config.risk.maxDeployAmount = 50;
  try {
    // Small wallet: 1.2 SOL free → 0.5 SOL; half is 0.25 < 0.4 → exactly the minimum.
    const small = computeDeployAmount(1.2);
    assert.equal(small, 0.5);
    assert.deepEqual(timingSizeDownAmount(small, 0.5, MIN), { amount: 0.4, floored: true });
    // At the computeDeployAmount floor itself the "reduced" amount is the full amount.
    assert.deepEqual(timingSizeDownAmount(computeDeployAmount(0.7), 0.5, MIN), { amount: 0.4, floored: true });
    // Large wallet: the halved size stands.
    const large = computeDeployAmount(10.2);
    assert.equal(large, 5);
    assert.deepEqual(timingSizeDownAmount(large, 0.5, MIN), { amount: 2.5, floored: false });
    assert.deepEqual(timingSizeDownAmount(0.8, 0.5, MIN), { amount: 0.4, floored: false });
  } finally {
    Object.assign(config.management, saved);
    config.risk.maxDeployAmount = savedMax;
  }
  // Never above the un-reduced amount (maxDeployAmount under the minimum, multiplier > 1).
  assert.deepEqual(timingSizeDownAmount(0.3, 0.5, MIN), { amount: 0.3, floored: true });
  assert.equal(timingSizeDownAmount(1, 1.5, MIN).amount, 1);
  const idx = read("../index.js");
  assert.match(idx, /timingSizeDownAmount\(deployAmount, timingGate\.sizeMultiplier, minDeploySol\)/);
  assert.match(idx, /floored at the \$\{minDeploySol\} SOL minimum/);
  // The goal line is built after the gate, from the same variable.
  assert.ok(idx.indexOf("deployAmount = sized.amount;") < idx.indexOf("| Deploy: ${deployAmount} SOL"));
});

test("low_conviction travels deploy → position row → the three perf-record sites; probe is still read", () => {
  const dlmm = read("../tools/dlmm.js");
  const state = read("../state.js");
  assert.match(dlmm, /low_conviction: low_conviction \|\| undefined,\n\s+entry_price_change_pct,/); // trackPosition
  assert.equal((dlmm.match(/low_conviction: snapshot\.low_conviction \|\| undefined,/g) || []).length, 1);
  assert.equal((dlmm.match(/low_conviction: tracked\.low_conviction \|\| undefined,/g) || []).length, 2);
  assert.equal((dlmm.match(/probe: (snapshot|tracked)\.probe \|\| undefined,/g) || []).length, 3);
  assert.match(state, /low_conviction: !!low_conviction,/);
  assert.match(state, /low_conviction: !!extra\.low_conviction,/);
  assert.match(state, /probe: !!probe,/);
});
