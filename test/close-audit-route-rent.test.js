process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

// 2026-11-25 accounting fixes (docs/research/2026-11-25-wallet-vs-modelled-gap.md):
//   A  close audit v10 — rent of route-token accounts a Jupiter swap opens is set aside
//   B  the exit swap's recorded `sol_received` is what landed, not Jupiter's reported output
//   C  the modelled net includes the exit swap's gas and a measured entry premium
console.log("=== Close audit v10 / landed swap output / modelled net components ===");

const A = await import("../close-audit.js");
const G = await import("../close-audit-group.js");
const { modelledNetComponents, modelledNetFields } = await import("../modelled-net.js");
const L = await import("../lessons.js");
const { initAllDocStores } = await import("../db/doc-store.js");
await initAllDocStores?.();

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/close-audit-route-rent.json", import.meta.url), "utf8"));
const W = FX.wallet;
const SOL = "So11111111111111111111111111111111111111112";
const near = (a, b, eps = 2e-6) => Math.abs(a - b) <= eps;
const flowsOf = (k) => {
  const p = FX.positions[k];
  const f = A.summarizeFlows({ posTxs: p.posTxs, walletTxs: p.walletTxs, wallet: W, baseMint: p.record.base_mint });
  f.wallet_history_complete = true;
  return f;
};
const txBy = (k, prefix) => [...FX.positions[k].posTxs, ...FX.positions[k].walletTxs].find((t) => t.signature.startsWith(prefix));

assert.equal(A.CLOSE_AUDIT_VERSION, 10);

// ── A. CHOO-SOL 8sLU39cp (bot SOL ladder, stop loss 2026-11-04). Its exit swap (51bPCSUH) routed
// through 3NZ9JM… and cbBTC and opened a wallet token account for each (2 × ◎0.00148844); the
// sweeper closed them later in transactions that never touch CHOO. v9 charged that rent to the
// position (wallet −0.078775 vs modelled −0.075449, diff 0.003326).
{
  const p = FX.positions["8sLU39cp"];
  const f = flowsOf("8sLU39cp");
  assert.ok(near(f.net_sol, -0.07877539, 1e-8), "raw wallet sum unchanged");
  assert.equal(f.route_account_rent_sol, 0.00297688);
  assert.equal(f.route_account_released_sol, 0);
  const v = A.evaluateCloseAudit(p.record, f);
  assert.equal(p.stored_v9.net_sol, -0.078775, "v9 stored figure");
  assert.deepEqual([v.status, v.net_sol, v.route_account_rent_sol], ["ok", -0.075799, 0.002977]);
  // what is left is Jupiter's 10 bps fee (◎0.000344, fix B) and the swap's gas (fix C)
  assert.ok(near(v.diff_sol, 0.00035, 1e-6), `diff ${v.diff_sol}`);
  console.log("ok — 8sLU39cp: route rent ◎0.002977 set aside, diff 0.003326 → 0.000350");
}

