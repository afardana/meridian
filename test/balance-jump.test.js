import assert from "node:assert/strict";
import { isBalanceJump } from "../balance-jump.js";

console.log("=== Balance jump → immediate baseline scan ===");
// 2026-10-03: 2.314 → 7.889 on a 5.6 SOL deposit.
assert.equal(isBalanceJump(2.314, 7.889), true);
// A withdrawal is a jump too.
assert.equal(isBalanceJump(7.9, 5.9), true);
// Ordinary PnL drift between two samples is not.
assert.equal(isBalanceJump(2.318, 2.29), false);
assert.equal(isBalanceJump(7.889, 7.902), false);
// Large wallet: the 1 % floor applies (0.15 of 30 is noise, 0.4 is not).
assert.equal(isBalanceJump(30, 30.15), false);
assert.equal(isBalanceJump(30, 30.4), true);
// No previous sample / bad input never triggers.
assert.equal(isBalanceJump(null, 5), false);
assert.equal(isBalanceJump(0, 5), false);
assert.equal(isBalanceJump(2, NaN), false);
console.log("✅ balance jump verified");
