process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";

console.log("=== Close audit: booked result vs the wallet's on-chain flows ===");

const { walletDeltas, summarizeFlows, evaluateCloseAudit, auditTolerance, fetchCloseFlows } = await import("../close-audit.js");

const W = "WALLET", M = "MINT";
const tx = ({ t, sol, tokPre = null, tokPost = null, err = null }) => ({
  blockTime: t,
  transaction: { message: { accountKeys: [{ pubkey: { toString: () => W } }, { pubkey: { toString: () => "OTHER" } }] } },
  meta: {
    err, preBalances: [10e9, 0], postBalances: [10e9 + Math.round(sol * 1e9), 0],
    preTokenBalances: tokPre == null ? [] : [{ owner: W, mint: M, uiTokenAmount: { uiAmountString: String(tokPre) } }],
    postTokenBalances: tokPost == null ? [] : [{ owner: W, mint: M, uiTokenAmount: { uiAmountString: String(tokPost) } }],
  },
});

// CLAUDIA-SOL 2026-10-04 (wallet flows as read on chain): deploy, stage A, buy, stage C, claim, fee swap, claim, close, exit swap.
const pos = [
  tx({ t: 100, sol: -0.783424 }), tx({ t: 200, sol: 0.374102, tokPre: 0, tokPost: 19.795 }),
  tx({ t: 230, sol: 0.003629, tokPre: 39226.458, tokPost: 406.129 }), tx({ t: 300, sol: 0.022404, tokPre: 406.129, tokPost: 2230.408 }),
  tx({ t: 400, sol: 0.008007, tokPre: 1824.28, tokPost: 1824.281 }), tx({ t: 401, sol: 0.843678 }),
];
const wal = [
  tx({ t: 205, sol: -0.372214, tokPre: 19.795, tokPost: 39226.458 }), tx({ t: 301, sol: 0.004284, tokPre: 2230.408, tokPost: 1824.28 }),
  tx({ t: 410, sol: 0.025363, tokPre: 1824.281, tokPost: 0 }),
  tx({ t: 250, sol: -1.5 }),                                   // unrelated wallet traffic: ignored
];
const flows = summarizeFlows({ posTxs: pos, walletTxs: wal, wallet: W, baseMint: M });
assert.ok(Math.abs(flows.net_sol - 0.125829) < 1e-6);
assert.ok(Math.abs(flows.net_tokens) < 1e-6);
assert.equal(flows.tx_count, 9);
assert.equal(flows.last_position_tx_time, 401);

const rec = (net) => ({ pnl_sol_net: net, amount_sol: 0.74, recorded_at: new Date(405 * 1000).toISOString() });
assert.equal(evaluateCloseAudit(rec(0.124423), flows).status, "ok");             // the corrected record
const bad = evaluateCloseAudit(rec(0.142109), flows);                            // fees double-counted
assert.equal(bad.status, "mismatch");
assert.ok(Math.abs(bad.diff_sol - 0.01628) < 1e-5);
assert.ok(Math.abs(auditTolerance(0.74) - 0.0111) < 1e-9);
assert.equal(auditTolerance(0.25), 0.01);

// A redeploy into the same pool right after the close is another position's DLMM transaction:
// it lists the wallet's token account (zero balance) and must not be counted (knightcat 6QGbwfHz).
{
  const redeploy = tx({ t: 420, sol: -0.44191, tokPre: 0, tokPost: 0 });
  redeploy.meta.logMessages = ["Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke [1]", "Program log: Instruction: InitializePosition", "Program log: Instruction: AddLiquidityByStrategy2"];
  const closeAcct = tx({ t: 430, sol: 0.00204, tokPre: 0 });           // token account closed: rent back, counted
  const f2 = summarizeFlows({ posTxs: [tx({ t: 100, sol: -0.443424 }), tx({ t: 400, sol: 0.001273 }), tx({ t: 402, sol: 0.441833 })], walletTxs: [redeploy, closeAcct], wallet: W, baseMint: M });
  assert.ok(Math.abs(f2.net_sol - (-0.443424 + 0.001273 + 0.441833 + 0.00204)) < 1e-9);
  assert.equal(evaluateCloseAudit({ pnl_sol_net: 0.001196, amount_sol: 0.4, recorded_at: new Date(405e3).toISOString() }, f2).status, "ok");
  // An exit swap routed THROUGH the DLMM pool invokes the same program but is a swap: counted.
  const routed = tx({ t: 410, sol: 0.118, tokPre: 6871.5, tokPost: 0 });
  routed.meta.logMessages = ["Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke [2]", "Program log: Instruction: Swap2"];
  const f3 = summarizeFlows({ posTxs: [tx({ t: 100, sol: -0.44 }), tx({ t: 402, sol: 0.33, tokPre: 0, tokPost: 6871.5 })], walletTxs: [routed, redeploy], wallet: W, baseMint: M });
  assert.ok(Math.abs(f3.net_sol - 0.008) < 1e-9 && Math.abs(f3.net_tokens) < 1e-9);
}

