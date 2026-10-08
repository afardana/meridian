process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Straddle: a failed stage-A send is judged by re-reading the account ===");

const { classifyStageAOutcome, straddleFailureNextStep, stageATxEvidence } = await import("../harvest-straddle.js");

// baton-SOL 2026-10-08: all-SOL above its range (-378..-326), stage A sent for -345..-293.
const before = { lower: -378, upper: -326, sol: 0.948404, baseSol: 0, feesSol: 0.0194 };
const target = { lower: -345, upper: -293 };

// What was on chain: a Meteora-UI rebalance landed 4 slots earlier (same target range, since
// both centre the same width on the active bin) and refilled it two-sided — 0.498602 SOL +
// 5699.2 base (◎0.4486). Our transaction failed with 6083. Not a half ladder, not ours.
{
  const r = classifyStageAOutcome({ before, after: { lower: -345, upper: -293, sol: 0.498602, baseSol: 0.448646, feesSol: 0 }, target, ratio: 0.5 });
  assert.equal(r.outcome, "external");
  assert.equal(r.moved, true);
  assert.equal(r.fees_claimed, true);          // the other rebalance claimed the fees
}
// Our stage A landed although the send threw (e.g. a confirmation timeout): at the target
// range, half the SOL gone, no base added.
{
  const r = classifyStageAOutcome({ before, after: { lower: -345, upper: -293, sol: 0.4742, baseSol: 0, feesSol: 0 }, target, ratio: 0.5 });
  assert.equal(r.outcome, "stage_a");
  assert.equal(r.fees_claimed, true);
}
// Other ratios: 30 % out leaves 70 %.
assert.equal(classifyStageAOutcome({ before, after: { lower: -345, upper: -293, sol: 0.6639, baseSol: 0, feesSol: 0 }, target, ratio: 0.3 }).outcome, "stage_a");
// Nothing landed: same range, same liquidity.
{
  const r = classifyStageAOutcome({ before, after: { ...before }, target, ratio: 0.5 });
  assert.equal(r.outcome, "unchanged");
  assert.equal(r.moved, false);
  assert.equal(r.fees_claimed, false);
}
// Price fell back into the range meanwhile: SOL became base at the same value — still unchanged.
assert.equal(classifyStageAOutcome({ before, after: { lower: -378, upper: -326, sol: 0.80, baseSol: 0.149, feesSol: 0.0196 }, target, ratio: 0.5 }).outcome, "unchanged");
// Re-ranged elsewhere, or emptied in place: changed, but not stage A.
assert.equal(classifyStageAOutcome({ before, after: { lower: -350, upper: -298, sol: 0.4742, baseSol: 0, feesSol: 0 }, target, ratio: 0.5 }).outcome, "external");
assert.equal(classifyStageAOutcome({ before, after: { lower: -345, upper: -293, sol: 0.948, baseSol: 0, feesSol: 0 }, target, ratio: 0.5 }).outcome, "external");
assert.equal(classifyStageAOutcome({ before, after: { lower: -378, upper: -326, sol: 0.2, baseSol: 0, feesSol: 0.0194 }, target, ratio: 0.5 }).outcome, "external");
// Unreadable account → unknown (the caller falls back to whether the send resolved).
assert.equal(classifyStageAOutcome({ before, after: null, target }).outcome, "unknown");
assert.equal(classifyStageAOutcome({ before, after: { lower: -345, upper: -293 }, target }).outcome, "unknown");
assert.equal(classifyStageAOutcome({}).outcome, "unknown");

