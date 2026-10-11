process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== TVL upper limit: an entry rule, not a re-range rule ===");

const { tvlAboveCap } = await import("../tools/executor.js");

// New deploy: the cap applies.
assert.equal(tvlAboveCap(970289, 800000), true);
assert.equal(tvlAboveCap(799999, 800000), false);
assert.equal(tvlAboveCap(5e6, null), false);      // no cap configured
assert.equal(tvlAboveCap(5e6, 0), false);
// Straddle / re-range of an existing position: never blocked by the cap (Agency-SOL, $970k).
assert.equal(tvlAboveCap(970289, 800000, { existingPosition: true }), false);

const src = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
// Only the rebalance safety check passes existing_position; the deploy check does not.
assert.match(src, /validateDeployPoolThresholds\(\{ pool_address: tracked\.pool, pool_name: tracked\.pool_name, existing_position: true \}\)/);
assert.match(src, /const poolThresholds = await validateDeployPoolThresholds\(\{ \.\.\.args, existing_position: false \}\);/);
assert.equal((src.match(/existing_position: true/g) || []).length, 1);

// ── minTvl is an entry rule too (operator, 2026-10-11; PQC-SOL $87,137.5 < $100k) ──
const { tvlFloorDecision } = await import("../tools/executor.js");
const { RUG_FLOOR_TVL } = await import("../tools/screening.js");
assert.equal(RUG_FLOOR_TVL, 10000);

// Existing position under minTvl: passes, flagged as the exemption, never a scout —
// with the scout tier off (prod) and on.
for (const scoutTierEnabled of [false, true]) {
  const held = tvlFloorDecision(87137.5, 100000, { existingPosition: true, scoutTierEnabled });
  assert.deepEqual(held, { pass: true, scout: false, exempt: true });
}
// Existing position at/above minTvl: plain pass, no exemption logged.
assert.deepEqual(tvlFloorDecision(150000, 100000, { existingPosition: true }), { pass: true, scout: false, exempt: false });
// Existing position under the rug floor: still refused, whatever minTvl says.
for (const minTvl of [100000, null, 0]) {
  const rug = tvlFloorDecision(9999, minTvl, { existingPosition: true, scoutTierEnabled: true });
  assert.equal(rug.pass, false);
  assert.equal(rug.scout, false);
  assert.match(rug.reason, /below the \$10000 rug floor/);
}
assert.equal(tvlFloorDecision(10000, 100000, { existingPosition: true }).pass, true);
assert.equal(tvlFloorDecision(NaN, 100000, { existingPosition: true }).pass, true); // unreadable TVL is refused earlier (tvl == null)

// New deploy at $87k: refused with the scout tier off, a scout with it on — unchanged.
const fresh = tvlFloorDecision(87137.5, 100000, { scoutTierEnabled: false });
assert.equal(fresh.pass, false);
assert.equal(fresh.reason, "Pool TVL $87137.5 is below configured minTvl $100000.");
assert.deepEqual(tvlFloorDecision(87137.5, 100000, { scoutTierEnabled: true }), { pass: true, scout: true, exempt: false });
assert.deepEqual(tvlFloorDecision(100000, 100000), { pass: true, scout: false, exempt: false });
assert.deepEqual(tvlFloorDecision(5000, null), { pass: true, scout: false, exempt: false }); // no floor configured: as before

// The validation uses the decision, with existing_position read strictly (=== true).
assert.match(src, /const existingPosition = args\?\.existing_position === true;/);
assert.match(src, /tvlFloorDecision\(tvl, minTvl, \{ existingPosition, scoutTierEnabled: !!config\.screening\.scoutTierEnabled \}\)/);
assert.match(src, /const scoutTier = tvlFloor\.scout;/);

// ── minTxPerMin is an entry rule too (2026-10-11; 10-10 21:25 WIB: tx/min 1.98 < 2 refused a straddle) ──
const { txFloorDecision } = await import("../tools/executor.js");
// Position already held at 1.98: passes, flagged as the exemption.
assert.deepEqual(txFloorDecision(1.98, 2, { existingPosition: true }), { pass: true, exempt: true });
assert.deepEqual(txFloorDecision(null, 2, { existingPosition: true }), { pass: true, exempt: true });
assert.deepEqual(txFloorDecision(2.4, 2, { existingPosition: true }), { pass: true, exempt: false });
// New deploy at 1.98: still refused, same wording as before; unknown reading refused too.
const freshTx = txFloorDecision(1.98, 2);
assert.equal(freshTx.pass, false);
assert.equal(freshTx.reason, "Pool tx/min 1.98 is below minTxPerMin 2.");
assert.equal(txFloorDecision(null, 2).reason, "Pool tx/min unknown is below minTxPerMin 2.");
assert.deepEqual(txFloorDecision(2, 2), { pass: true, exempt: false });
assert.deepEqual(txFloorDecision(0.1, 0), { pass: true, exempt: false }); // no floor configured: as before
// The validation uses the decision with the same strict existing_position flag.
assert.match(src, /txFloorDecision\(txPerMin, effectiveMinTx, \{ existingPosition \}\)/);
assert.match(src, /\[TX_FLOOR\] .* entry rule only/);
// Exactly three gates read the flag: TVL floor, TVL cap, tx/min.
assert.equal((src.match(/\{ existingPosition(,| \})/g) || []).length, 3);

console.log("✅ rebalance TVL cap verified");
process.exit(0);
