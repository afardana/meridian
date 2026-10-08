process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Close audit v6: the UI zap bundle, sibling positions, the residual price ===");

const { walletDeltas, summarizeFlows, evaluateCloseAudit, isRepeatVerdict, CLOSE_AUDIT_VERSION } = await import("../close-audit.js");
const { applyWalletNet } = await import("../lessons.js");

// Real transactions, read on chain 2026-10-07 and trimmed to the wallet and its own token
// accounts of the base mint and of wSOL (scripts: session scratchpad zapdump.mjs). The wallet
// lists are newest-first, as fetchCloseFlows collects them.
const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/close-audit-zap.json", import.meta.url), "utf8"));
const W = "WALLET", M = "MINT";
const flowsOf = (k, patch = (x) => x) => {
  const f = summarizeFlows(patch({ posTxs: FX[k].posTxs, walletTxs: FX[k].walletTxs, wallet: W, baseMint: M }));
  f.wallet_history_complete = true;
  return f;
};
const near = (a, b, eps = 2e-6) => Math.abs(a - b) <= eps;
assert.equal(CLOSE_AUDIT_VERSION, 8);

// CRAWL-SOL CGx8fxL8 — operator position opened two-sided in the Meteora UI.
{
  const fx = FX.CGx8fxL8;
  // The four-transaction bundle, one slot: wSOL account opened, RebalanceLiquidity pays the
  // SOL out as wSOL, Jupiter spends wSOL for the token, the zap deposits both.
  const bySig = (s) => [...fx.posTxs, ...fx.walletTxs].find((t) => t.sig === s);
  const open = walletDeltas(bySig("5Z6acx3B"), W, M), out = walletDeltas(bySig("5dDdfiAp"), W, M);
  const buy = walletDeltas(bySig("wti9arnG"), W, M), zap = walletDeltas(bySig("5Ha9k3We"), W, M);
  assert.ok(near(buy.dSol, -0.000005) && near(buy.dWsolSol, -0.81308), "the swap's native change is its fee; the cost is the wSOL it spent");
  assert.ok(near(buy.dSolEq, -0.813085));
  assert.ok(near(out.dSolEq, 1.752249) && near(zap.dSolEq, -0.939177, 5e-6));
  // The wSOL legs cancel over the bundle: SOL-equivalent total == native total.
  const eq = open.dSolEq + out.dSolEq + buy.dSolEq + zap.dSolEq, native = open.dSol + out.dSol + buy.dSol + zap.dSol;
  assert.ok(near(eq, native, 1e-9), `bundle: ${eq} vs native ${native}`);
  assert.ok(near(native, -0.000065, 5e-6));

  const f = flowsOf("CGx8fxL8");
  assert.ok(near(f.matched_bought_tokens, 33755.232935, 1e-3));
  assert.equal(f.wallet_bought_tokens, 0);
  assert.equal(f.sibling_position_ops, 0);
  assert.ok(Math.abs(f.net_tokens) < 1e-6);
  // v5 read ◎0.201703: it counted the wSOL account's opening as 0 (account-only rule) and its
  // refund inside the zap as income. The wallet's real net is ◎0.001538 lower.
  assert.ok(near(f.net_sol, 0.200165), `net ${f.net_sol}`);
  // the last real swap is the exit swap (◎0.595229 for 23,492.10), not the fee-only zap buy
  assert.ok(near(f.last_swap_sol_per_token, 0.595229 / 23492.1, 1e-9));
  const rec = { pnl_sol_net: 0.22309, amount_sol: 1.7523, deposit_sol_true: 1.7523, straddle_count: 0, recorded_at: "2026-10-07T07:33:20.715Z", chain_audit: {} };
  const v = evaluateCloseAudit(rec, f);
  assert.equal(v.status, "ok");
  assert.ok(near(v.diff_sol, 0.022925) && near(v.tolerance_sol, 0.026285));
  rec.chain_audit = v;
  assert.equal(applyWalletNet(rec, v), true);
  assert.deepEqual([rec.pnl_sol_net, rec.pnl_sol_net_modelled, rec.pnl_sol_net_source], [0.200165, 0.22309, "wallet"]);
  console.log("ok — CRAWL CGx8fxL8: zap purchase matched, wSOL legs cancel, verdict ok, wallet figure applied");
}