// ── Review additions (2026-10-08) ──────────────────────────────────────────────────────
// Stage A re-deposits the unclaimed fees with the liquidity: (SOL + SOL fees) x (1 - ratio)
// and ALL the base fees. A landed stage A with base-side fees above 2 % of the liquidity
// used to read as "base added" → external → the half ladder was kept and no flow booked.
{
  const b2 = { lower: -378, upper: -326, sol: 0.948404, baseSol: 0, feesSol: 0.07 };   // ◎0.03 SOL fees + ◎0.04 base fees
  const landed = { lower: -345, upper: -293, sol: 0.4892, baseSol: 0.04, feesSol: 0 };  // (0.9484 + 0.03) / 2, base fees in
  const expected = { sol: 0.4892, baseSol: 0.04 };                                      // the simulation's deposits
  const r = classifyStageAOutcome({ before: b2, after: landed, target, ratio: 0.5, expected });
  assert.equal(r.outcome, "stage_a");
  assert.equal(r.by, "account");
  // …and with the simulation's amounts the same-range UI rebalance is still not ours.
  assert.equal(classifyStageAOutcome({ before: b2, after: { lower: -345, upper: -293, sol: 0.52, baseSol: 0.4984, feesSol: 0 }, target, ratio: 0.5, expected }).outcome, "external");
  // Same range, everything re-deposited one-sided (a UI rebalance that adds no base): external.
  assert.equal(classifyStageAOutcome({ before: b2, after: { lower: -345, upper: -293, sol: 1.0184, baseSol: 0, feesSol: 0 }, target, ratio: 0.5, expected }).outcome, "external");
  // Unusable simulation amounts fall back to the ratio rule.
  assert.equal(classifyStageAOutcome({ before, after: { lower: -345, upper: -293, sol: 0.4742, baseSol: 0, feesSol: 0 }, target, ratio: 0.5, expected: { sol: 0, baseSol: 0 } }).outcome, "stage_a");
}
// Our own signature decides when it is known.
{
  // Confirmed without an error: landed — even when the price fell through the fresh range
  // afterwards (SOL → base), which the account alone reads as "base added".
  const fell = { lower: -345, upper: -293, sol: 0.40, baseSol: 0.074, feesSol: 0 };
  assert.equal(classifyStageAOutcome({ before, after: fell, target, ratio: 0.5 }).outcome, "external");            // account alone: conservative
  const r = classifyStageAOutcome({ before, after: fell, target, ratio: 0.5, ourTx: "landed" });
  assert.equal(r.outcome, "stage_a");
  assert.equal(r.by, "signature");
  // …and when the re-read still shows the pre-stage account (RPC lag) or nothing at all.
  assert.equal(classifyStageAOutcome({ before, after: { ...before }, target, ourTx: "landed" }).outcome, "stage_a");
  assert.equal(classifyStageAOutcome({ before, after: null, target, ourTx: "landed" }).outcome, "stage_a");
  // Our transaction provably did not execute (today: 6083 in simulation): an account that
  // happens to look like a landed stage A is someone else's — never a close to cash.
  const lookalike = { lower: -345, upper: -293, sol: 0.4742, baseSol: 0, feesSol: 0 };
  const f = classifyStageAOutcome({ before, after: lookalike, target, ratio: 0.5, ourTx: "failed" });
  assert.equal(f.outcome, "external");
  assert.equal(straddleFailureNextStep({ changed: false, stage: "A", stage_a_outcome: f.outcome, external_change: true }), "keep");
  // A failed transaction changes nothing about the other verdicts.
  assert.equal(classifyStageAOutcome({ before, after: { ...before }, target, ourTx: "failed" }).outcome, "unchanged");
  assert.equal(classifyStageAOutcome({ before, after: null, target, ourTx: "failed" }).outcome, "unknown");
}
// Read lag without signature evidence: the pre-stage account reads "unchanged", an unreadable
// one "unknown" — both keep the position (never a close on a state that was not seen).
assert.equal(straddleFailureNextStep({ changed: false, stage: "A", stage_a_outcome: "unknown" }), "keep");
assert.equal(straddleFailureNextStep({ changed: false, stage: "A", stage_a_outcome: classifyStageAOutcome({ before, after: { ...before }, target }).outcome }), "keep");

