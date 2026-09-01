import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const indexSource = fs.readFileSync(path.join(repoRoot, "index.js"), "utf8");
const configSource = fs.readFileSync(path.join(repoRoot, "config.js"), "utf8");
const socketSource = fs.readFileSync(path.join(repoRoot, "tools/socket-monitor.js"), "utf8");
const planSource = fs.readFileSync(path.join(repoRoot, "docs/plans/14-adoption-burst-and-websocket-discovery.md"), "utf8");

assert.match(indexSource, /const ORPHAN_ADOPTION_BURST_INTERVAL_MS =/);
assert.match(indexSource, /const _orphanCandidates = new Map/);
assert.match(indexSource, /const runAdoptionBurst = async \(\)/);
assert.match(indexSource, /isPositionAccountLive\(p\.position\)/);
assert.match(indexSource, /via 5s adoption burst/);
assert.match(indexSource, /_cronTasks\._adoptionBurstInterval/);
assert.match(indexSource, /_ownerDiscoveryWsHealthy/);
assert.match(indexSource, /pnlDiscoveryFallbackMs/);
assert.match(indexSource, /startSocketMonitor\(pnlConn, \{ walletAddress: getWalletAddress\(\) \}\)/);

assert.match(configSource, /adoptionBurstIntervalSec: Number\(u\.pnlAdoptionBurstIntervalSec \?\? 5\)/);
assert.match(configSource, /discoveryFallbackIntervalSec: Number\(u\.pnlDiscoveryFallbackIntervalSec \?\? 300\)/);
assert.match(socketSource, /onProgramAccountChange\(/);
assert.match(socketSource, /positionV2Filter/);
assert.match(socketSource, /positionOwnerFilter/);
assert.match(socketSource, /requestPositionDiscovery\(/);
assert.match(socketSource, /setPositionDiscoverySignalSink/);
assert.match(socketSource, /_rpcWebSocket/);
assert.match(socketSource, /state=closed/);
assert.match(socketSource, /subscription retry scheduled/);

assert.match(planSource, /## Implemented in this change/);
assert.match(planSource, /### P1 — WebSocket health and recovery/);
assert.match(planSource, /### P2 — Adaptive candidate cadence/);

console.log("Adoption burst and WebSocket discovery coverage passed.");