// swordcat-SOL CmZiNAqG — a BOT position the operator re-ranged with the UI Rebalance 196 min in.
{
  const f = flowsOf("CmZiNAqG");
  assert.ok(near(f.matched_bought_tokens, 32442.37896, 1e-3));   // the zap deposited 32,436.10 (99.98 %)
  assert.equal(f.wallet_bought_tokens, 0);
  assert.equal(f.sibling_position_ops, 0);
  assert.ok(near(f.net_sol, 0.050681));
  const v = evaluateCloseAudit({ pnl_sol_net: 0.064711, amount_sol: 1.56, straddle_count: 0, recorded_at: "2026-10-07T02:03:26.514Z" }, f);
  assert.deepEqual([v.status, v.diff_sol], ["ok", 0.01403]);
  console.log("ok — swordcat CmZiNAqG: bot position re-ranged by the operator, matched");
}

// swordcat-SOL Hj7nyXJC — 5.48 tokens left over from the zap, sold two hours later.
{
  const f = flowsOf("Hj7nyXJC");
  assert.ok(near(f.matched_bought_tokens, 27104.434621, 1e-3));
  assert.equal(f.wallet_bought_tokens, 0);
  assert.ok(Math.abs(f.net_tokens) < 1e-6);
  const v = evaluateCloseAudit({ pnl_sol_net: 0.028352, amount_sol: 1.0321, straddle_count: 0, recorded_at: "2026-10-07T11:19:17.066Z" }, f);
  assert.equal(v.status, "ok");
  assert.ok(near(v.net_sol, 0.014376) && near(v.tolerance_sol, 0.015482));
  console.log("ok — swordcat Hj7nyXJC: zap leftover sold later, still nets out");
}

// DUST-SOL 9Zy1Fn — NOT hand trading: its own zap, a sibling's zap, and the bot's swaps after
// three sibling positions' claims and closes.
{
  const f = flowsOf("9Zy1FnJ9");
  assert.ok(f.sibling_position_ops >= 5, `sibling ops ${f.sibling_position_ops}`);
  assert.ok(near(f.matched_bought_tokens, 114914.34, 1));         // its own zap
  assert.ok(near(f.wallet_bought_tokens, 188175.53, 1));          // the sibling Av3uVR's zap
  // residual price: the exit swap (◎0.019605 for 287,825.58), whatever order the list is in
  assert.ok(near(f.last_swap_sol_per_token, 6.811e-8, 1e-10), `px ${f.last_swap_sol_per_token}`);
  const rec = { pnl_sol_net: -1.902911, amount_sol: 2, deposit_sol_true: 2, straddle_count: 0, recorded_at: "2026-10-06T02:21:35.977Z", chain_audit: {} };
  const v = evaluateCloseAudit(rec, f);
  assert.deepEqual([v.status, v.why], ["incomplete", "another position in this token overlapped"]);
  assert.equal(applyWalletNet(rec, v), false);
  assert.equal(rec.pnl_sol_net, -1.902911);
  // Even without the sibling rule it is no longer a MISMATCH: the 432,913-token remainder is
  // worth ◎0.029 at the real last price (v5 priced it with the zap's fee-only swap, ≈ 4e-11).
  const noSibling = evaluateCloseAudit({ ...rec, straddle_count: 1 }, { ...f, sibling_position_ops: 0 });
  assert.deepEqual([noSibling.status, noSibling.why], ["incomplete", "token flows do not net to zero"]);
  assert.ok(near(noSibling.residual_sol, 0.029487, 5e-5));
  console.log("ok — DUST 9Zy1Fn: sibling overlap → incomplete, and never a mismatch");
}

// The same flows in any order give the same summary (the live list is newest-first).
{
  const a = flowsOf("9Zy1FnJ9"), b = flowsOf("9Zy1FnJ9", (x) => ({ ...x, posTxs: [...x.posTxs].reverse(), walletTxs: [...x.walletTxs].reverse() }));
  assert.equal(a.last_swap_sol_per_token, b.last_swap_sol_per_token);
  assert.equal(a.wallet_bought_tokens, b.wallet_bought_tokens);
  assert.ok(near(a.net_sol, b.net_sol, 1e-9));
  const c = flowsOf("CGx8fxL8", (x) => ({ ...x, walletTxs: [...x.walletTxs].reverse() }));
  assert.ok(near(c.last_swap_sol_per_token, 0.595229 / 23492.1, 1e-9));
  console.log("ok — wallet transactions are processed in chain order");
}

