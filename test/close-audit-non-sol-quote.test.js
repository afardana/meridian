process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

// Close audit on a pool that is NOT SOL-quoted (2026-11-26). SOL-HYPE Hm6oyHv3 (operator,
// ◎0.9988, closed 2026-11-25 22:18 WIB): token X = wSOL, token Y = HYPE, so the record's
// base_mint is wSOL; the audit summed the wallet's wSOL account as "the base token", never saw
// the HYPE leg, read −◎0.66383 against a booked +◎0.000778 and sent a MISMATCH alert.
import { test } from "node:test";
import assert from "node:assert/strict";

const A = await import("../close-audit.js");
const G = await import("../close-audit-group.js");
const L = await import("../lessons.js");
const { initAllDocStores } = await import("../db/doc-store.js");
await initAllDocStores?.();

const WSOL = "So11111111111111111111111111111111111111112";
const HYPE = "98sMhvDwXj1RQi5c5Mndm3vPe9cBqPrbLaufMXFNMh5g";
const MEME = "MEMEmintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// The stored SOL-HYPE record, trimmed to what the audit reads.
const solHype = (extra = {}) => ({
  position: "Hm6oyHv3BASm1wpy6RWDqXQmrE2TyaAoP7rQwtB3A9mQ", pool: "6oQ9wVex4mKZti2GsGCfD8FWTMMC9PLQkztRU5cd6MK8",
  pool_name: "SOL-HYPE", base_mint: WSOL, adopted: true, amount_sol: 0.9988, deposit_sol_true: 0.9988,
  pnl_sol: 0.0009, pnl_sol_net: 0.000778, recorded_at: "2026-11-25T15:18:12.623Z",
  tx_window: { t0: 1795619236, t1: 1795619891 },
  asset_profile: { token_x_mint: WSOL, token_y_mint: HYPE, token_x_symbol: "SOL", token_y_symbol: "HYPE" },
  chain_audit: { status: "mismatch", applied: false, net_sol: -0.66383, booked_sol: 0.000778, version: A.CLOSE_AUDIT_VERSION, attempts: 1 },
  ...extra,
});
const memeSol = (extra = {}) => ({
  position: "MEMEpos1", pool_name: "MEME-SOL", base_mint: MEME, amount_sol: 0.5, pnl_sol_net: 0.01,
  recorded_at: "2026-11-25T10:00:00.000Z",
  asset_profile: { token_x_mint: MEME, token_y_mint: WSOL }, ...extra,
});

// Flows that would otherwise give a clean `ok` for a SOL-quoted record.
const flows = { net_sol: 0.01, net_tokens: 0, tx_count: 3, unreadable: 0, last_position_tx_time: Date.parse("2026-11-25T10:00:00Z") / 1000, wallet_history_complete: true };

test("predicate: SOL as base / token X, or a non-SOL quote mint → not SOL-quoted", () => {
  assert.equal(A.nonSolQuotedReason(solHype()), "pool is not SOL-quoted");
  assert.equal(A.nonSolQuotedReason({ base_mint: WSOL }), "pool is not SOL-quoted");          // no asset_profile (SOL-SOL 2026-08-30)
  assert.equal(A.nonSolQuotedReason({ base_mint: "SOL" }), "pool is not SOL-quoted");
  assert.equal(A.nonSolQuotedReason({ base_mint: MEME, asset_profile: { token_x_mint: MEME, token_y_mint: USDC } }), "pool is not SOL-quoted");
  assert.equal(A.nonSolQuotedReason({ base_mint: MEME, quote_mint: USDC }), "pool is not SOL-quoted");
  // SOL-quoted, or no quote information with a non-SOL base mint → audited as before
  assert.equal(A.nonSolQuotedReason(memeSol()), null);
  assert.equal(A.nonSolQuotedReason({ base_mint: MEME }), null);
  assert.equal(A.nonSolQuotedReason({ base_mint: MEME, asset_profile: {} }), null);
  assert.equal(A.nonSolQuotedReason(null), null);
  assert.equal(A.isSolMint(WSOL), true);
  assert.equal(A.isSolMint("native"), true);
  assert.equal(A.isSolMint(MEME), false);
});

test("non-SOL-quoted record → incomplete 'pool is not SOL-quoted', no retry, nothing applied", () => {
  const v = A.evaluateCloseAudit(solHype(), flows);
  assert.deepEqual(v, { status: "incomplete", why: "pool is not SOL-quoted", non_sol_quoted: true });
  assert.equal(v.retry, undefined);
  const rec = solHype({ chain_audit: { ...v } });
  assert.equal(L.applyWalletNet(rec, v), false);
  assert.equal(rec.pnl_sol_net, 0.000778);
  // the backfill stores it (counts as checked at the current version), never "keep"/"retry"
  assert.equal(A.backfillOutcome(null, A.nonSolQuotedVerdict(), 1), "store");
  assert.equal(A.backfillOutcome(null, A.nonSolQuotedVerdict(), 3), "store");
});

