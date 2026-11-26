/**
 * The two grace shadows across an operator capital change (2026-11-26) — record only.
 *
 * grace-lock-shadow.js (`grace_lock_shadow`, experiment grace-profit-lock) and grace-shadow.js
 * (`grace_shadow`) keep an in-grace confirmed peak of their own. Until Meteora indexes an operator
 * top-up (~2–4 min) the valuation reads the deposit as profit and the live path trusts it while the
 * divergence is under 50 pp; the capital reconciler then books it (capital-rebase.js) — but did not
 * touch the shadows' peaks, and the feed ran before the evaluator's reconcile, so the settle tick's
 * true low reading "fired" the lock. Both forward fires so far were this:
 *   Pompom-SOL 5P3jAEQo  ◎1.4998 → ◎2.0    shadow peak 34.71 % → "fired" at 1.06 %
 *   Pompom-SOL A1BM9YU7  ◎2.0    → ◎2.469  shadow peak 23.62 % → "fired" at 1.48 % (settle tick)
 * Now: the reconcile resets both simulations (and voids a fire stamped ≤ 10 min before it), the
 * state feed functions take no reading while `capital_rebase_pending` is set, and index.js feeds
 * the shadows AFTER the evaluator (tick order replayed here: evaluator, then the two feeds).
 */
process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";

const S = await import("../state.js");
const L = await import("../grace-lock-shadow.js");
const G = await import("../grace-shadow.js");
const { buildPerfRecord } = await import("../perf-record.js");
const { config } = await import("../config.js");
await S.ensureStateInitialized();

const MG = {
  ...config.management,
  adoptedProfitGraceMinutes: 60, harvestStraddleGraceMinutes: 60,
  graceLockShadowMode: "shadow", graceLockShadowArmPct: 10, graceLockShadowDropPct: 5,
  graceShadowEnabled: true, trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, trailingOvershootPct: 0.5,
  takeProfitPct: null, stopLossPct: -15, profitGraceStopLossMode: "paused",
};
const OFF = { ...MG, graceLockShadowMode: "off", graceShadowEnabled: false };

let n = 0;
/** An adopted operator position whose adoption grace began 10 min ago. */
function mk(amount) {
  const P = `GRACECAP_${Date.now()}_${++n}`;
  S.trackPosition({ position: P, pool: `POOL_${P}`, pool_name: "Pompom-SOL", strategy: "spot", amount_sol: amount, initial_value_usd: amount * 140, bin_range: { min: -150, max: -81 }, active_bin: -100, bin_step: 100, adopted: true });
  S.getTrackedPosition(P).adopted_at = new Date(Date.now() - 10 * 60_000).toISOString();
  return P;
}
const row = (P, pnl, bin, net) => ({
  position: P, pool: `POOL_${P}`, pair: "Pompom-SOL", pnl_pct: pnl, effective_pnl_pct: pnl, in_range: true,
  active_bin: bin, lower_bin: -150, upper_bin: -81, pnl_quality: "valid", pnl_basis: "sol",
  pnl_management_ready: true, pnl_pct_suspicious: false, net_deposit_sol: net,
});
/** One poller tick in index.js order (fresh, not suspect): evaluator, then the two shadow feeds. */
function tick(P, r, nowMs, mg = MG) {
  const exit = S.updatePnlAndCheckExits(P, r, mg);
  S.noteGraceShadowReading(P, r.pnl_pct, { confirmTicks: 2, nowMs }, mg);
  S.noteGraceLockShadowReading(P, r.pnl_pct, { activeBin: r.active_bin, nowMs }, mg);
  return exit;
}
/** Readings as [pnl, bin, net]; ticks 5 s apart, the last one ~now (the reconcile uses the real clock). */
function replay(P, seq, mg = MG) {
  const t0 = Date.now() - seq.length * 5000;
  return seq.map(([pnl, bin, net], i) => tick(P, row(P, pnl, bin, net), t0 + i * 5000, mg));
}
const done = (P) => { try { S.recordClose(P, "test"); } catch { /* cleanup */ } };

// 0.2 % at bin -100, then ~2 min of the unindexed top-up read as profit at a bin 5 LOWER.
const FAKE = (c0) => [
  [0.2, -100, c0], [0.25, -101, c0],
  ...Array.from({ length: 24 }, (_, i) => [34.0 + 0.03 * i, -105, c0]),
];

test("pure module first: the same readings with no capital reset DO fire the lock (the artefact)", () => {
  const p = { position: "X", pool_name: "Pompom-SOL", adopted: true, adopted_at: new Date(Date.now() - 600_000).toISOString() };
  const t0 = Date.now() - 60_000;
  const seq = [...FAKE(2.0), [1.30, -105], [1.06, -105]];
  const ev = seq.map(([pnl, bin], i) => L.advanceGraceLockShadow(p, { pnlPct: pnl, activeBin: bin, nowMs: t0 + i * 1000, mgmt: MG }).event);
  assert.equal(ev.at(-1), "fired");
  assert.ok(p.grace_lock_shadow.fire_peak_pct > 30);
});

