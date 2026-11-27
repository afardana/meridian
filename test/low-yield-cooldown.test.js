// Pool cooldown after a low-yield close (pool-memory.js recordPoolDeploy, 2026-11-27).
// Before this date the cooldown compared close_reason with the exact string "low yield", which
// no real reason ever equals, so it never fired. It now follows the exit family.
import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../config.js";
import {
  recordPoolDeploy,
  getPoolMemory,
  isPoolOnCooldown,
  setPoolMemoryForTesting,
} from "../pool-memory.js";
import { applyRankSafetyGates } from "../tools/screening.js";
import { isValidLowYieldCooldownHours, lowYieldCooldownHours } from "../low-yield-guard.js";

const SOL = "So11111111111111111111111111111111111111112";
const H = 3600_000;

function close(pool, reason, extra = {}) {
  recordPoolDeploy(pool, {
    pool_name: `${pool}-SOL`,
    base_mint: `${pool}_MINT`,
    deployed_at: new Date(Date.now() - 3 * H).toISOString(),
    closed_at: new Date().toISOString(),
    pnl_pct: -0.4,
    close_reason: reason,
    strategy: "spot",
    ...extra,
  });
}

function cooldownHoursLeft(pool) {
  const mem = getPoolMemory({ pool_address: pool });
  if (!mem.cooldown_until) return null;
  return (new Date(mem.cooldown_until).getTime() - Date.now()) / H;
}

function withHours(hours, fn) {
  const prev = config.management.lowYieldCooldownHours;
  config.management.lowYieldCooldownHours = hours;
  try { fn(); } finally { config.management.lowYieldCooldownHours = prev; }
}

function cleanup(...pools) {
  setPoolMemoryForTesting((db) => { for (const p of pools) delete db[p]; });
}

test("default is 4 h; validation finite 0–72", () => {
  assert.equal(config.management.lowYieldCooldownHours, 4);
  assert.equal(lowYieldCooldownHours(undefined), 4);
  assert.equal(lowYieldCooldownHours(0), 0);
  assert.equal(lowYieldCooldownHours("8"), 8);
  assert.equal(lowYieldCooldownHours(-1), 4);
  assert.equal(lowYieldCooldownHours(73), 4);
  assert.equal(lowYieldCooldownHours(NaN), 4);
  for (const ok of [0, 4, 72, "12"]) assert.equal(isValidLowYieldCooldownHours(ok), true, String(ok));
  for (const bad of [-0.1, 72.5, "", " ", null, undefined, true, [], {}, Infinity, "x"]) {
    assert.equal(isValidLowYieldCooldownHours(bad), false, String(bad));
  }
});

test("old-format low-yield reason sets a ~4 h cooldown", () => {
  const pool = "LYC_OLD";
  close(pool, "Low yield: fee/TVL 0.31% < min 1% (age: 131m)");
  const left = cooldownHoursLeft(pool);
  assert.ok(left > 3.99 && left <= 4, `hours left ${left}`);
  assert.equal(getPoolMemory({ pool_address: pool }).cooldown_reason, "low yield");
  assert.equal(isPoolOnCooldown(pool), true);
  cleanup(pool);
});

test("new-format reason with the ' — verified: …' suffix sets the cooldown", () => {
  const pool = "LYC_NEW";
  close(pool, "Low yield: fee/TVL 0.31% < min 1% (age: 131m) — verified: own fees 0.00%/24h over 45m, 3 Meteora fetches over 10m");
  const left = cooldownHoursLeft(pool);
  assert.ok(left > 3.99 && left <= 4, `hours left ${left}`);
  assert.equal(isPoolOnCooldown(pool), true);
  cleanup(pool);
});

test("a passed exit_family is used first", () => {
  const pool = "LYC_FAMILY";
  close(pool, "something unrecognisable", { exit_family: "low_yield" });
  assert.equal(isPoolOnCooldown(pool), true);
  const pool2 = "LYC_FAMILY2";
  close(pool2, "Low yield: fee/TVL 0.31% < min 1% (age: 131m)", { exit_family: "trailing_tp" });
  assert.equal(isPoolOnCooldown(pool2), false);
  cleanup(pool, pool2);
});