// HIGGS-SOL 4eXkXhyo — a sibling (hU51UdLM) closed 49 minutes into its life.
{
  const v = evaluateCloseAudit({ pnl_sol_net: 0.168982, amount_sol: 0.9901, straddle_count: 0, recorded_at: "2026-10-06T14:04:47.267Z" }, flowsOf("4eXkXhyo"));
  assert.deepEqual([v.status, v.why], ["incomplete", "another position in this token overlapped"]);
}

// Synthetic cases on the same shapes.
const mk = ({ t, slot = t, sol = 0, tok = 0, touch = true, ops = [] }) => ({
  blockTime: t, slot,
  transaction: { message: { accountKeys: [W, "ATA"] } },
  meta: {
    err: null, preBalances: [10e9, 2039280], postBalances: [10e9 + Math.round(sol * 1e9), 2039280],
    preTokenBalances: touch ? [{ accountIndex: 1, owner: W, mint: M, uiTokenAmount: { uiAmountString: String(tok < 0 ? -tok : 0) } }] : [],
    postTokenBalances: touch ? [{ accountIndex: 1, owner: W, mint: M, uiTokenAmount: { uiAmountString: String(tok > 0 ? tok : 0) } }] : [],
    logMessages: ops.map((o) => `Program log: Instruction: ${o}`),
  },
});
const base = [mk({ t: 100, sol: -1.04, ops: ["InitializePosition", "AddLiquidityByStrategy2"] }), mk({ t: 4000, sol: 0.6, tok: 20000, ops: ["RemoveLiquidityByRange2", "ClosePositionIfEmpty"] })];
const exit = mk({ t: 4010, sol: 0.45, tok: -20000 });
const R = { pnl_sol_net: 0.01, amount_sol: 1, straddle_count: 0, recorded_at: new Date(4005e3).toISOString() };

// A genuine outside trade: bought at t=1000, nothing deposited, sold at t=2000.
{
  const f = summarizeFlows({ posTxs: base, walletTxs: [exit, mk({ t: 2000, sol: 0.33, tok: -9000 }), mk({ t: 1000, sol: -0.3, tok: 9000 })], wallet: W, baseMint: M });
  assert.deepEqual([f.wallet_bought_tokens, f.matched_bought_tokens, f.sibling_position_ops], [9000, 0, 0]);
  const v = evaluateCloseAudit(R, f);
  assert.equal(v.status, "incomplete");
  assert.match(v.why, /acquired this token without depositing it into this position/);
  // A straddled record is judged as before (its buy is the position's own, even when unwound).
  const s = evaluateCloseAudit({ ...R, straddle_count: 1 }, f);
  assert.ok(s.status === "ok" || s.status === "mismatch");
  assert.equal(evaluateCloseAudit({ ...R, lane: "straddle" }, f).status, s.status);
  console.log("ok — an unmatched purchase is an outside trade (incomplete); a straddle is still judged");
}

// Matching limits: the deposit must come AFTER the purchase, within 60 s, and cover 90 %.
{
  const dep = (t, tok) => mk({ t, sol: -0.000005, tok: -tok, ops: ["RebalanceLiquidity"] });
  const buy = (t, tok) => mk({ t, sol: -0.3, tok });
  const run = (posExtra, walExtra) => summarizeFlows({ posTxs: [...base, ...posExtra], walletTxs: [exit, ...walExtra], wallet: W, baseMint: M });
  assert.equal(run([dep(1060, 9000)], [buy(1000, 9000)]).wallet_bought_tokens, 0);        // 60 s: matched
  assert.equal(run([dep(1061, 9000)], [buy(1000, 9000)]).wallet_bought_tokens, 9000);     // 61 s: not
  assert.equal(run([dep(990, 9000)], [buy(1000, 9000)]).wallet_bought_tokens, 9000);      // deposit before the buy
  assert.equal(run([dep(1005, 8100)], [buy(1000, 9000)]).wallet_bought_tokens, 0);        // 90 %
  assert.equal(run([dep(1005, 8000)], [buy(1000, 9000)]).wallet_bought_tokens, 9000);     // 88.9 %
  // one deposit cannot vouch for two purchases
  const two = run([dep(1005, 9000)], [buy(1000, 9000), buy(1001, 9000)]);
  assert.deepEqual([two.matched_bought_tokens, two.wallet_bought_tokens], [9000, 9000]);
  console.log("ok — buy-to-deposit matching: after the buy, ≤ 60 s, ≥ 90 %, each deposit used once");
}

