process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "assert";

console.log("=== Testing Rebalance Execution Flow ===");

const { trackPosition, rebalancePositionState, getTrackedPosition, ensureStateInitialized } = await import("../state.js");
await ensureStateInitialized();

// 1. Test rebalancePositionState in state.js
{
  const oldAddr = "TEST_OLD_POS_" + Date.now();
  const newAddr = "TEST_NEW_POS_" + Date.now();

  trackPosition({
    position: oldAddr,
    pool: "TEST_POOL_ADDR",
    pool_name: "ZCAT-SOL",
    base_mint: "MINT_ZCAT",
    amount_sol: 1.0,
    amount_x: 0,
    strategy: "spot",
    total_fees_claimed_sol: 0.05,
    total_fees_claimed_true_usd: 7.5,
    initial_value_usd: 150,
  });

  const oldPosBefore = getTrackedPosition(oldAddr);
  assert.strictEqual(oldPosBefore.rebalance_count ?? 0, 0);

  const newPos = rebalancePositionState({
    old_position_address: oldAddr,
    new_position_address: newAddr,
    new_bin_range: { min: -100, max: -31, active: -65, bins_below: 35, bins_above: 34 },
    new_strategy: "curve",
    amount_sol: 0.05,
    amount_x: 1000000,
    active_bin: -65,
    reason: "test rebalance",
  });

  const oldPosAfter = getTrackedPosition(oldAddr);
  assert.strictEqual(oldPosAfter.closed, true, "Old position should be marked closed");

  const trackedNew = getTrackedPosition(newAddr);
  assert.strictEqual(trackedNew.rebalance_count, 1, "New position rebalance_count should be 1");
  assert.strictEqual(trackedNew.total_fees_claimed_sol, 0, "New position account claimed fees should start at 0");
  assert.strictEqual(trackedNew.total_fees_claimed_true_usd, 0, "New position account claimed fees USD should start at 0");
  assert.strictEqual(trackedNew.cumulative_fees_claimed_sol, 0.05, "Cumulative claimed fees SOL should carry over to new position");
  assert.strictEqual(trackedNew.cumulative_fees_claimed_true_usd, 7.5, "Cumulative claimed fees USD should carry over to new position");
  assert.strictEqual(trackedNew.root_parent_position, oldAddr, "Root parent position should link to ancestor");
  assert.strictEqual(trackedNew.strategy, "curve", "Strategy should be updated to target_strategy");

  console.log("✅ Test 1 Passed: rebalancePositionState correctly closes old pos, tracks new pos, carries over cumulative fees, links parent");
}

// 2. Test rebalancePosition in dlmm.js (Dry Run & Clamp to <= 70 bins)
{
  const { rebalancePosition } = await import("../tools/dlmm.js");

  // Case A: Requesting 80 bins total (40 below + 40 above) should be clamped to <= 70 bins
  const res = await rebalancePosition({
    position_address: "MOCK_ADDR",
    target_strategy: "curve",
    bins_below: 40,
    bins_above: 40,
    reason: "test clamp",
  });

  assert.strictEqual(res.dry_run, true);
  assert.ok(res.would_rebalance.total_bins <= 70, `Total bins ${res.would_rebalance.total_bins} must be <= 70`);
  console.log(`✅ Test 2 Passed: rebalancePosition dry-run clamps requested bins to <= 70 (resolved ${res.would_rebalance.total_bins} bins)`);

  // Case B: Extreme asymmetric bins (e.g. 68 below, 1 above) should be normalized to balanced [35, 34]
  const resSkew = await rebalancePosition({
    position_address: "MOCK_ADDR",
    target_strategy: "curve",
    bins_below: 68,
    bins_above: 1,
    reason: "test skew guard",
  });
  assert.strictEqual(resSkew.would_rebalance.bins_below, 35);
  assert.strictEqual(resSkew.would_rebalance.bins_above, 34);
  console.log("✅ Test 2B Passed: rebalancePosition normalizes extreme asymmetric bins to balanced [35, 34]");
}