// DA7GcVVh / 6bpYS5AG (PUSSY-SOL, consecutive bot ladders): 2 route accounts (USDC, NVDAx), then
// 1 (NVDAx again — the sweeper had closed it in between; USDC was still open and reused).
{
  const a = flowsOf("DA7GcVVh"), b = flowsOf("6bpYS5AG");
  assert.equal(a.route_account_rent_sol, 0.003048);
  assert.equal(b.route_account_rent_sol, 0.00155956);
  const va = A.evaluateCloseAudit(FX.positions.DA7GcVVh.record, a), vb = A.evaluateCloseAudit(FX.positions["6bpYS5AG"].record, b);
  assert.deepEqual([va.status, va.net_sol, vb.status, vb.net_sol], ["ok", -0.002267, "ok", 0.004719]);
  assert.ok(near(FX.positions.DA7GcVVh.stored_v9.net_sol + 0.003048, va.net_sol, 1e-6));
  assert.ok(near(FX.positions["6bpYS5AG"].stored_v9.net_sol + 0.00155956, vb.net_sol, 1e-6));

  // ── group audit over the same transactions: the set-aside is applied once for the group and
  // the group wallet equals the sum of the two individual v10 figures.
  const members = [FX.positions.DA7GcVVh.record, FX.positions["6bpYS5AG"].record];
  const memberTxs = new Map(FX.group.members.map((m) => [m, FX.positions[m.slice(0, 8)].posTxs]));
  const flows = G.summarizeGroupFlows({ members, memberTxs, tokenTxs: FX.group.tokenTxs, wallet: W, baseMint: members[0].base_mint });
  assert.equal(flows.tx_count, 8, "each transaction once");
  assert.ok(near(flows.route_account_rent_sol, 0.003048 + 0.00155956, 1e-9));
  const grp = { id: "FZxHLUGi:test", mint: members[0].base_mint, members };
  const gv = G.evaluateGroupAudit(grp, { ...flows, history_complete: true });
  assert.equal(gv.status, "group_ok");
  assert.equal(gv.audit_version, 10);
  assert.ok(near(gv.wallet_sol, va.net_sol + vb.net_sol, 1e-6), `group ${gv.wallet_sol} vs Σ ${va.net_sol + vb.net_sol}`);
  assert.equal(gv.route_account_rent_sol, 0.004608);
  // a stored stamp keeps the field (the cached re-allocation path)
  const again = G.evaluateGroupAudit(grp, { stored: gv });
  assert.deepEqual([again.wallet_sol, again.route_account_rent_sol], [gv.wallet_sol, 0.004608]);
  console.log("ok — PUSSY group: wallet ◎0.002452 = Σ individual v10, route rent ◎0.004608 once");
}

// Unit sequences: a route account opened and closed inside the counted transactions nets 0; one
// opened in an account-only transaction is not counted (that transaction counts this mint's
// account alone); a release from an account open before the window is reported, not applied.
{
  const M = "MINT", R = "ROUTE", RMINT = "USDCmint", RENT = 1488440;
  const mk = ({ t, sol, tok = null, route = null, op = null }) => ({
    blockTime: t, slot: t,
    transaction: { message: { accountKeys: [W, "POS", "ATA", R] } },
    meta: {
      err: null,
      preBalances: [10e9, 0, 2039280, route ? route[0] : 0], postBalances: [10e9 + sol, 0, 2039280, route ? route[1] : 0],
      preTokenBalances: [...(tok ? [{ accountIndex: 2, owner: W, mint: M, uiTokenAmount: { uiAmountString: String(tok[0]) } }] : []), ...(route && route[0] > 0 ? [{ accountIndex: 3, owner: W, mint: RMINT, uiTokenAmount: { uiAmountString: "0" } }] : [])],
      postTokenBalances: [...(tok ? [{ accountIndex: 2, owner: W, mint: M, uiTokenAmount: { uiAmountString: String(tok[1]) } }] : []), ...(route && route[1] > 0 ? [{ accountIndex: 3, owner: W, mint: RMINT, uiTokenAmount: { uiAmountString: "0" } }] : [])],
      logMessages: op ? [`Program log: Instruction: ${op}`] : [],
    },
  });
  const pos = [mk({ t: 100, sol: -500_000_000, op: "AddLiquidityByStrategy2" }), mk({ t: 200, sol: 400_000_000, tok: [0, 1000], op: "RemoveLiquidityByRange2" })];
  // swap opens the route account, a later swap of the mint closes it: net 0
  const sell1 = mk({ t: 210, sol: 50_000_000 - RENT, tok: [1000, 500], route: [0, RENT] });
  const sell2 = mk({ t: 220, sol: 50_000_000 + RENT, tok: [500, 0], route: [RENT, 0] });
  let f = A.summarizeFlows({ posTxs: pos, walletTxs: [sell1, sell2], wallet: W, baseMint: M });
  assert.deepEqual([f.route_account_rent_sol, f.route_account_released_sol], [0, 0]);
  // only the opening swap counted: set aside
  f = A.summarizeFlows({ posTxs: pos, walletTxs: [sell1, mk({ t: 220, sol: 50_000_000, tok: [500, 0] })], wallet: W, baseMint: M });
  assert.deepEqual([f.route_account_rent_sol, f.route_account_released_sol], [0.00148844, 0]);
  // a release (account open before the window, closed by a counted swap): diagnostic only
  f = A.summarizeFlows({ posTxs: pos, walletTxs: [mk({ t: 210, sol: 100_000_000 + RENT, tok: [1000, 0], route: [RENT, 0] })], wallet: W, baseMint: M });
  assert.deepEqual([f.route_account_rent_sol, f.route_account_released_sol], [0, 0.00148844]);
  const v = A.evaluateCloseAudit({ pnl_sol_net: 0.00148844, amount_sol: 0.5, recorded_at: new Date(200_000).toISOString() }, { ...f, wallet_history_complete: true });
  assert.equal(v.route_account_released_sol, 0.001488);
  assert.ok(near(v.net_sol, f.net_sol, 1e-6), "the release is not taken out of net_sol");
  // an account-only transaction (no token of the mint moved) that also closes a route account
  // counts this mint's account only — as before v10
  const sweep = mk({ t: 230, sol: 2039280 + RENT, route: [RENT, 0] });
  sweep.meta.preTokenBalances.push({ accountIndex: 2, owner: W, mint: M, uiTokenAmount: { uiAmountString: "0" } });
  sweep.meta.postBalances[2] = 0;
  f = A.summarizeFlows({ posTxs: pos, walletTxs: [mk({ t: 210, sol: 100_000_000, tok: [1000, 0] }), sweep], wallet: W, baseMint: M });
  assert.deepEqual([f.route_account_rent_sol, f.route_account_released_sol, f.released_account_rent_sol], [0, 0, 0.00203928]);
  console.log("ok — open+close nets 0, account-only transactions untouched, a release is reported only");
}