test("lowYieldCooldownHours=0 sets no cooldown; a custom value is used", () => {
  const pool = "LYC_ZERO";
  withHours(0, () => close(pool, "Low yield: fee/TVL 0.31% < min 1% (age: 131m)"));
  assert.equal(getPoolMemory({ pool_address: pool }).cooldown_until, null);
  assert.equal(isPoolOnCooldown(pool), false);
  const pool8 = "LYC_EIGHT";
  withHours(8, () => close(pool8, "Low yield: fee/TVL 0.31% < min 1% (age: 131m)"));
  const left = cooldownHoursLeft(pool8);
  assert.ok(left > 7.99 && left <= 8, `hours left ${left}`);
  cleanup(pool, pool8);
});

test("trailing-TP, stop-loss and OOR reasons set no cooldown", () => {
  const reasons = [
    "Trailing TP: peak 3.10% → 1.55% (drop 1.55pp ≥ 1.5)",
    "Stop loss: PnL -15.20% <= -15%",
    "OOR (below): 61m below range",
    "Out of range above for 720m",
  ];
  reasons.forEach((r, i) => {
    const pool = `LYC_OTHER_${i}`;
    close(pool, r);
    assert.equal(isPoolOnCooldown(pool), false, r);
    cleanup(pool);
  });
});

test("an existing longer cooldown is not shortened", () => {
  const pool = "LYC_LONGER";
  const longer = new Date(Date.now() + 12 * H).toISOString();
  setPoolMemoryForTesting((db) => {
    db[pool] = {
      name: `${pool}-SOL`, base_mint: `${pool}_MINT`, deploys: [], total_deploys: 0,
      avg_pnl_pct: 0, win_rate: 0, adjusted_win_rate: 0, adjusted_win_rate_sample_count: 0,
      last_deployed_at: null, last_outcome: null, notes: [],
      cooldown_until: longer, cooldown_reason: "repeated OOR closes (3x)",
    };
  });
  close(pool, "Low yield: fee/TVL 0.31% < min 1% (age: 131m)");
  const mem = getPoolMemory({ pool_address: pool });
  assert.equal(mem.cooldown_until, longer);
  assert.equal(mem.cooldown_reason, "repeated OOR closes (3x)");
  cleanup(pool);
});

test("an existing shorter cooldown is extended", () => {
  const pool = "LYC_SHORTER";
  const shorter = new Date(Date.now() + 1 * H).toISOString();
  setPoolMemoryForTesting((db) => {
    db[pool] = {
      name: `${pool}-SOL`, base_mint: `${pool}_MINT`, deploys: [], total_deploys: 0,
      avg_pnl_pct: 0, win_rate: 0, adjusted_win_rate: 0, adjusted_win_rate_sample_count: 0,
      last_deployed_at: null, last_outcome: null, notes: [],
      cooldown_until: shorter, cooldown_reason: "something",
    };
  });
  close(pool, "Low yield: fee/TVL 0.31% < min 1% (age: 131m)");
  const left = cooldownHoursLeft(pool);
  assert.ok(left > 3.99 && left <= 4, `hours left ${left}`);
  assert.equal(getPoolMemory({ pool_address: pool }).cooldown_reason, "low yield");
  cleanup(pool);
});

test("admission (applyRankSafetyGates) rejects the pool while the cooldown is active", () => {
  const pool = "LYC_ADMIT";
  const other = "LYC_ADMIT_OTHER";
  close(pool, "Low yield: fee/TVL 0.31% < min 1% (age: 131m) — verified: own fees 0.00%/24h over 45m, 2 Meteora fetches over 10m");
  const cand = (addr) => ({ pool: addr, name: `${addr}-SOL`, base: { mint: `${addr}_MINT`, symbol: addr }, quote: { mint: SOL, symbol: "SOL" }, volatility: 2, tvl: 150000 });
  const filteredOut = [];
  const safe = applyRankSafetyGates([cand(pool), cand(other)], {
    occupiedPools: new Set(), occupiedMints: new Set(), filteredOut,
  });
  assert.deepEqual(safe.map((p) => p.pool), [other]);
  assert.ok(filteredOut.some((f) => f.reason === "pool cooldown active" && f.name === `${pool}-SOL`), JSON.stringify(filteredOut));
  cleanup(pool, other);
});