// 3. Test hold_mode safety guard for rebalance_position in executor.js
{
  const { setPositionHold } = await import("../state.js");
  const { executeTool } = await import("../tools/executor.js");

  const holdPosAddr = "TEST_HOLD_POS_" + Date.now();
  trackPosition({
    position: holdPosAddr,
    pool: "TEST_POOL",
    pool_name: "TEST-HOLD",
    amount_sol: 1.0,
    strategy: "spot",
  });
  setPositionHold(holdPosAddr, true);
  assert.strictEqual(getTrackedPosition(holdPosAddr)?.hold_mode, true);

  // Attempt rebalance without operatorOverride -> MUST BE BLOCKED
  const blockedRes = await executeTool("rebalance_position", {
    position_address: holdPosAddr,
    reason: "autonomous test",
  }, { operatorOverride: false });

  assert.strictEqual(blockedRes.blocked, true, "rebalance_position must be blocked when hold_mode=true and operatorOverride=false");
  console.log("✅ Test 3 Passed: rebalance_position blocked by hold_mode when operatorOverride=false");

  // Attempt rebalance with operatorOverride -> MUST PROCEED (in dry run)
  const allowedRes = await executeTool("rebalance_position", {
    position_address: holdPosAddr,
    reason: "manual operator override",
  }, { operatorOverride: true });

  assert.strictEqual(allowedRes.blocked, undefined, "rebalance_position must not be blocked when operatorOverride=true");
  assert.strictEqual(allowedRes.dry_run, true, "rebalance_position proceeds to dry_run execution with operatorOverride=true");
  console.log("✅ Test 4 Passed: rebalance_position passes through with operatorOverride=true on On Hold position");
}

// 4. Test formatRebalanceMessage and notifyRebalance in telegram.js
{
  const { formatRebalanceMessage, notifyRebalance } = await import("../telegram.js");

  const msg = formatRebalanceMessage({
    pair: "TOAD-SOL",
    pool: "POOL111111111111111111111111111111111111111",
    oldPosition: "OLD222222222222222222222222222222222222222",
    newPosition: "NEW333333333333333333333333333333333333333",
    rebalanceCount: 2,
    strategy: "curve",
    binRange: { min: -35, max: 34, active: 120 },
    amountSol: 0.45,
    feesClaimedSol: 0.0125,
    cumulativeFeesSol: 0.025,
    gasSol: 0.00048,
    reason: "Autonomous rebalance: 15m trend confirmed (+0.42%)",
    txs: ["txSig1111111111111111111111111111111111111111", "txSig2222222222222222222222222222222222222222"],
  });

  assert.ok(msg.includes("🔄 <b>Rebalanced</b> TOAD-SOL (Rebalance #2)"), "Must include pair and rebalance count");
  assert.ok(msg.includes("Old: <code>OLD22222...</code> → New: <code>NEW33333...</code>"), "Must format old and new positions");
  assert.ok(msg.includes("Range: -35 → 34 · (active: 120) · 70 bins · curve"), "Must format bin range and strategy");
  assert.ok(msg.includes("Redeployed: ◎0.4500"), "Must include redeployed SOL amount");
  assert.ok(msg.includes("Fees harvested: ◎0.0125"), "Must include harvested fees");
  assert.ok(msg.includes("Lineage: ◎0.0250"), "Must include lineage cumulative fees");
  assert.ok(msg.includes("⛽ ◎0.00048"), "Must include gas cost");
  assert.ok(msg.includes("Reason: Autonomous rebalance: 15m trend confirmed (+0.42%)"), "Must include reason");
  assert.ok(msg.includes("https://app.meteora.ag/dlmm/POOL111111111111111111111111111111111111111"), "Must link to Meteora pool");
  assert.ok(msg.includes("https://solscan.io/account/NEW333333333333333333333333333333333333333"), "Must link to new position");
  assert.ok(msg.includes("https://solscan.io/account/OLD222222222222222222222222222222222222222"), "Must link to old position");
  assert.ok(msg.includes("https://solscan.io/tx/txSig1111111111111111111111111111111111111111"), "Must link to tx1");
  assert.ok(msg.includes("https://solscan.io/tx/txSig2222222222222222222222222222222222222222"), "Must link to tx2");

  // notifyRebalance should execute without unhandled rejection even without configured bot token
  await notifyRebalance({
    pair: "TOAD-SOL",
    rebalanceCount: 1,
  });

  console.log("✅ Test 5 Passed: formatRebalanceMessage produces complete HTML notification with all required metrics & links");
}

console.log("=== All Rebalance Execution Flow Tests Passed! ===");
process.exit(0);