// Tokens that do not net out (a remainder still held, or the operator brought tokens) → no verdict.
const held = summarizeFlows({ posTxs: [tx({ t: 100, sol: -0.5 }), tx({ t: 400, sol: 0.3, tokPre: 0, tokPost: 5000 })], walletTxs: [], wallet: W, baseMint: M });
assert.equal(evaluateCloseAudit({ pnl_sol_net: 0.01, amount_sol: 0.5, recorded_at: new Date(402e3).toISOString() }, held).status, "incomplete");
// The closing transaction missing from the read (short signature listing) → retry, never an alert.
const short = summarizeFlows({ posTxs: [tx({ t: 100, sol: -0.443424 }), tx({ t: 700, sol: 0.001273 })], walletTxs: [], wallet: W, baseMint: M });
const v = evaluateCloseAudit({ pnl_sol_net: 0.0012, amount_sol: 0.4, recorded_at: new Date(1400e3).toISOString() }, short);
assert.deepEqual([v.status, v.retry], ["incomplete", true]);
// An unreadable position transaction → retry.
const unread = summarizeFlows({ posTxs: [tx({ t: 100, sol: -0.4 }), { meta: { err: "unreadable" } }], walletTxs: [], wallet: W, baseMint: M });
assert.deepEqual([evaluateCloseAudit(rec(0), unread).status, evaluateCloseAudit(rec(0), unread).retry], ["incomplete", true]);
assert.equal(evaluateCloseAudit({ amount_sol: 1 }, flows).status, "no_data");
assert.equal(walletDeltas(tx({ t: 1, sol: 1, err: { x: 1 } }), W, M), null);

// fetchCloseFlows: wallet window, failed position txs dropped, retry on a thrown read.
{
  const posSigs = [{ signature: "c", blockTime: 401 }, { signature: "f", blockTime: 300, err: { x: 1 } }, { signature: "a", blockTime: 100 }];
  const walSigs = [{ signature: "late", blockTime: 9000 }, { signature: "w", blockTime: 410 }, { signature: "c", blockTime: 401 }, { signature: "old", blockTime: 50 }];
  const txs = { a: tx({ t: 100, sol: -0.5 }), c: tx({ t: 401, sol: 0.4, tokPre: 0, tokPost: 100 }), w: tx({ t: 410, sol: 0.11, tokPre: 100, tokPost: 0 }) };
  let throws = 1;
  const conn = {
    getSignaturesForAddress: async (pk) => (pk.k === "POS" ? posSigs : walSigs),
    getParsedTransaction: async (sig) => { if (sig === "a" && throws-- > 0) throw new Error("429"); return txs[sig] ?? null; },
  };
  class PK { constructor(k) { this.k = k; } }
  const f = await fetchCloseFlows({ rpc: (fn) => fn(conn), PublicKey: PK, wallet: "WAL", positionAddress: "POS", baseMint: M });
  // wallet arg differs from the tx owner here, so deltas are zero — the point is which txs were read
  assert.equal(f.unreadable, 0);
  assert.equal(f.last_position_tx_time, 401);
}

// Queue + record helpers.
const { recordPerformance, recordCloseAudit, getCloseAuditQueue } = await import("../lessons.js");
const { initAllDocStores } = await import("../db/doc-store.js");
await initAllDocStores?.();
const P = "AUDIT_TEST_" + Date.now();
await recordPerformance({ position: P, pool: "POOL_A", pool_name: "AUD-SOL", base_mint: M, strategy: "spot", amount_sol: 0.5,
  pnl_sol: 0.01, initial_value_usd: 0.5, final_value_usd: 0.5, fees_earned_usd: 0.01, minutes_held: 30, minutes_in_range: 30, close_reason: "test",
  recorded_at: new Date(Date.now() - 20 * 60_000).toISOString() });
assert.ok(getCloseAuditQueue({ limit: 50 }).some((r) => r.position === P));
recordCloseAudit(P, { status: "incomplete", retry: true, attempts: 1 }, { force: true });
assert.ok(getCloseAuditQueue({ limit: 50 }).some((r) => r.position === P));            // retried
recordCloseAudit(P, { status: "ok", attempts: 2 }, { force: true });
assert.ok(!getCloseAuditQueue({ limit: 50 }).some((r) => r.position === P));           // done
assert.equal(recordCloseAudit(P, { status: "mismatch" }).status, "ok");                // not overwritten without force
// A verdict from an older audit version is re-queued.
assert.ok(getCloseAuditQueue({ limit: 50, version: 3 }).some((r) => r.position === P));
recordCloseAudit(P, { status: "ok", attempts: 1, version: 3 }, { force: true });
assert.ok(!getCloseAuditQueue({ limit: 50, version: 3 }).some((r) => r.position === P));

console.log("✅ close audit verified");
process.exit(0);