// Siblings: only a position operation that MOVES the token while this position is alive counts.
{
  const sib = (t, tok, ops) => mk({ t, sol: 0.02, tok, ops });
  const run = (w) => summarizeFlows({ posTxs: base, walletTxs: [exit, ...w], wallet: W, baseMint: M });
  assert.equal(run([sib(2000, 500, ["ClaimFee2"])]).sibling_position_ops, 1);
  assert.equal(run([sib(2000, 0, ["InitializePosition", "AddLiquidityByStrategy2"])]).sibling_position_ops, 0);   // SOL-only deploy
  assert.equal(run([sib(4100, 500, ["ClaimFee2"])]).sibling_position_ops, 0);                                     // after the close (tail window)
  assert.equal(run([mk({ t: 4120, sol: -0.44, ops: ["InitializePosition", "AddLiquidityByStrategy2"] })]).sibling_position_ops, 0); // redeploy
  const v = evaluateCloseAudit({ ...R, straddle_count: 1 }, run([sib(2000, 500, ["ClaimFee2"]), mk({ t: 2002, sol: 0.011, tok: -500 })]));
  assert.deepEqual([v.status, v.why], ["incomplete", "another position in this token overlapped"]);   // straddled or not
  // and a sibling-free close with a redeploy in the tail is judged normally
  assert.equal(evaluateCloseAudit(R, run([mk({ t: 4120, sol: -0.44, ops: ["InitializePosition", "AddLiquidityByStrategy2"] })])).status, "ok");
  console.log("ok — sibling detection: token-moving position operations inside the position's life only");
}

// Residual price ignores fee-only swaps.
{
  const feeOnly = mk({ t: 4020, sol: -0.000005, tok: 100 });   // a wSOL-funded buy seen without its wSOL leg
  const f = summarizeFlows({ posTxs: base, walletTxs: [feeOnly, exit], wallet: W, baseMint: M });
  assert.ok(near(f.last_swap_sol_per_token, 0.45 / 20000, 1e-12));
}