// ── B. What landed: the swap transaction's own balances (native + wSOL + fee + parked rent).
{
  const s = A.swapLandedOutput(txBy("8sLU39cp", "51bPCSUH"), W, SOL);
  assert.deepEqual(s, { amount_raw: 343657264, fee_lamports: 5242, fee_paid_by_wallet: true, route_rent_lamports: 2976880 });
  const rec = FX.positions["8sLU39cp"].record.exit_swap.sol_received;
  assert.equal(rec, 0.344001, "recorded = Jupiter's outputAmountResult");
  assert.ok(near(1 - s.amount_raw / 1e9 / rec, 0.001, 0.00002), "0.100 % above what landed");
  const d = A.swapLandedOutput(txBy("BQHq8TyA", "2CPUQBv6"), W, "SOL");
  assert.equal(d.amount_raw, 940232468);
  assert.ok(near(FX.positions.BQHq8TyA.record.exit_swap.sol_received - 0.940232468, 0.000942, 1e-6));
  // a token output (the straddle's stage-B buy, 516G186h): the wallet's raw token change
  const buy = A.swapLandedOutput(txBy("BQHq8TyA", "516G186h"), W, FX.positions.BQHq8TyA.record.base_mint);
  assert.ok(buy.amount_raw > 0 && Number.isInteger(buy.amount_raw));
  assert.equal(A.swapLandedOutput({ meta: { err: { x: 1 } } }, W, SOL), null);
  assert.equal(A.swapLandedOutput(txBy("8sLU39cp", "51bPCSUH"), "SOMEONE_ELSE", SOL), null);
  console.log("ok — landed ◎0.343657 vs reported ◎0.344001 (8sLU39cp), ◎0.940232 vs ◎0.941174 (BQHq8TyA)");
}

