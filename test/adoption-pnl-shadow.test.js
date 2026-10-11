process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Adopted positions: lifetime vs managed-span PnL (shadow, log only) ===");

const S = await import("../state.js");
const { evaluateAdoptionPnlShadow, noteAdoptionPnlShadow, adoptionPnlShadowLine, buildAdoptionBasis, adoptionPrePnlSol, trackPosition, getTrackedPosition, ensureStateInitialized, recordClose, updatePnlAndCheckExits, ADOPTION_PNL_SHADOW_LOG_INTERVAL_MS } = S;
const { config } = await import("../config.js");
await ensureStateInitialized();

const cfg = { stopLossPct: -15, youngStopEnabled: true, youngStopPct: -10, youngStopMaxAgeHours: 12, trailingTakeProfit: true, trailingTriggerPct: 2, trailingDropPct: 1.5, solMode: true, adoptionPnlShadowMode: "shadow", holdThinPoolLimitMode: "enforce" };

// An OLD account adopted late: 2 SOL deposited, 0.3 fees claimed, nothing withdrawn; its
// inventory was worth 1.2 SOL when the bot took it over ⇒ it carried 1.2 + 0.3 − 2 = −0.5 SOL.
const BASIS = buildAdoptionBasis({ lifetime_deposits_sol: 2, lifetime_withdrawals_sol: 0, lifetime_fees_sol: 0.3 }, "2026-10-11T00:00:00.000Z", 1.2);
const POS = { adopted: true, amount_sol: 1.2, adoption_basis: BASIS, peak_pnl_pct: 0 };
assert.equal(adoptionPrePnlSol(POS), -0.5);

// Lifetime −20 % (−0.4 SOL on Meteora's 2 SOL of deposits): the stop loss fires on it, but the
// managed span is −0.4 − (−0.5) = +0.1 SOL = +8.33 % on the 1.2 SOL taken over.
{
  const v = evaluateAdoptionPnlShadow(POS, { pnl_pct: -20, pnl_sol: -0.4 }, cfg);
  assert.deepEqual([v.pre_pnl_sol, v.lifetime_sol, v.managed_sol, v.lifetime_pct, v.managed_pct, v.offset_pp], [-0.5, -0.4, 0.1, -20, 8.33, -28.33]);
  assert.deepEqual(v.rules.stop_loss, { lifetime: true, managed: false, diverges: true });
  assert.equal(v.diverges, true);
  assert.equal(v.diverging_rules[0], "stop_loss");
  // trailing: the stored peak (lifetime 0 %) is +28.33 % on the managed figure — armed there,
  // and 20 pp below it now, so it would have fired; never armed on the lifetime figure
  assert.deepEqual(v.rules.trailing_arm, { lifetime: false, managed: true, diverges: true });
  assert.deepEqual(v.rules.trailing_fire, { lifetime: false, managed: true, diverges: true });
  assert.equal("hold_limit" in v.rules, false, "not held");
  const line = adoptionPnlShadowLine("OLD-SOL", v);
  assert.match(line, /^\[ADOPTION_PNL_SHADOW\] OLD-SOL: lifetime -20\.00% vs managed \+8\.33% \(offset -28\.33 pp\) — stop_loss: DIVERGES \(lifetime fires, managed does not\); trailing_arm: DIVERGES/);
  // solMode: the scan row carries SOL pnl in pnl_usd
  assert.equal(evaluateAdoptionPnlShadow(POS, { pnl_pct: -20, pnl_usd: -0.4 }, cfg).managed_pct, 8.33);
  assert.equal(evaluateAdoptionPnlShadow(POS, { pnl_pct: -20, pnl_usd: -0.4 }, { ...cfg, solMode: false }), null, "no SOL pnl on the row");
  console.log("ok — basis D 2 / F 0.3, capital 1.2: lifetime −20 % fires the stop, managed +8.33 % does not");
}

// Same decision on both figures → reported as "same".
{
  const v = evaluateAdoptionPnlShadow(POS, { pnl_pct: -5, pnl_sol: -0.1 }, { ...cfg, trailingTakeProfit: false });
  assert.equal(v.managed_pct, 33.33);
  assert.equal(v.diverges, false);
  assert.match(adoptionPnlShadowLine("OLD-SOL", v), /— stop_loss, young_stop: same — log only/);
}