// ── v7: the tail after the last position transaction ────────────────────────────────────────
// TWEETCRAFT-SOL Ebt68po9 — bot position, straddled in place, stop loss at 20:52:09; exit swap
// 4 s later; the operator's NEXT position (CdhP9iz9) was created at 20:53:40 and zapped at
// 20:54:08, inside the 180 s tail.
{
  const f = flowsOf("Ebt68po9");
  assert.equal(f.tail_excluded, 4);                               // the foreign bundle's slot
  assert.ok(f.tail_cutoff_time > f.last_position_tx_time);
  assert.ok(near(f.matched_bought_tokens, 26829.05, 1e-2));       // the straddle's own buy, 17 s before stage C
  assert.equal(f.wallet_bought_tokens, 0);                        // v6 counted the next position's 27,113.66 here
  assert.ok(Math.abs(f.net_tokens) < 1e-6);
  assert.ok(near(f.net_sol, -0.243019), `net ${f.net_sol}`);     // v6: −0.719794
  const rec = { pnl_sol_net: -0.22954, amount_sol: 1.38, deposit_sol_true: 1.38, straddle_count: 1, lane: "straddle", recorded_at: "2026-10-07T13:52:13.193Z", chain_audit: {} };
  const v = evaluateCloseAudit(rec, f);
  assert.deepEqual([v.status, v.diff_sol, v.tolerance_sol], ["ok", 0.013479, 0.0207]);
  rec.chain_audit = v;
  assert.equal(applyWalletNet(rec, v), true);
  assert.equal(rec.pnl_sol_net, -0.243019);
  console.log("ok — TWEETCRAFT Ebt68po9: the next position's zap in the tail is not counted (wallet −0.243019, ok)");
}
{
  const close = 4000, T = (dt) => close + dt;
  const run = (w, rec = R) => { const f = summarizeFlows({ posTxs: base, walletTxs: w, wallet: W, baseMint: M }); return [f, evaluateCloseAudit(rec, f)]; };
  const withWsol = (t, { sol, tok = 0, wsol, ops = [] }) => {
    const x = mk({ t, sol, tok, ops });
    x.transaction.message.accountKeys.push("WSOL_ATA");
    x.meta.preBalances.push(wsol < 0 ? Math.round(-wsol * 1e9) : 0); x.meta.postBalances.push(wsol > 0 ? Math.round(wsol * 1e9) : 0);
    const tb = { accountIndex: 2, owner: W, mint: "So11111111111111111111111111111111111111112", uiTokenAmount: { uiAmountString: "0" } };
    x.meta.preTokenBalances.push(tb); x.meta.postTokenBalances.push(tb);
    return x;
  };
  // a foreign UI position 100 s after the exit swap: SOL-only create, then the zap bundle in one slot
  const foreign = [
    mk({ t: T(100), sol: -1.146, ops: ["InitializePosition", "AddLiquidityByStrategy2"] }),
    withWsol(T(128), { sol: -0.001503, wsol: 0.001488 }),
    withWsol(T(128), { sol: -0.000005, wsol: 1.0787, ops: ["RebalanceLiquidity"] }),
    withWsol(T(128), { sol: -0.000005, tok: 27113, wsol: -0.4768 }),
    withWsol(T(128), { sol: 0.001483, tok: -27113, wsol: -0.6035, ops: ["ZapInDlmmForInitializedPosition", "RebalanceLiquidity"] }),
  ];
  const clean = run([exit])[0];
  const [f1, v1] = run([exit, ...foreign]);
  assert.ok(near(f1.net_sol, clean.net_sol, 1e-9) && f1.tail_excluded === 4 && f1.wallet_bought_tokens === 0);
  assert.equal(v1.status, "ok");
  // each sign on its own cuts: the wSOL opening, the purchase, a token-moving position operation
  for (const one of [foreign[1], foreign[3], foreign[4], mk({ t: T(60), sol: 0.01, tok: 300, ops: ["ClaimFee2"] })]) {
    const [f] = run([exit, one, mk({ t: T(150), sol: 0.2, tok: -300 })]);
    assert.ok(near(f.net_sol, clean.net_sol, 1e-9), "nothing after the foreign sign is counted");
    assert.equal(f.tail_excluded, 2);
  }
  // a straddled record does not let a tail purchase through either
  assert.equal(run([exit, foreign[3]], { ...R, straddle_count: 1 })[0].wallet_bought_tokens, 0);
  // the bot's SOL-only redeploy into the same pool: ignored, and what follows is still counted
  const redeploy = mk({ t: T(60), sol: -0.44, ops: ["InitializePosition", "AddLiquidityByStrategy2"] });
  const half = mk({ t: T(10), sol: 0.25, tok: -11000 }), rest = mk({ t: T(150), sol: 0.2, tok: -9000 });
  const [f2, v2] = run([half, redeploy, rest]);
  assert.deepEqual([f2.tail_cutoff_time, f2.tail_excluded], [null, 0]);
  assert.ok(near(f2.net_sol, -1.04 + 0.6 + 0.45, 1e-9) && Math.abs(f2.net_tokens) < 1e-9);
  assert.equal(v2.status, "ok");
  // a deferred second sale of the remainder with no foreign activity: counted
  const [f3, v3] = run([half, rest]);
  assert.ok(near(f3.net_sol, 0.01, 1e-9) && v3.status === "ok");
  // the remainder not sold before the next position starts: no verdict, and the reason says so
  const [f4, v4] = run([half, ...foreign, rest]);
  assert.ok(near(f4.net_tokens, 9000, 1e-9) && f4.tail_excluded === 5);
  assert.deepEqual([v4.status, v4.why], ["incomplete", "another position in this token started before this one's remainder was sold"]);
  assert.ok(near(v4.residual_sol, 9000 * (0.25 / 11000), 1e-6));
  // DURING the position's life nothing changes: a foreign token-moving operation is a sibling
  assert.equal(run([exit, mk({ t: 2000, sol: 0.01, tok: 300, ops: ["ClaimFee2"] })])[0].tail_excluded, 0);
  console.log("ok — tail: counting stops at a later position's first sign; redeploys and deferred sales unaffected");
}

