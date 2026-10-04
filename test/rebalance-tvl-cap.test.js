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

console.log("✅ rebalance TVL cap verified");
process.exit(0);
