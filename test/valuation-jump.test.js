import assert from "node:assert/strict";
import fs from "node:fs";
import { classifyPnlJump } from "../valuation-jump.js";

console.log("=== Valuation step plausibility ===");

// 2026-10-04 glitches: PnL rose while the price fell fast.
assert.equal(classifyPnlJump({ lastPnl: 0.28, lastBin: -377, pnl: 4.91, bin: -395 }), "up");   // knightcat-SOL
assert.equal(classifyPnlJump({ lastPnl: 4.32, lastBin: -443, pnl: 8.30, bin: -459 }), "up");   // SPLICE-SOL
// The readings that followed stay suspect against the same trusted reference.
assert.equal(classifyPnlJump({ lastPnl: 0.28, lastBin: -377, pnl: 5.40, bin: -396 }), "up");
// The real value arriving is a plain (trusted) drop, not a suspect one.
assert.equal(classifyPnlJump({ lastPnl: 0.28, lastBin: -377, pnl: -5.77, bin: -396 }), null);

// Ordinary moves are untouched.
assert.equal(classifyPnlJump({ lastPnl: 1.0, lastBin: -400, pnl: 3.5, bin: -396 }), null);     // rise with price rising
assert.equal(classifyPnlJump({ lastPnl: 1.0, lastBin: -400, pnl: 2.5, bin: -401 }), null);     // +1.5 pp, 1 bin down (fees)
assert.equal(classifyPnlJump({ lastPnl: 1.0, lastBin: -400, pnl: 3.2, bin: -402 }), null);     // 2 bins only
assert.equal(classifyPnlJump({ lastPnl: 1.0, lastBin: -400, pnl: 2.9, bin: -404 }), null);     // +1.9 pp < 2
assert.equal(classifyPnlJump({ lastPnl: -3, lastBin: -400, pnl: -9, bin: -410 }), null);       // normal loss on a fall
// Existing rules keep working.
assert.equal(classifyPnlJump({ lastPnl: 2, lastBin: -400, pnl: 20, bin: -398 }), "up");        // > 15 pp
assert.equal(classifyPnlJump({ lastPnl: 2, lastBin: -400, pnl: -40, bin: -400 }), "down");     // drop, price not falling
assert.equal(classifyPnlJump({ lastPnl: 2, lastBin: -400, pnl: -40, bin: -460 }), null);       // a real crash
// Missing data never flags.
assert.equal(classifyPnlJump({ lastPnl: null, lastBin: -400, pnl: 5, bin: -410 }), null);
assert.equal(classifyPnlJump({ lastPnl: 0.3, lastBin: null, pnl: 5, bin: -410 }), null);
// Switchable.
assert.equal(classifyPnlJump({ lastPnl: 0.28, lastBin: -377, pnl: 4.91, bin: -395, riseOnFallPp: 0 }), null);

const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
assert.match(idx, /dir = classifyPnlJump\(\{/);

console.log("✅ valuation jump verified");