// ── v8: never-filled ladders — rent parked in the still-open token account, unpriced dust ────
// A single-sided SOL ladder the price never entered: the deploy opens the wallet's token
// account (rent), the close hands back the SOL and a few fee tokens, nothing is swapped and
// the account stays open. v7: "token flows do not net to zero", wallet ≈ −◎0.0015.
{
  const cases = [
    // key, booked, capital, recorded_at, tokens left, rent, wallet figure, diff
    ["J4oFb2LY", 0.000067, 0.48, "2026-10-08T13:06:09.212Z", 0.981111, 0.001514, -0.000008, 0.000075],   // baton, low yield
    ["3B3hSsZo", 0.000584, 0.25, "2026-10-08T09:12:50.765Z", 26.309682, 0.001488, 0.000208, 0.000376],   // BORDR, unfilled-above
    ["CrSMyq9u", 0.000575, 1.25, "2026-10-08T04:09:47.810Z", 19.192906, 0.001514, 0.000106, 0.000469],   // swordcat, unfilled-above
    // baton DPcMPkka: the account was closed by a sweep mid-life and re-opened by the close
    ["DPcMPkka", -0.000072, 0.25, "2026-10-06T15:48:21.232Z", 0.655476, 0.001514, -0.00013, 0.000058],
  ];
  for (const [k, booked, cap, at, left, rent, net, diff] of cases) {
    const f = flowsOf(k);
    assert.ok(near(f.open_account_rent_sol, rent), `${k} rent ${f.open_account_rent_sol}`);
    assert.equal(f.last_swap_sol_per_token, null);
    assert.ok(near(f.net_tokens, left));
    const rec = { pnl_sol_net: booked, amount_sol: cap, deposit_sol_true: cap, straddle_count: 0, recorded_at: at, chain_audit: {} };
    const v = evaluateCloseAudit(rec, f);
    assert.deepEqual([v.status, v.dust_residual, v.net_sol, v.diff_sol, v.open_account_rent_sol], ["ok", true, net, diff, rent], `${k}: ${JSON.stringify(v)}`);
    assert.ok(near(f.net_sol + rent, net, 1e-6));                  // summarizeFlows keeps the raw wallet sum
    rec.chain_audit = v;
    assert.equal(applyWalletNet(rec, v), true);
    assert.equal(rec.pnl_sol_net, net);
  }
  console.log("ok — never-filled ladders (baton J4oFb2LY, BORDR 3B3hSsZo, swordcat CrSMyq9u, baton DPcMPkka): rent set aside, dust, verdict ok");
}
{
  const ATA = 0.00151384;
  const withAcct = (x, pre, post) => { x.meta.preBalances[1] = Math.round(pre * 1e9); x.meta.postBalances[1] = Math.round(post * 1e9); return x; };
  const deploy = () => withAcct(mk({ t: 100, sol: -(1 + 0.0419 + ATA + 0.00001), ops: ["InitializePosition", "AddLiquidityByStrategy2"] }), 0, ATA);
  const close = (sol, tok) => withAcct(mk({ t: 4000, sol, tok, ops: ["RemoveLiquidityByRange2", "ClaimFee2", "ClosePositionIfEmpty"] }), ATA, ATA);
  const acctClose = withAcct(mk({ t: 4020, sol: ATA - 0.000005, ops: [] }), ATA, 0);
  acctClose.meta.postTokenBalances = [];
  const rec = (booked) => ({ pnl_sol_net: booked, amount_sol: 1, straddle_count: 0, recorded_at: new Date(4005e3).toISOString() });
  const run = (pos, wal, booked) => { const f = summarizeFlows({ posTxs: pos, walletTxs: wal, wallet: W, baseMint: M }); return [f, evaluateCloseAudit(rec(booked), f)]; };

  // never filled, the account closed inside the window: nothing set aside, judged as before
  const [f1, v1] = run([deploy(), close(1.0419, 0)], [acctClose], 0.0001);
  assert.equal(f1.open_account_rent_sol, 0);
  assert.deepEqual([v1.status, v1.open_account_rent_sol, v1.dust_residual], ["ok", undefined, undefined]);
  assert.ok(near(v1.net_sol, -0.00001, 1e-6));
  // never filled, account left open with 12 fee tokens: rent set aside, dust
  const [f2, v2] = run([deploy(), close(1.0419, 12)], [], 0.0003);
  assert.ok(near(f2.open_account_rent_sol, ATA, 1e-9) && near(f2.net_sol, -ATA - 0.00001, 1e-9));
  assert.deepEqual([v2.status, v2.dust_residual, v2.net_sol], ["ok", true, -0.00001]);
  // a FILLED position whose remainder was not sold: the record counts ◎0.4 of tokens the wallet
  // never turned into SOL — rent is still set aside, but there is no verdict
  const [, v3] = run([deploy(), close(0.6419, 20000)], [], 0.0002);
  assert.deepEqual([v3.status, v3.why], ["incomplete", "token flows do not net to zero"]);
  assert.ok(near(v3.net_sol, -0.40001, 1e-6) && v3.open_account_rent_sol === 0.001514);
  // just over the dust floor (max(◎0.0005, 0.1 % of capital) = ◎0.001 here): not dust
  assert.equal(run([deploy(), close(1.0419, 12)], [], 0.0012)[1].status, "incomplete");
  assert.equal(run([deploy(), close(1.0419, 12)], [], 0.0009)[1].status, "ok");
  // with a swap in the window the remainder is priced as before (v7 thresholds), dust or not
  const part = mk({ t: 4010, sol: 0.39, tok: -19500 });
  const [f5, v5] = run([deploy(), close(0.6419, 20000)], [part], -0.0101);
  assert.ok(near(f5.last_swap_sol_per_token, 0.39 / 19500, 1e-12));
  assert.deepEqual([v5.status, v5.dust_residual], ["incomplete", undefined]);       // 500 left ≈ ◎0.01 > max(0.002, 0.5 %)
  const [, v6] = run([deploy(), close(0.6419, 20000)], [mk({ t: 4010, sol: 0.3999, tok: -19995 })], -0.0001);
  assert.deepEqual([v6.status, v6.dust_residual], ["ok", undefined]);               // 5 left ≈ ◎0.0001
  // tokens the wallet is SHORT (sold more than the position paid out) are never dust
  assert.equal(evaluateCloseAudit(rec(0.0001), { ...f2, net_tokens: -12 }).status, "incomplete");
  // rent of an account that existed before (released here) is not reported as open rent
  const pre = withAcct(mk({ t: 100, sol: -1.04191, ops: ["InitializePosition"] }), ATA, ATA);
  assert.equal(run([pre, close(1.0419, 0)], [acctClose], 0.0001)[0].open_account_rent_sol, 0);
  console.log("ok — open-account rent and dust: closed-in-window unchanged, genuine remainder still incomplete");
}
// A re-audit that reproduces the stored verdict to the figure sends no second alert.
{
  const stored = { status: "mismatch", net_sol: -0.002313, booked_sol: 0.009591, diff_sol: 0.011904, version: 7 };
  assert.equal(isRepeatVerdict(stored, { status: "mismatch", net_sol: -0.002313, booked_sol: 0.009591 }), true);
  assert.equal(isRepeatVerdict(stored, { status: "mismatch", net_sol: -0.003827, booked_sol: 0.009591 }), false);
  assert.equal(isRepeatVerdict(stored, { status: "ok", net_sol: -0.002313, booked_sol: 0.009591 }), false);
  assert.equal(isRepeatVerdict(null, { status: "mismatch", net_sol: 1, booked_sol: 1 }), false);
  assert.equal(isRepeatVerdict({ status: "pending" }, { status: "mismatch", net_sol: 1, booked_sol: 1 }), false);
}

console.log("✅ close audit v6–v8 verified");
process.exit(0);