// Young stop, trailing fire and the thin-pool hold limit.
{
  const young = evaluateAdoptionPnlShadow({ ...POS, token_age_hours_at_deploy: 3 }, { pnl_pct: -12, pnl_sol: -0.24 }, cfg);
  assert.deepEqual(young.rules.young_stop, { lifetime: true, managed: false, diverges: true });
  assert.equal(young.rules.stop_loss.diverges, false);
  // pre-adoption GAIN: basis W 1.5 + F 0.2 − D 1 = +0.7, inventory 0.5 ⇒ pre +1.2 SOL
  const gain = { adopted: true, amount_sol: 0.5, peak_pnl_pct: 130, adoption_basis: buildAdoptionBasis({ lifetime_deposits_sol: 1, lifetime_withdrawals_sol: 1.5, lifetime_fees_sol: 0.2 }, undefined, 0.5) };
  // lifetime +120 % (1.2 SOL) = managed 0 %: the lifetime figure arms and fires trailing (130 → 120)
  const tr = evaluateAdoptionPnlShadow(gain, { pnl_pct: 120, pnl_sol: 1.2 }, cfg);
  assert.equal(tr.managed_pct, 0);
  assert.deepEqual(tr.rules.trailing_fire, { lifetime: true, managed: true, diverges: false }); // both peaks armed (130 / 10), same 10 pp drop
  const tr2 = evaluateAdoptionPnlShadow({ ...gain, peak_pnl_pct: 121 }, { pnl_pct: 119, pnl_sol: 1.19 }, cfg);
  assert.deepEqual(tr2.rules.trailing_arm, { lifetime: true, managed: false, diverges: true });   // managed peak +1 % < trigger 2 %
  assert.deepEqual(tr2.rules.trailing_fire, { lifetime: true, managed: false, diverges: true });
  // held thin-pool position: the −25 % limit on the lifetime figure, not on the managed one
  const held = { ...POS, hold_mode: true, entry_tvl: 40_000 };
  const hl = evaluateAdoptionPnlShadow(held, { pnl_pct: -30, pnl_sol: -0.6 }, cfg);
  assert.deepEqual(hl.rules.hold_limit, { lifetime: true, managed: false, diverges: true });
  assert.equal("hold_limit" in evaluateAdoptionPnlShadow({ ...held, entry_tvl: 400_000 }, { pnl_pct: -30, pnl_sol: -0.6 }, cfg).rules, false);
  assert.equal("hold_limit" in evaluateAdoptionPnlShadow({ ...held, hold_thin_limit_exempt: true }, { pnl_pct: -30, pnl_sol: -0.6 }, cfg).rules, false);
  console.log("ok — young stop, trailing arm / fire, thin-pool hold limit");
}

// null: no basis, sub-threshold offset, mode off, unusable valuation.
{
  const row = { pnl_pct: -20, pnl_sol: -0.4 };
  assert.equal(evaluateAdoptionPnlShadow({ adopted: true, amount_sol: 1.2 }, row, cfg), null, "no basis");
  assert.equal(evaluateAdoptionPnlShadow({ adopted: true, amount_sol: 1.2, adoption_basis: null }, row, cfg), null);
  assert.equal(evaluateAdoptionPnlShadow({ amount_sol: 0.4 }, row, cfg), null, "bot deploy");
  // fresh deposit: 1 SOL deposited, valued 0.9905 at adoption ⇒ pre −0.0095 ≤ max(0.01, 1 % × 0.9905)
  const fresh = { adopted: true, amount_sol: 0.9905, adoption_basis: buildAdoptionBasis({ lifetime_deposits_sol: 1 }, undefined, 0.9905) };
  assert.equal(adoptionPrePnlSol(fresh), -0.0095);
  assert.equal(evaluateAdoptionPnlShadow(fresh, row, cfg), null, "sub-threshold offset");
  // 1 % of the capital on a large position: pre −0.04 on 5 SOL (threshold 0.05) → null; −0.06 → reported
  const big = (c) => ({ adopted: true, amount_sol: 5, adoption_basis: buildAdoptionBasis({ lifetime_deposits_sol: 5 + c }, undefined, 5) });
  assert.equal(evaluateAdoptionPnlShadow(big(0.04), row, cfg), null);
  assert.equal(evaluateAdoptionPnlShadow(big(0.06), row, cfg).pre_pnl_sol, -0.06);
  assert.equal(evaluateAdoptionPnlShadow(POS, row, { ...cfg, adoptionPnlShadowMode: "off" }), null, "mode off");
  assert.equal(evaluateAdoptionPnlShadow(POS, { pnl_pct: null, pnl_sol: -0.4 }, cfg), null);
  assert.equal(evaluateAdoptionPnlShadow(POS, { pnl_pct: -20 }, { ...cfg, solMode: false }), null);
  assert.equal(evaluateAdoptionPnlShadow(POS, null, cfg), null);
  console.log("ok — null without a basis, under the threshold, when off, without a usable valuation");
}

