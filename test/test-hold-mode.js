import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { updatePnlAndCheckExits } from "../state.js";

// This test exercises the state-layer guard without importing index.js (which
// starts the live cron/Telegram process as a module side effect). The source
// assertions cover the two caller paths that feed the state guard.
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const statePath = path.join(repoRoot, "state.json");
const indexSource = fs.readFileSync(path.join(repoRoot, "index.js"), "utf8");
const executorSource = fs.readFileSync(path.join(repoRoot, "tools", "executor.js"), "utf8");
const dlmmSource = fs.readFileSync(path.join(repoRoot, "tools", "dlmm.js"), "utf8");
const cliSource = fs.readFileSync(path.join(repoRoot, "cli.js"), "utf8");
const originalState = fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : null;
const testAddress = "TEST_OPERATOR_HOLD_POSITION";
const telegramSource = fs.readFileSync(path.join(repoRoot, "telegram.js"), "utf8");

try {
  let state = originalState ? JSON.parse(originalState) : { positions: {}, recentEvents: [] };
  state.positions ||= {};
  state.positions[testAddress] = {
    position: testAddress,
    pool: "TEST_POOL",
    pool_name: "TEST-SOL",
    closed: false,
    hold_mode: true,
    notes: [],
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

  const exit = updatePnlAndCheckExits(testAddress, {
    pnl_pct: -90,
    pnl_pct_suspicious: false,
    in_range: false,
    fee_per_tvl_24h: 0,
    active_bin: -500,
    lower_bin: -450,
    upper_bin: -400,
  }, {
    stopLossPct: -15,
    takeProfitPct: 1,
    trailingTakeProfit: true,
    trailingTriggerPct: 2,
    trailingDropPct: 1,
  });
  assert.equal(exit, null, "operator HOLD must suppress state-layer automatic exits");

  const { executeTool } = await import("../tools/executor.js");
  const blockedClose = await executeTool("close_position", {
    position_address: testAddress,
    reason: "health-check close attempt",
  });
  assert.equal(blockedClose.blocked, true, "executor must block a direct LLM-style close while held");

  const { closePosition, flipPositionInPlace } = await import("../tools/dlmm.js");
  const directClose = await closePosition({ position_address: testAddress, reason: "direct close attempt" });
  assert.equal(directClose.blocked, true, "DLMM close must defend against bypassing the executor");
  const directFlip = await flipPositionInPlace({ position_address: testAddress, reason: "direct flip attempt" });
  assert.equal(directFlip.blocked, true, "DLMM flip must defend against automatic bypasses");

  assert.match(indexSource, /getTrackedPosition\(p\.position\)\?\.hold_mode === true/);
  assert.match(indexSource, /if \(operatorHold\) \{[\s\S]*registerExitSignal\(p\.position, null/);
  assert.match(indexSource, /if \(tracked\?\.hold_mode === true\) \{[\s\S]*return null;/);
  assert.match(indexSource, /auto-close disabled \(On Hold\)/);
  assert.doesNotMatch(indexSource, /if \(act\.hold_mode\) line \+= .*automatic exits disabled/);
  assert.match(indexSource, /holdMode: p\.hold_mode === true \|\| getTrackedPosition\(p\.position\)\?\.hold_mode === true/);
  assert.match(indexSource, /const held = p\.hold_mode === true \|\| getTrackedPosition\(p\.position\)\?\.hold_mode === true;/);
  assert.match(indexSource, /if \(!held && !p\.in_range && p\.minutes_out_of_range >= config\.management\.outOfRangeWaitMinutes\)/);
  assert.match(executorSource, /executeTool\(name, args = \{\}, \{ operatorOverride = false \} = \{\}\)/);
  assert.match(executorSource, /name === "close_position" && !operatorOverride/);
  assert.match(dlmmSource, /closePosition\(\{ position_address, reason, urgent = false, exit_context = null, _operator_override = false \}\)/);
  assert.match(dlmmSource, /flipPositionInPlace\(\{ position_address, reason, strip_bins, _operator_override = false \}\)/);
  const healthStart = indexSource.indexOf("const healthTask = cron.schedule");
  const healthEnd = indexSource.indexOf("// Morning Briefing", healthStart);
  assert.ok(healthStart >= 0 && healthEnd > healthStart, "health task source must be present");
  const healthBlock = indexSource.slice(healthStart, healthEnd);
  assert.doesNotMatch(healthBlock, /agentLoop\(/, "hourly health check must not invoke the action-capable agent");
  assert.match(healthBlock, /getWalletBalances\(\{ freshPositions: false \}\)/);
  assert.match(healthBlock, /getMyPositions\(\{ force: true, silent: true \}\)/);
  assert.match(indexSource, /manual close \(\/close\).*operatorOverride: true/s);
  assert.match(cliSource, /skip_swap: flags\["skip-swap"\] \?\? false,[\s\S]*operatorOverride: true/);
  assert.match(indexSource, /const reportLines = positionData\.map\(\(p, index\) =>/);
  assert.match(indexSource, /<b>\$\{index \+ 1\}\.<\/b> <a href=/);
  assert.doesNotMatch(indexSource, /Use <code>\/close \[number\]<\/code> to close a listed position/);
  assert.match(indexSource, /const closeMatch = text\.match\(\/\^\\\/close\\s\+\(\\d\+\)\$\/i\)/);
  assert.match(telegramSource, /holdMode = false/);
  assert.match(telegramSource, /auto-close disabled \(On Hold\)/);

  console.log("Operator HOLD exit guards passed.");
} finally {
  if (originalState == null) {
    try { fs.unlinkSync(statePath); } catch (_) {}
  } else {
    fs.writeFileSync(statePath, originalState);
  }
}

process.exit(0);