test("a normal SOL-quoted record is audited exactly as before", () => {
  assert.equal(A.evaluateCloseAudit(memeSol(), flows).status, "ok");
  assert.equal(A.evaluateCloseAudit({ ...memeSol(), asset_profile: undefined }, flows).status, "ok");
  assert.equal(A.evaluateCloseAudit(memeSol({ pnl_sol_net: 0.5 }), flows).status, "mismatch");
  assert.equal(A.backfillOutcome(null, { status: "no_data" }, 1), "keep");
});

test("group builder: a non-SOL-quoted record is never a member", () => {
  const t0 = 1795619236;
  const r = (position, extra) => ({
    position, pool_name: "X", amount_sol: 1, pnl_sol_net: 0, recorded_at: new Date((t0 + 700) * 1000).toISOString(),
    tx_window: { t0, t1: t0 + 600 }, chain_audit: { status: "incomplete", version: A.CLOSE_AUDIT_VERSION }, ...extra,
  });
  // two overlapping SOL-HYPE-style records (base wSOL) used to form a "wSOL" group
  const wsolGroups = G.buildCloseGroups([r("H1", { base_mint: WSOL }), r("H2", { base_mint: WSOL })]);
  assert.equal(wsolGroups.length, 0);
  // a MEME-USDC record overlapping two MEME-SOL records: the group keeps the SOL-quoted two only
  const groups = G.buildCloseGroups([
    r("S1", { base_mint: MEME, asset_profile: { token_y_mint: WSOL } }),
    r("S2", { base_mint: MEME }),
    r("U1", { base_mint: MEME, asset_profile: { token_x_mint: MEME, token_y_mint: USDC } }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members.map((x) => x.position).sort(), ["S1", "S2"]);
});

test("queues: a stored older verdict on a non-SOL-quoted record is taken once more, then never", async () => {
  const P = "NONSOL_" + Date.now();
  await L.recordPerformance({
    position: P, pool: "POOL_H", pool_name: "SOL-HYPE", base_mint: WSOL, strategy: "spot", amount_sol: 0.9988,
    pnl_sol: 0.0009, initial_value_usd: 1, final_value_usd: 1, fees_earned_usd: 0, minutes_held: 10, minutes_in_range: 10,
    close_reason: "manual close (dashboard)", recorded_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    asset_profile: { token_x_mint: WSOL, token_y_mint: HYPE },
  });
  const inQueue = () => L.getCloseAuditQueue({ limit: 50, version: A.CLOSE_AUDIT_VERSION }).some((r) => r.position === P);
  assert.ok(inQueue());                                                                  // never audited
  // the stored v10 mismatch (as on 2026-11-25) — a current-version verdict normally stays
  L.recordCloseAudit(P, { status: "mismatch", net_sol: -0.66383, booked_sol: 0.000778, attempts: 1, version: A.CLOSE_AUDIT_VERSION }, { force: true });
  assert.ok(inQueue());                                                                  // restamped once
  L.recordCloseAudit(P, { ...A.nonSolQuotedVerdict(), attempts: 1, version: A.CLOSE_AUDIT_VERSION }, { force: true });
  assert.ok(!inQueue());                                                                 // done for good

  // backfill (closeAuditReauditSince): an old stored mismatch is picked once, the restamp ends it
  const now = Date.parse("2026-12-10T00:00:00Z");
  const stale = solHype();
  const pick = (recs) => L.selectCloseAuditBackfill(recs, { since: "2026-11-01T00:00:00Z", version: A.CLOSE_AUDIT_VERSION, now, limit: 5 }).map((r) => r.position);
  assert.deepEqual(pick([stale]), [stale.position]);
  const restamped = solHype();
  L.stampCloseAuditBackfill(restamped, { ...A.nonSolQuotedVerdict(), attempts: 1, version: A.CLOSE_AUDIT_VERSION });
  assert.equal(restamped.chain_audit.status, "incomplete");
  assert.equal(restamped.chain_audit.non_sol_quoted, true);
  assert.equal(restamped.pnl_sol_net, 0.000778);
  assert.deepEqual(pick([restamped]), []);
  // a SOL-quoted record at the current version is still not taken
  assert.deepEqual(pick([memeSol({ recorded_at: "2026-11-20T00:00:00Z", chain_audit: { status: "mismatch", version: A.CLOSE_AUDIT_VERSION } })]), []);
});