// Stored on the position; logged at most once per 10 minutes and always on the first divergence.
{
  const addr = "TEST_ADOPT_PNL_SHADOW_" + Date.now();
  trackPosition({ position: addr, pool: "POOL_APS", pool_name: "APS-SOL", amount_sol: 1.2, strategy: "manual", adopted: true, adoption_basis: BASIS });
  const pos = () => getTrackedPosition(addr);
  const same = evaluateAdoptionPnlShadow(pos(), { pnl_pct: -5, pnl_sol: -0.1 }, { ...cfg, trailingTakeProfit: false });
  const div = evaluateAdoptionPnlShadow(pos(), { pnl_pct: -20, pnl_sol: -0.4 }, cfg);
  const t0 = Date.parse("2026-10-11T10:00:00Z");
  assert.deepEqual(noteAdoptionPnlShadow(addr, null, t0), { log: false, first_divergence: false });
  assert.deepEqual(noteAdoptionPnlShadow(addr, same, t0), { log: true, first_divergence: false });          // first sighting
  assert.deepEqual([pos().adoption_pnl_shadow.offset_pp, pos().adoption_pnl_shadow.first_divergence_at, pos().adoption_pnl_shadow.rule], [same.offset_pp, null, null]);
  assert.equal(noteAdoptionPnlShadow(addr, same, t0 + 3 * 60_000).log, false);                              // within 10 min
  assert.deepEqual(noteAdoptionPnlShadow(addr, div, t0 + 4 * 60_000), { log: true, first_divergence: true }); // first divergence: always
  const s = pos().adoption_pnl_shadow;
  assert.deepEqual([s.first_divergence_at, s.rule, s.lifetime_pct, s.managed_pct, s.offset_pp], ["2026-10-11T10:04:00.000Z", "stop_loss", -20, 8.33, -28.33]);
  assert.equal(noteAdoptionPnlShadow(addr, div, t0 + 5 * 60_000).log, false);                               // not a second "first"
  assert.equal(noteAdoptionPnlShadow(addr, div, t0 + 4 * 60_000 + ADOPTION_PNL_SHADOW_LOG_INTERVAL_MS).log, true);
  assert.equal(pos().adoption_pnl_shadow.first_divergence_at, "2026-10-11T10:04:00.000Z", "the first divergence is kept");
  assert.equal(pos().adoption_pnl_shadow.rule, "stop_loss");

  // Shadow only: the evaluator still decides on the lifetime figure it is given.
  const exit = updatePnlAndCheckExits(addr, { pnl_pct: -20, in_range: true, active_bin: 0, lower_bin: -30, upper_bin: 30 }, { ...cfg, adoptedProfitGraceMinutes: 0 });
  assert.equal(exit?.action, "STOP_LOSS", "behaviour unchanged: the stop fires on the lifetime −20 %");
  recordClose(addr, "test cleanup");
  assert.equal(noteAdoptionPnlShadow(addr, div, t0 + 60 * 60_000).log, false, "closed positions are not written");
  console.log("ok — record on the position, 10-minute log pace, first divergence always logged, nothing closed differently");
}

// Wiring.
{
  assert.equal(config.management.adoptionPnlShadowMode, "shadow");
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /if \(p\.pnl_management_ready !== false && p\.pnl_pct_suspicious !== true\) \{\s+const av = evaluateAdoptionPnlShadow\(getTrackedPosition\(p\.position\), p, config\.management\);\s+if \(av && noteAdoptionPnlShadow\(p\.position, av\)\.log\) log\("adoption_pnl_shadow", adoptionPnlShadowLine\(p\.pair, av\)\);/);
  // before the exit / hold branches, so held and exiting positions are covered too
  assert.ok(idx.indexOf("const av = evaluateAdoptionPnlShadow(") < idx.indexOf("actionMap.set(p.position, await buildExitAction(p, exitMap.get(p.position)));"));
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  assert.equal((dlmm.match(/adoption_pnl_shadow: (tracked|snapshot)\.adoption_pnl_shadow \?\? null,/g) || []).length, 3, "all three record sites");
  const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exec, /adoptionPnlShadowMode: \["management", "adoptionPnlShadowMode"\]/);
  const cfgSrc = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(cfgSrc, /adoptionPnlShadowMode: \["off", "shadow"\]\.includes\(u\.adoptionPnlShadowMode\) \? u\.adoptionPnlShadowMode : "shadow",/);
  console.log("ok — wired into the management cycle, the three record sites and update_config");
}

console.log("✅ adoption pnl shadow verified");
process.exit(0);
