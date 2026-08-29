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

  assert.match(indexSource, /getTrackedPosition\(p\.position\)\?\.hold_mode === true/);
  assert.match(indexSource, /if \(operatorHold\) \{[\s\S]*registerExitSignal\(p\.position, null/);
  assert.match(indexSource, /if \(tracked\?\.hold_mode === true\) \{[\s\S]*return null;/);
  assert.match(indexSource, /auto-close disabled \(On Hold\)/);
  assert.match(indexSource, /holdMode: p\.hold_mode === true \|\| getTrackedPosition\(p\.position\)\?\.hold_mode === true/);
  assert.match(indexSource, /const reportLines = positionData\.map\(\(p, index\) =>/);
  assert.match(indexSource, /<b>\$\{index \+ 1\}\.<\/b> <a href=/);
  assert.match(indexSource, /Use <code>\/close \[number\]<\/code> to close a listed position/);
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