// What the signature says.
assert.equal(stageATxEvidence({ signature: "sig", status: { err: null, confirmationStatus: "confirmed" } }), "landed");
assert.equal(stageATxEvidence({ signature: "sig", status: { err: null, confirmationStatus: "finalized" } }), "landed");
assert.equal(stageATxEvidence({ signature: "sig", status: { err: null, confirmationStatus: "processed" } }), "unknown");
assert.equal(stageATxEvidence({ signature: "sig", status: { err: { InstructionError: [2, { Custom: 6083 }] }, confirmationStatus: "confirmed" } }), "failed");
assert.equal(stageATxEvidence({ signature: "sig", status: null }), "unknown");                 // expired unlanded, or the RPC is behind
assert.equal(stageATxEvidence({ signature: "sig", status: null, message: "custom program error: 0x17c3" }), "unknown"); // a signature outranks the message
assert.equal(stageATxEvidence({ message: "Simulation failed. Message: Transaction simulation failed: Error processing Instruction 2: custom program error: 0x17c3" }), "failed");
assert.equal(stageATxEvidence({ message: "fetch failed" }), "unknown");                        // may have been broadcast
assert.equal(stageATxEvidence({}), "unknown");

// The caller: only OUR landed stage A cashes out; an external change keeps the position.
assert.equal(straddleFailureNextStep({ changed: true, stage: "A", stage_a_outcome: "stage_a" }), "close_reranged");
assert.equal(straddleFailureNextStep({ changed: false, stage: "A", stage_a_outcome: "external", external_change: true }), "keep");
assert.equal(straddleFailureNextStep({ changed: false, stage: "A", stage_a_outcome: "unchanged" }), "keep");

// Source: the stage-A send is wrapped, the account re-read, and the verdict drives the flags.
const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
const body = dlmm.slice(dlmm.indexOf("export async function straddlePositionInPlace"), dlmm.indexOf("// ─── Helpers ───"));
const iSend = body.indexOf('await sendRebalance(respA, "straddle:withdraw");');
const iCatch = body.indexOf("} catch (sendErr) {");
const iThrow = body.indexOf("throw sendErr;");
const iB = body.indexOf("// ── B: buy the base side");
assert.ok(iSend > 0 && iCatch > iSend && iThrow > iCatch && iB > iThrow);
const handler = body.slice(iCatch, iThrow);
assert.match(handler, /classifyStageAOutcome\(\{/);
assert.match(handler, /pool\.getPosition\(posPk\)/);                       // decided from the account, not the send
// The signature is looked up before the account is judged, and both go to the classifier
// together with the simulation's own deposit amounts.
assert.match(handler, /sendErr\?\.confirmedSignature \|\| sendErr\?\.signature/);
assert.match(handler, /getSignatureStatuses\(\[sigA\], \{ searchTransactionHistory: true \}\)/);
assert.match(handler, /classifyStageAOutcome\(\{\s*before: beforeA, after: afterA, ratio, expected: expectedA, ourTx,/);
assert.match(handler, /amountYDeposited[\s\S]*?amountXDeposited/);
// Exactly one flow booking in the handler, and exactly one on the path that did not throw.
assert.equal(handler.split("noteFlow(").length - 1, 1);
assert.match(body.slice(iThrow, iB), /^throw sendErr;\s*\}\s*noteFlow\(respA, solPerBaseA, "withdraw"\);/);
// Ours landed → flagged changed and the flow booked as on the successful path.
assert.match(handler, /verdict\.outcome === "stage_a"\) \{[\s\S]*?rerangeLanded = true;\s*noteFlow\(respA, solPerBaseA, "withdraw"\);/);
// External → no flow of ours, no `changed`; only the fees it claimed go to the ledger.
const ext = handler.slice(handler.indexOf('verdict.outcome === "external"'));
assert.doesNotMatch(ext, /rerangeLanded = true|noteFlow\(/);
assert.match(ext, /verdict\.fees_claimed && claimedFeesSol > 0[\s\S]*?recordClaim\(position_address/);
assert.match(body, /changed: rerangeLanded, stage, aborted[^\n]*external_change: stageAOutcome === "external"/);
// B and C failures are handled as before (unwind after C, range sync for every stage).
assert.match(body, /if \(stage === "C" && boughtX > 0 && baseMint\)/);
assert.match(body, /if \(stage !== "init"\) \{/);

// state.js: the failure note moves the recorded range / bumps the counter only when the
// on-chain range differs from the recorded one.
const state = fs.readFileSync(new URL("../state.js", import.meta.url), "utf8");
assert.match(state, /if \(moved\) pos\.in_place_rerange_count = /);

const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
assert.match(idx, /res\.external_change\s*\?/);

console.log("✅ stage-A re-read verified");
process.exit(0);
