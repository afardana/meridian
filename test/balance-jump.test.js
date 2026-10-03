import assert from "node:assert/strict";
import { isBalanceJump } from "../balance-jump.js";

console.log("=== Balance jump → immediate baseline scan ===");
const s = (totalSol, idleSol) => ({ totalSol, idleSol });
// 2026-10-03: +5.6 SOL deposit — idle and total step together.
assert.equal(isBalanceJump(s(2.314, 0.017), s(7.889, 5.616)), true);
// A withdrawal is a jump too.
assert.equal(isBalanceJump(s(7.9, 5.6), s(5.9, 3.6)), true);
// A held position's PnL swing moves the total only (fired on every sample before).
assert.equal(isBalanceJump(s(7.5662, 3.2), s(7.1858, 3.2)), false);
assert.equal(isBalanceJump(s(7.3403, 3.2), s(7.6304, 3.2)), false);
// Deploy / close: idle moves against deployed, total flat.
assert.equal(isBalanceJump(s(7.5, 5.4), s(7.5, 3.4)), false);
// A close with a loss: idle up, total down — not a deposit.
assert.equal(isBalanceJump(s(7.5, 3.4), s(7.2, 5.1)), false);
// Ordinary drift.
assert.equal(isBalanceJump(s(2.318, 0.017), s(2.29, 0.017)), false);
// Large wallet: the 1 % floor applies.
assert.equal(isBalanceJump(s(30, 10), s(30.15, 10.15)), false);
assert.equal(isBalanceJump(s(30, 10), s(30.4, 10.4)), true);
// No previous sample / bad input never triggers.
assert.equal(isBalanceJump(null, s(5, 5)), false);
assert.equal(isBalanceJump(s(0, 0), s(5, 5)), false);
assert.equal(isBalanceJump(s(2, 1), s(NaN, 1)), false);
console.log("✅ balance jump verified");
