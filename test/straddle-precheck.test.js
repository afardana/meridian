process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Straddle: buy checked before stage A; a stopped straddle cashes out ===");

const { straddleBuyPreCheck } = await import("../tools/dlmm.js");
const { cashHarvestReason, straddleFailureNextStep } = await import("../harvest-straddle.js");

// Aiden-SOL 2026-10-04: ◎0.5118 to split, impact 3.71 % against a 3 % cap.
const solPerBase = 0.0000125, decX = 6;
const quoteAt = (impactPct) => async (amt) => ({ out_amount: Math.round((amt / solPerBase) * (1 - impactPct / 100) * 10 ** decX) });
{
  const r = await straddleBuyPreCheck({ swapSol: 0.5092, solPerBase, decX, maxImpactPct: 3, getQuote: quoteAt(3.71) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /buy impact 3\.71% vs cap 3%/);
}
assert.equal((await straddleBuyPreCheck({ swapSol: 0.5092, solPerBase, decX, maxImpactPct: 3, getQuote: quoteAt(0.94) })).ok, true);
// Fail-closed: no quote, a thrown quote, no price, too little to split.
assert.equal((await straddleBuyPreCheck({ swapSol: 0.5, solPerBase, decX, maxImpactPct: 3, getQuote: async () => ({ error: "429" }) })).ok, false);
assert.equal((await straddleBuyPreCheck({ swapSol: 0.5, solPerBase, decX, maxImpactPct: 3, getQuote: async () => { throw new Error("down"); } })).ok, false);
assert.equal((await straddleBuyPreCheck({ swapSol: 0.5, solPerBase: 0, decX, maxImpactPct: 3, getQuote: quoteAt(0) })).ok, false);
assert.equal((await straddleBuyPreCheck({ swapSol: 0.04, solPerBase, decX, maxImpactPct: 3, getQuote: quoteAt(0) })).ok, false);

// What the caller does with a straddle that did not complete.
assert.equal(straddleFailureNextStep({ pre_check: true, changed: false }), "close_untouched");
assert.equal(straddleFailureNextStep({ changed: true, stage: "A" }), "close_reranged");   // stage A landed
assert.equal(straddleFailureNextStep({ changed: true, stage: "C" }), "close_reranged");
assert.equal(straddleFailureNextStep({ changed: false, stage: "A" }), "keep");            // the stage A tx itself failed

// Wording: only a cash exit "pays no slippage".
const h = "Round-trip complete: 8 bins above range, pnl frozen at 4.87% across 6 ticks (+/-0.05pp) — position is all-SOL, no further upside";
assert.equal(cashHarvestReason(h, "harvest"), `${h} — cash exit pays no slippage`);
assert.equal(cashHarvestReason(cashHarvestReason(h, "harvest"), "harvest"), `${h} — cash exit pays no slippage`); // once
assert.equal(cashHarvestReason("Stop loss: effective PnL -16% <= -15%", "stop_loss"), "Stop loss: effective PnL -16% <= -15%");
assert.equal(cashHarvestReason("", "harvest"), "");
const state = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
assert.doesNotMatch(state, /exit pays no slippage/);       // the harvest reason itself no longer claims it

// Order in the straddle: pre-check → stage A send; the landed flag is set right after the send.
const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
const body = dlmm.slice(dlmm.indexOf("export async function straddlePositionInPlace"));
const iPre = body.indexOf("await straddleBuyPreCheck("), iSend = body.indexOf('await sendRebalance(respA, "straddle:withdraw");');
assert.ok(iPre > 0 && iSend > iPre);
assert.match(body, /await sendRebalance\(respA, "straddle:withdraw"\);\s*rerangeLanded = true;/);
assert.match(body, /changed: rerangeLanded, stage, aborted/);
const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
assert.match(idx, /const next = straddleFailureNextStep\(res\);/);
assert.match(idx, /const reason = cashHarvestReason\(act\.reason, act\.family\)/);
// The pre-check quotes SOL still inside the position: no taker, or Jupiter answers
// "Insufficient funds" whenever the wallet's free SOL is below the amount (baton-SOL 2026-10-06).
assert.match(body, /getQuote: \(amount\) => wm\.getSwapQuote\(\{[^}]*skip_taker: true[^}]*\}\)/);

console.log("✅ straddle pre-check verified");
process.exit(0);