// ── C. Modelled net components; the exit-swap amend with the landed figure.
{
  // 8sLU39cp as it would have been recorded: slippage against the pool reference on the landed
  // SOL, the swap's gas in the net. Its v10 wallet figure is −0.075799.
  const r0 = FX.positions["8sLU39cp"].record;
  const refValue = r0.exit_swap.sol_received + r0.exit_slippage_sol;          // tokens × pool price
  const rec = { pnl_sol: r0.pnl_sol, total_gas_sol: r0.total_gas_sol, entry_cost_sol: 0, entry_cost_source: "none", pnl_usd: -6 };
  L.applyExitSwapOutcome(rec, { sol_received: 0.343657264, sol_received_source: "tx_meta", sol_received_quoted: 0.344001, gas_sol: r0.exit_swap.gas_sol, tokens_swapped: 1, ref_price_sol: refValue, market_usd: 30.4, value_usd: 31.06 });
  assert.equal(rec.exit_swap.sol_received_source, "tx_meta");
  assert.equal(rec.exit_swap.sol_received_quoted, 0.344001);
  assert.ok(near(rec.exit_slippage_sol, r0.exit_slippage_sol + 0.000344, 1e-6));
  assert.deepEqual(Object.keys(rec.pnl_sol_net_components), ["gross", "gas", "exit_swap_gas", "exit_slippage", "entry_premium"]);
  assert.equal(rec.pnl_sol_net_components.exit_swap_gas, 0.000005);
  assert.ok(near(rec.pnl_sol_net, -0.075799, 2e-6), `modelled ${rec.pnl_sol_net} vs wallet −0.075799`);
  // the old formula on the same record would have read −0.075449 (as stored)
  assert.ok(near(r0.pnl_sol_net_modelled, -0.075449, 1e-6));

  // Diamond-SOL BQHq8TyA (straddled; stage-B premium ◎0.010107 measured as "straddle").
  const d = FX.positions.BQHq8TyA.record;
  const dref = d.exit_swap.sol_received + d.exit_slippage_sol;
  const drec = { pnl_sol: d.pnl_sol, total_gas_sol: d.total_gas_sol, entry_cost_sol: d.entry_cost_sol, entry_cost_source: d.entry_cost_source };
  L.applyExitSwapOutcome(drec, { sol_received: 0.940232468, sol_received_source: "tx_meta", gas_sol: d.exit_swap.gas_sol, tokens_swapped: 1, ref_price_sol: dref });
  assert.equal(drec.pnl_sol_net_components.entry_premium, 0.010107);
  const wallet = A.evaluateCloseAudit(d, flowsOf("BQHq8TyA")).net_sol;                    // 0.13431 (no route account)
  assert.equal(wallet, 0.13431);
  assert.ok(near(d.pnl_sol_net_modelled, 0.145313, 1e-6), "stored modelled (old formula)");
  assert.ok(Math.abs(drec.pnl_sol_net - wallet) < 0.0001, `new modelled ${drec.pnl_sol_net} vs wallet ${wallet} (was 0.011003 apart)`);

  // premium only for measured / straddle sources; signed
  const base = { pnl_sol: 0.1, total_gas_sol: 0.001 };
  assert.equal(modelledNetComponents({ ...base, entry_cost_sol: 0.004, entry_cost_source: "measured" }).net, 0.095);
  assert.equal(modelledNetComponents({ ...base, entry_cost_sol: -0.004, entry_cost_source: "straddle" }).net, 0.103);
  for (const s of ["none", "unavailable", null, undefined]) assert.equal(modelledNetComponents({ ...base, entry_cost_sol: 0.004, entry_cost_source: s }).net, 0.099);
  assert.equal(modelledNetComponents({ pnl_sol: null }), null);
  assert.equal(modelledNetFields({ pnl_sol: "x" }), null);
  // gas_cost_sol fallback, as recordPerformance always did
  assert.equal(modelledNetComponents({ pnl_sol: 0.1, gas_cost_sol: 0.002 }).net, 0.098);

  // a record whose net is already the audited wallet figure keeps it; only the modelled moves
  const wrec = { pnl_sol: 0.1, total_gas_sol: 0.001, pnl_sol_net: 0.0912, pnl_sol_net_source: "wallet", pnl_sol_net_modelled: 0.099 };
  L.applyExitSwapOutcome(wrec, { sol_received: 0.2, gas_sol: 0.00001, tokens_swapped: 1, ref_price_sol: 0.201 });
  assert.equal(wrec.pnl_sol_net, 0.0912);
  assert.equal(wrec.pnl_sol_net_modelled, 0.09799);
  // no slippage computable (no reference, no feed): the swap's gas still lands in the net
  const nrec = { pnl_sol: 0.1, total_gas_sol: 0.001, pnl_sol_net: 0.099 };
  L.applyExitSwapOutcome(nrec, { sol_received: 0.2, gas_sol: 0.00001 });
  assert.equal(nrec.pnl_sol_net, 0.09899);
  assert.equal(nrec.exit_slippage_sol, undefined);
  console.log("ok — modelled net: 8sLU39cp −0.075799 (= wallet), BQHq8TyA within ◎0.0001 of the wallet (was ◎0.011)");
}

