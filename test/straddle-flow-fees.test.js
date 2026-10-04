process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Straddle net-deposit basis: claimed fees are not principal ===");

const { unclaimedFeesSolOf, principalOutSol } = await import("../tools/dlmm.js");

// CRAWL-SOL 2026-10-04: stage A's simulated net out ◎0.2219 included ◎0.008327 of fees
// (0.004697 SOL + 225.14 base at ~1.612e-5). Meteora's net deposit settled at 0.2264 = 0.44 − principal.
const bn = (v) => ({ toString: () => String(v) });
const fees = unclaimedFeesSolOf({ feeY: bn(4696998), feeX: bn(225140303) }, 6, 0.00001612);
assert.ok(Math.abs(fees - 0.008326) < 1e-5);
const principal = principalOutSol(0.2219, fees);
assert.ok(Math.abs((0.44 - principal) - 0.2264) < 2e-4);   // matches Meteora's net deposit
assert.equal(principalOutSol(0.2219, 0), 0.2219);
assert.equal(principalOutSol(-0.36, 0.001), -0.361);        // a deposit leg: fees claimed still come off
assert.equal(principalOutSol(0.5, NaN), 0.5);
assert.equal(unclaimedFeesSolOf(null, 6, 0.00001), 0);
assert.equal(unclaimedFeesSolOf({ feeY: bn(1e9), feeX: bn(5e6) }, 6, 0), 1); // no base price → SOL leg only

// Both rebalance stages note the claimable fees before sending, and noteFlow uses the principal.
const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
assert.match(dlmm, /noteClaimableFees\(pd, solPerBaseA\);\s*await sendRebalance\(respA, "straddle:withdraw"\);/);
assert.match(dlmm, /noteClaimableFees\(pd, solPerBase\);\s*await sendRebalance\(respC, "straddle:deposit"\);/);
assert.match(dlmm, /const out = principalOutSol\(netOutSol\(resp, solPerBase\), claimedFeesSol\);/);

// The claimed fees are booked in the claim ledger in the same step (the indexer lags by minutes).
assert.match(dlmm, /if \(claimedFeesSol > 0\) \{[\s\S]{0,260}recordClaim\(position_address, \{ sol: claimedFeesSol,/);
{
  const { trackPosition, recordClaim, getTrackedPosition, ensureStateInitialized, recordClose } = await import("../state.js");
  await ensureStateInitialized();
  const addr = "TEST_STRADDLE_FEES_" + Date.now();
  trackPosition({ position: addr, pool: "POOL_SF", pool_name: "SF-SOL", amount_sol: 0.73, strategy: "spot" });
  recordClaim(addr, { sol: 0.0343, usd: 4.1 });
  assert.ok(Math.abs(Number(getTrackedPosition(addr).total_fees_claimed_sol) - 0.0343) < 1e-9);
  recordClose(addr, "test cleanup");
}

console.log("✅ straddle flow fees verified");
process.exit(0);