for (const [name, c0, c1, low1, low2] of [
  ["A1BM9YU7 (◎2.0 → ◎2.469, fired at 1.48 % on the settle tick)", 2.0, 2.469, 1.62, 1.48],
  ["5P3jAEQo (◎1.4998 → ◎2.0, fired at 1.06 %)", 1.4998, 2.0, 1.30, 1.06],
]) {
  test(`Pompom-SOL ${name}: fake-high readings → capital tick → settle at the true low — no fire, one reset`, () => {
    const P = mk(c0);
    try {
      replay(P, [
        ...FAKE(c0),
        [low1, -105, c1],          // capital tick: the evaluator books the top-up; the feeds skip it
        [low2, -105, c1],          // settle tick: the re-base settles, then the feed seeds the new peak
        [low2 + 0.04, -104, c1], [low2 + 0.1, -104, c1], [low2 + 0.05, -105, c1],
      ]);
      const pos = S.getTrackedPosition(P);
      assert.equal(pos.amount_sol, c1, "capital booked");
      assert.equal(pos.capital_rebase_pending ?? null, null, "re-base settled");
      const l = pos.grace_lock_shadow;
      assert.equal(l.fired_at, null, "no lock fire");
      assert.equal(l.voided_fire ?? null, null, "nothing to void");
      assert.equal(l.capital_resets, 1);
      assert.ok(l.last_capital_reset_at);
      assert.ok(l.peak_pct < 2, `peak re-seeded on the new capital (got ${l.peak_pct})`);
      assert.equal(l.armed_at, null);
      assert.equal(l.kind, "adoption");
      assert.equal(l.readings, 26 + 4, "readings counter kept across the reset (the capital tick is not fed)");
      const g = pos.grace_shadow;
      assert.equal(g.no_grace_rule, null, "no no-grace trailing fire");
      assert.equal(g.voided_fire ?? null, null);
      assert.equal(g.capital_resets, 1);
      assert.ok(g.sim_peak_pct < 2 && g.peak_pct < 2, `grace_shadow peaks re-seeded (sim ${g.sim_peak_pct}, raw ${g.peak_pct})`);
      // both reach the perf record whole
      const rec = buildPerfRecord({ source: "closed_api", tracked: pos, close: {}, extra: {} });
      assert.equal(rec.grace_lock_shadow.capital_resets, 1);
      assert.ok(rec.grace_lock_shadow.last_capital_reset_at);
      assert.equal(rec.grace_shadow.capital_resets, 1);
    } finally { done(P); }
  });
}

test("a lock fire stamped inside the pre-index window is voided and the simulation continues from the reset", () => {
  const P = mk(2.0);
  try {
    replay(P, [
      ...FAKE(2.0),
      [25.0, -105, 2.0], [24.0, -105, 2.0], // still on the old net: two breaches of 34 − 5 → the lock fires
    ]);
    let l = S.getTrackedPosition(P).grace_lock_shadow;
    assert.ok(l.fired_at, "fired on the fake peak");
    assert.equal(l.fire_pnl_pct, 24);
    replay(P, [
      [1.48, -105, 2.469],  // capital tick (seconds later): the fire is voided, the simulation reset
      [1.40, -105, 2.469],  // settle
      [12.0, -95, 2.469], [12.4, -94, 2.469], [12.6, -93, 2.469], // a REAL in-grace run on the new capital
      [6.0, -100, 2.469], [5.9, -101, 2.469],                      // and a real give-back: fires again
    ]);
    const pos = S.getTrackedPosition(P);
    l = pos.grace_lock_shadow;
    assert.ok(l.voided_fire, "voided_fire kept");
    assert.equal(l.voided_fire.reason, "capital_rebase");
    assert.equal(l.voided_fire.fire_pnl_pct, 24);
    assert.ok(l.voided_fire.fire_peak_pct > 30);
    assert.ok(l.voided_fire.fired_at && l.voided_fire.voided_at);
    assert.equal(l.voided_fire.from_sol, 2.0);
    assert.equal(l.voided_fire.to_sol, 2.469);
    assert.equal(l.capital_resets, 1);
    assert.ok(l.fired_at, "the continued simulation fired on the real run");
    assert.equal(l.fire_pnl_pct, 5.9);
    assert.ok(l.fire_peak_pct >= 12 && l.fire_peak_pct < 13, `real peak ${l.fire_peak_pct}`);
    // grace_shadow fired its no-grace trailing on the fake peak too (before the change) → voided
    const g = pos.grace_shadow;
    assert.ok(g.voided_fire, "grace_shadow fire voided");
    assert.equal(g.voided_fire.reason, "capital_rebase");
    assert.equal(g.voided_fire.rule, "trailing_tp");
    assert.equal(g.capital_resets, 1);
  } finally { done(P); }
});