// recordPerformance composes the premium at the close (before any exit swap).
{
  const P = "ROUTE_RENT_TEST_" + Date.now();
  await L.recordPerformance({ position: P, pool: "POOL_R", pool_name: "RR-SOL", base_mint: "MINT", strategy: "spot", amount_sol: 0.5,
    pnl_sol: 0.02, total_gas_sol: 0.0002, entry_cost_sol: 0.003, entry_cost_source: "straddle",
    initial_value_usd: 0.5, final_value_usd: 0.52, fees_earned_usd: 0.0, minutes_held: 30, minutes_in_range: 30, close_reason: "test",
    recorded_at: new Date().toISOString() });
  const rec = L.getAllPerformance().find((r) => r.position === P);
  assert.equal(rec.pnl_sol_net, 0.0168);
  assert.deepEqual(rec.pnl_sol_net_components, { gross: 0.02, gas: 0.0002, exit_swap_gas: 0, exit_slippage: 0, entry_premium: 0.003 });
  assert.equal(L.recordExitSwapOutcome(P, { sol_received: 0.1, sol_received_source: "tx_meta", gas_sol: 0.00001, tokens_swapped: 1000, ref_price_sol: 0.000101 }), true);
  const after = L.getAllPerformance().find((r) => r.position === P);
  assert.equal(after.exit_slippage_sol, 0.001);
  assert.equal(after.pnl_sol_net, 0.01579);
  // the close audit compares against this figure; once applied it is kept as the modelled one
  after.chain_audit = { status: "ok", net_sol: 0.0158 };
  assert.equal(L.applyWalletNet(after, after.chain_audit), true);
  assert.deepEqual([after.pnl_sol_net, after.pnl_sol_net_modelled, after.pnl_sol_net_source], [0.0158, 0.01579, "wallet"]);
  console.log("ok — recordPerformance: entry premium in the net at the close; exit swap adds gas + slippage");
}

// The measured entry premium (net-cost.js findZapPurchases) leaves out route-account rent too, so
// the premium the modelled net subtracts and the wallet figure the audit sets rent aside from agree.
{
  const { findZapPurchases } = await import("../net-cost.js");
  const M = "MINT", RENT = 1488440;
  const keys = [W, "POS", "ATA", "ROUTE"];
  const buy = {
    blockTime: 100, slot: 100, transaction: { message: { accountKeys: keys } },
    meta: { err: null, preBalances: [10e9, 0, 2039280, 0], postBalances: [10e9 - 200_000_000 - RENT, 0, 2039280, RENT],
      preTokenBalances: [{ accountIndex: 2, owner: W, mint: M, uiTokenAmount: { uiAmountString: "0" } }],
      postTokenBalances: [{ accountIndex: 2, owner: W, mint: M, uiTokenAmount: { uiAmountString: "1000" } }, { accountIndex: 3, owner: W, mint: "USDCmint", uiTokenAmount: { uiAmountString: "0" } }],
      logMessages: ["Program log: Instruction: Route"] },
  };
  const dep = {
    blockTime: 100, slot: 100, transaction: { message: { accountKeys: keys } },
    meta: { err: null, preBalances: [10e9, 0, 2039280, 0], postBalances: [10e9, 0, 2039280, 0],
      preTokenBalances: [{ accountIndex: 2, owner: W, mint: M, uiTokenAmount: { uiAmountString: "1000" } }],
      postTokenBalances: [{ accountIndex: 2, owner: W, mint: M, uiTokenAmount: { uiAmountString: "0" } }],
      logMessages: ["Program log: Instruction: ZapInDlmmForInitializedPosition"] },
  };
  const [p] = findZapPurchases({ posTxs: [dep], walletTxs: [buy], wallet: W, baseMint: M });
  assert.ok(near(p.spent_sol, 0.2, 1e-9), `spent ${p.spent_sol} (rent ◎0.00148844 not included)`);
  console.log("ok — zap purchase: route-account rent is not part of the measured spend");
}

console.log("all route-rent / landed-output / modelled-net checks passed");
