import test from "node:test";
import assert from "node:assert/strict";
import {
  recordPoolDeploy,
  getPoolMemory,
  clearAntiLvrCooldowns,
  isPoolOnCooldown,
  isBaseMintOnCooldown,
  setPoolMemoryForTesting,
} from "../pool-memory.js";

test("Anti-LVR Removal: recordPoolDeploy on OOR-above close sets NO cooldown", async () => {
  const poolAddress = "TEST_OOR_ABOVE_POOL_1";
  const baseMint = "TEST_BASE_MINT_1";

  recordPoolDeploy(poolAddress, {
    pool_name: "Test-SOL",
    base_mint: baseMint,
    deployed_at: new Date(Date.now() - 3600000).toISOString(),
    closed_at: new Date().toISOString(),
    pnl_pct: 5.5,
    close_reason: "Round-trip complete: 5 bins above range, pnl frozen at 5.5% — position is all-SOL",
    strategy: "spot",
  });

  const mem = getPoolMemory({ pool_address: poolAddress });
  assert.equal(mem.cooldown_until, null, "Pool should NOT have cooldown set on OOR-above close");
  assert.equal(mem.cooldown_reason, null, "Pool should NOT have cooldown reason set on OOR-above close");
  assert.equal(isPoolOnCooldown(poolAddress), false, "isPoolOnCooldown must return false");
  assert.equal(isBaseMintOnCooldown(baseMint), false, "isBaseMintOnCooldown must return false");

  // Cleanup
  setPoolMemoryForTesting((db) => {
    delete db[poolAddress];
  });
});

test("Anti-LVR Removal: clearAntiLvrCooldowns wipes existing stale anti-LVR cooldowns", async () => {
  const poolAddress = "TEST_STALE_ANTILVR_POOL";
  const baseMint = "TEST_STALE_MINT";

  // Simulate an entry with a stale Anti-LVR cooldown
  setPoolMemoryForTesting((db) => {
    db[poolAddress] = {
      name: "Stale-SOL",
      base_mint: baseMint,
      deploys: [],
      total_deploys: 1,
      cooldown_until: new Date(Date.now() + 3600000).toISOString(),
      cooldown_reason: "OOR above — anti-LVR cooldown",
      base_mint_cooldown_until: new Date(Date.now() + 3600000).toISOString(),
      base_mint_cooldown_reason: "OOR above — anti-LVR cooldown",
    };
  });

  assert.equal(isPoolOnCooldown(poolAddress), true, "Setup check: pool was on cooldown");
  assert.equal(isBaseMintOnCooldown(baseMint), true, "Setup check: base mint was on cooldown");

  // Execute clear
  const cleared = clearAntiLvrCooldowns();
  assert.ok(cleared >= 2, `Expected at least 2 cleared cooldown entries, got ${cleared}`);

  assert.equal(isPoolOnCooldown(poolAddress), false, "isPoolOnCooldown must be false after clearAntiLvrCooldowns");
  assert.equal(isBaseMintOnCooldown(baseMint), false, "isBaseMintOnCooldown must be false after clearAntiLvrCooldowns");

  // Cleanup
  setPoolMemoryForTesting((db) => {
    delete db[poolAddress];
  });
});