test("pure: an older fire stands; an ended record is not reset; mode off changes nothing", () => {
  const now = Date.now();
  const fired = (agoMin) => ({ grace_lock_shadow: { kind: "adoption", started_at: "x", fired_at: new Date(now - agoMin * 60_000).toISOString(), fire_pnl_pct: 3, fire_peak_pct: 20, fire_threshold_pct: 15, readings: 9, peak_pct: 20 } });
  const old = fired(11);
  assert.deepEqual(L.resetGraceLockShadowForCapital(old, { nowMs: now, mgmt: MG }), { changed: false, voided: false, line: null });
  assert.equal(old.grace_lock_shadow.fire_pnl_pct, 3);
  const recent = fired(9);
  const r = L.resetGraceLockShadowForCapital(recent, { nowMs: now, mgmt: MG, fromSol: 1.4998, toSol: 2, pair: "Pompom-SOL" });
  assert.equal(r.voided, true);
  assert.equal(r.line, "[GRACE_LOCK_SHADOW] Pompom-SOL: fire voided — capital changed ◎1.4998 → ◎2.0000 within 10 min of it (peak was on the old capital)");
  assert.equal(recent.grace_lock_shadow.fired_at, null);
  assert.equal(recent.grace_lock_shadow.peak_pct, null);
  assert.equal(recent.grace_lock_shadow.capital_resets, 1);
  const ended = { grace_lock_shadow: { kind: "adoption", ended_by: "timer", peak_pct: 14, readings: 3 } };
  assert.equal(L.resetGraceLockShadowForCapital(ended, { nowMs: now, mgmt: MG }).changed, false);
  assert.equal(ended.grace_lock_shadow.peak_pct, 14);
  const off = fired(1);
  assert.equal(L.resetGraceLockShadowForCapital(off, { nowMs: now, mgmt: OFF }).changed, false);
  assert.ok(off.grace_lock_shadow.fired_at);

  const gs = { grace_shadow: { kind: "straddle", started_at: "x", peak_pct: 30, sim_peak_pct: 29, no_grace_rule: "trailing_tp", no_grace_fire_pct: 2, no_grace_fire_at: new Date(now - 60_000).toISOString(), no_grace_peak_pct: 29, no_grace_threshold_pct: 27.5, readings: 12 } };
  const gr = G.resetGraceShadowForCapital(gs, { nowMs: now, mgmt: MG, fromSol: 2, toSol: 2.469, pair: "Pompom-SOL" });
  assert.equal(gr.voided, true);
  assert.match(gr.line, /^\[GRACE_SHADOW\] Pompom-SOL: no-grace fire voided — capital changed ◎2\.0000 → ◎2\.4690 within 10 min/);
  assert.deepEqual(gs.grace_shadow.voided_fire.fire_pnl_pct, 2);
  assert.equal(gs.grace_shadow.no_grace_rule, null);
  assert.equal(gs.grace_shadow.sim_peak_pct, null);
  assert.equal(gs.grace_shadow.readings, 12);
  const gsOff = { grace_shadow: { kind: "straddle", peak_pct: 30 } };
  assert.equal(G.resetGraceShadowForCapital(gsOff, { nowMs: now, mgmt: OFF }).changed, false);
});

test("shadows on vs off: identical live fields and exits through the same capital sequence", () => {
  const seq = [...FAKE(2.0), [25.0, -105, 2.0], [24.0, -105, 2.0], [1.48, -105, 2.469], [1.40, -105, 2.469], [3.2, -99, 2.469], [3.4, -98, 2.469], [1.0, -103, 2.469]];
  const A = mk(2.0), B = mk(2.0);
  try {
    const ea = replay(A, seq, MG), eb = replay(B, seq, OFF);
    assert.deepEqual(ea, eb, "same exits");
    const LIVE = ["amount_sol", "peak_pnl_pct", "pending_peak_pnl_pct", "trailing_active", "pending_exit_action", "pending_exit_count", "capital_rebase_pending", "hold_peak_pnl_pct", "mfe_pnl_pct", "mae_pnl_pct", "profit_grace_active", "stop_loss_violated_since"];
    const a = S.getTrackedPosition(A), b = S.getTrackedPosition(B);
    for (const k of LIVE) assert.deepEqual(a[k] ?? null, b[k] ?? null, k);
    assert.equal(b.grace_lock_shadow ?? null, null, "mode off: no lock record");
    assert.equal(b.grace_shadow ?? null, null, "disabled: no grace_shadow record");
    assert.ok(a.grace_lock_shadow && a.grace_shadow);
  } finally { done(A); done(B); }
});
