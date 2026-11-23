process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";

// 2026-11-24: the adoption warning (Alert A) says plainly when the operator's pool is ALREADY
// under the TVL exit's minimum — three operator positions opened at $4,681 / $6,311 / $9,973
// entry TVL were each closed 7–18 min later and the warning said nothing about it. Every rule
// is described by its actual mode; the warning goes out whatever holdThinPoolLimitMode is.
const H = await import("../hold-thin-limit.js");
const I = await import("../index.js");
const { sanitizeTelegramHTML } = await import("../telegram.js");

const text = (tvl, mgmt = {}, owner = { adopted: true }) => I.thinPoolAdoptionAlertText({ pair: "SNOW-SOL", amountSol: 1, entryTvlUsd: tvl, mgmt, owner });

test("under the floor, TVL exit enforce: the plain warning (HOLD does not prevent it, the only switch)", () => {
  for (const hold of ["enforce", "shadow", "off"]) {
    const t = text(4681, { tvlFloorExitMode: "enforce", holdThinPoolLimitMode: hold });
    assert.match(t, /^🚨 <b>Pool already under the TVL-exit minimum — adopted position<\/b>\n🧑 SNOW-SOL \(◎1\.000\): pool TVL at entry \$4,681 — under the bot's own \$100,000 entry bar\.\n/);
    assert.match(t, /It is already under the \$10,000 TVL-exit minimum: the bot will close this position after about 3 readings over at least 5 min \(one per management cycle, checked against the on-chain reserves\) unless pool TVL rises back above \$10,000\. HOLD does not prevent this, and there is no per-position exemption — the only switch is the tvlFloorExitMode config key\./);
    assert.equal(sanitizeTelegramHTML(t), t, "HTML-safe");
  }
  // configured readings / minutes / floor flow into the text
  assert.match(text(14_000, { tvlFloorExitUsd: 15000, tvlFloorExitMinReadings: 4, tvlFloorExitMinMinutes: 9 }), /under the \$15,000 TVL-exit minimum: the bot will close this position after about 4 readings over at least 9 min/);
  // absent key = enforce (rule-mode.js)
  assert.match(text(9973, {}), /already under the \$10,000 TVL-exit minimum: the bot will close/);
});

test("under the floor, TVL exit shadow: only logged; off: the TVL exit is not mentioned", () => {
  const s = text(6311, { tvlFloorExitMode: "shadow", holdThinPoolLimitMode: "off" });
  assert.match(s, /^⚠️ <b>Thin pool — adopted position<\/b>/);
  assert.match(s, /It is already under the \$10,000 TVL-exit minimum, but tvlFloorExitMode=shadow: the TVL exit only logs a would-close and will not close it\./);
  assert.doesNotMatch(s, /will close this position/);
  const o = text(6311, { tvlFloorExitMode: "off", holdThinPoolLimitMode: "off" });
  assert.doesNotMatch(o, /TVL exit|TVL-exit|tvlFloorExitMode/);
  assert.match(o, /<i>Switches: holdThinPoolLimitMode, adoptThinPoolWarnEnabled\.<\/i>$/);
});

test("the thin-pool hold limit is described by its mode, never as closing when off / shadow", () => {
  const off = text(42_000, { holdThinPoolLimitMode: "off" });
  assert.match(off, /If you put it on hold: the thin-pool limit \(-25%\) is NOT closing anything \(holdThinPoolLimitMode=off\)\./);
  assert.doesNotMatch(off, /closes it at -25%/);
  const sh = text(42_000, { holdThinPoolLimitMode: "shadow" });
  assert.match(sh, /\(holdThinPoolLimitMode=shadow — it only logs a would-close\)/);
  const en = text(42_000, { holdThinPoolLimitMode: "enforce" });
  assert.match(en, /the thin-pool limit closes it at -25% PnL \(you can exempt it from the dashboard card\)/);
  // above the floor, TVL exit enforce: the held-or-not sentence, no "already under"
  assert.match(en, /Held or not, the TVL exit closes it if pool TVL falls under \$10,000 \(HOLD does not prevent it\)\./);
  assert.doesNotMatch(en, /already under/);
  assert.match(text(42_000, { tvlFloorExitMode: "shadow" }), /If pool TVL falls under \$10,000 the TVL exit only logs a would-close \(tvlFloorExitMode=shadow\)\./);
});

test("who gets it: once per operator position, under the floor regardless of the hold-limit mode", () => {
  const op = (tvl, extra = {}) => ({ adopted: true, entry_tvl: tvl, strategy_source: "manual_adoption", ...extra });
  for (const hold of ["enforce", "shadow", "off"]) {
    assert.equal(H.shouldWarnThinPoolAdoption(op(4681), { holdThinPoolLimitMode: hold }), true, hold);
    assert.equal(H.shouldWarnThinPoolAdoption(op(42_000), { holdThinPoolLimitMode: hold }), true, `thin, ${hold}`);
  }
  // a hold-limit bar configured below the TVL-exit floor: still warned while the TVL exit is on
  assert.equal(H.shouldWarnThinPoolAdoption(op(8000), { holdThinPoolTvlUsd: 5000 }), true);
  assert.equal(H.shouldWarnThinPoolAdoption(op(8000), { holdThinPoolTvlUsd: 5000, tvlFloorExitMode: "off" }), false);
  assert.deepEqual(H.thinPoolAdoptionWarning(op(8000), { holdThinPoolTvlUsd: 5000 }), { thin: false, under_tvl_exit_floor: true, tvl_exit_mode: "enforce", entry_tvl_usd: 8000 });
  // unchanged: bot deploys, recovered bot deploys, already warned, switched off, unknown TVL
  assert.equal(H.shouldWarnThinPoolAdoption({ adopted: false, entry_tvl: 4681 }, {}), false);
  assert.equal(H.shouldWarnThinPoolAdoption(op(4681, { strategy_source: "bot_recovery" }), {}), false);
  assert.equal(H.shouldWarnThinPoolAdoption(op(4681, { thin_pool_adopt_warned_at: "x" }), {}), false);
  assert.equal(H.shouldWarnThinPoolAdoption(op(4681), { adoptThinPoolWarnEnabled: false }), false);
  assert.equal(H.shouldWarnThinPoolAdoption(op(null), {}), false);
  assert.equal(H.shouldWarnThinPoolAdoption(op(336_184), {}), false);
});
