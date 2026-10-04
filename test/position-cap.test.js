import assert from "node:assert/strict";
import fs from "node:fs";
import { countPositionsTowardCap } from "../position-cap.js";

console.log("=== Position cap: held positions excluded consistently ===");

const open = [
  { position: "A", hold_mode: true },
  { position: "B" },
  { position: "C" },            // held only in tracked state
  { position: "D", hold_mode: false },
];
const isHeld = (addr) => addr === "C";

assert.equal(countPositionsTowardCap(open), 4);
assert.equal(countPositionsTowardCap(open, { excludeHold: false, isHeld }), 4);
assert.equal(countPositionsTowardCap(open, { excludeHold: true, isHeld }), 2);
assert.equal(countPositionsTowardCap(open, { excludeHold: true }), 3);
assert.equal(countPositionsTowardCap(null, { excludeHold: true }), 0);

// The executor's deploy check and every index.js site use the shared count.
const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
assert.match(exec, /countPositionsTowardCap\(positions\.positions/);
assert.doesNotMatch(exec, /positions\.total_positions >= config\.risk\.maxPositions/);
const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
assert.doesNotMatch(idx, /total_positions \?\? 0\) >= config\.risk\.maxPositions/);
assert.equal((idx.match(/positionsTowardCap\(/g) || []).length >= 4, true);

console.log("✅ position cap count verified");
