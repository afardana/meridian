#!/usr/bin/env node
// One-off: correct the two stop-loss records booked on a phantom valuation after a
// failed in-place harvest straddle (stage A withdrew half the SOL, Meteora's
// allTimeWithdrawals lagged, pnl read ≈ −49 %, the stop loss closed, and the close
// fell back to that cached reading because the closed API had not settled).
//   ELON-SOL    CjEqJTdf… 2026-09-26 10:35Z  booked −48.20 % / −0.1928 SOL
//   tOpenAI-SOL 4eCK8Uh5… 2026-09-29 19:15Z  booked −49.20 % / −0.1968 SOL
// Settled Meteora closed-position PnL replaces the phantom; the failed straddle's
// buy + unwind round trip (wallet side, measured from the two swap txs) is folded
// into pnl_sol_net like exit slippage. Rewrites the lessons perf row (+ its derived
// FAILED lesson), the positions row and the pool-memory deploy.
// Run with the agent STOPPED (kv_store write-through race).
// Usage: node scripts/correct_phantom_stop_records.js [--apply]
import "../envcrypt.js";
import pg from "pg";

const apply = process.argv.includes("--apply");
const CORRECTIONS = [
  {
    position: "CjEqJTdfMmo49ZkKhMfpcmrcULhnrYpSY86BCphsbUBb", pool: "6DFDBDKKvYuVz8rSVg7a1zdhZKwZXG95CwH6uKwJUumq", name: "ELON-SOL",
    // swaps 4H4Jfeae… (−0.199560) / 2nBgthBP… (+0.195179)
    straddle_swap_loss_sol: 0.004381,
  },
  {
    position: "4eCK8Uh5Em1or2KxwKPNVS1wJnmmaUrPkqEdDyfPzGZg", pool: "Aw7S3Kh7BqX66dVYArjt2bWFnYzw6ZFNSuj5QReKqiBQ", name: "tOpenAI-SOL",
    // swaps 3FuSGDNu… (−0.201523) / WmiXKDyy… (+0.182041)
    straddle_swap_loss_sol: 0.019482,
    remove_lesson: "FAILED: tOpenAI-SOL",
  },
];

const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r2 = (v) => Math.round(v * 100) / 100;
const client = new pg.Client();
await client.connect();
const wallet = (await client.query("select value #>> '{}' as w from state_meta where key='walletAddress'")).rows[0].w;
const lessons = (await client.query("select doc from kv_store where key='lessons'")).rows[0].doc;
const poolMemory = (await client.query("select doc from kv_store where key='pool-memory'")).rows[0].doc;
const note = `Corrected ${new Date().toISOString().slice(0, 10)}: stop loss fired on a phantom valuation after a failed in-place straddle (unindexed stage-A withdrawal); PnL from Meteora's settled close + the straddle's swap round trip.`;

for (const c of CORRECTIONS) {
  const res = await fetch(`https://dlmm.datapi.meteora.ag/positions/${c.pool}/pnl?user=${wallet}&status=closed&pageSize=100&page=1`);
  const e = (await res.json()).positions?.find((p) => p.positionAddress === c.position);
  if (!e) { console.log(`${c.name}: closed record not found — skipped`); continue; }
  const posRow = (await client.query("select data from positions where position_address=$1", [c.position])).rows[0];
  const perf = [...(lessons.performance || [])].reverse().find((p) => p.position === c.position);
  if (!posRow || !perf) { console.log(`${c.name}: positions row or perf record missing — skipped`); continue; }
  const pos = posRow.data;
  const amountSol = Number(pos.amount_sol);
  const pnlSol = Number(e.pnlSol);
  const pnlUsdTrue = Number(e.pnlUsd);
  const feesSol = Number(e.allTimeFees?.total?.sol || 0);
  const feesUsd = Number(e.allTimeFees?.total?.usd || 0);
  const pnlPct = r2((pnlSol / amountSol) * 100);
  const gas = Number(perf.total_gas_sol ?? perf.gas_cost_sol ?? 0) || 0;
  const pnlSolNet = r6(pnlSol - gas - c.straddle_swap_loss_sol);
  const ticks = (await client.query(
    "select min(pnl_pct)::float as mae, max(pnl_pct)::float as mfe from price_ticks where position_address=$1 and source='poller' and pnl_pct > -40",
    [c.position])).rows[0];
  const initialUsd = Number(perf.initial_value_usd);

  const perfPatch = {
    pnl_pct: pnlPct, pnl_sol: r6(pnlSol), pnl_usd: r2(pnlUsdTrue), pnl_usd_true: r2(pnlUsdTrue),
    fees_sol_true: r6(feesSol), fees_usd_true: r2(feesUsd), fees_earned_usd: r2(feesUsd),
    final_value_usd: r2(initialUsd + pnlUsdTrue - feesUsd),
    pnl_sol_net: pnlSolNet, straddle_swap_loss_sol: c.straddle_swap_loss_sol,
    peak_pnl_pct: ticks.mfe, mfe_pnl_pct: ticks.mfe, mae_pnl_pct: ticks.mae,
    exit_family: "phantom_stop", valuation_error: true, corrected_at: new Date().toISOString(), correction_note: note,
  };
  const posPatch = {
    exit_pnl_pct: pnlPct, exit_pnl_sol: r6(pnlSol), exit_pnl_usd: r2(pnlUsdTrue), exit_pnl_true_usd: r2(pnlUsdTrue),
    peak_pnl_pct: ticks.mfe, mfe_pnl_pct: ticks.mfe, mae_pnl_pct: ticks.mae, pnl_tick_history: [],
    notes: [...(Array.isArray(pos.notes) ? pos.notes : []), note],
  };
  const pm = poolMemory[c.pool];
  const dep = pm?.deploys?.find((d) => Math.abs(new Date(d.closed_at) - new Date(perf.recorded_at)) < 120_000 && Number(d.pnl_pct) < -40);

  console.log(`\n${c.name} ${c.position.slice(0, 8)}  (Meteora: deposits ◎${Number(e.allTimeDeposits?.total?.sol).toFixed(4)} withdrawals ◎${Number(e.allTimeWithdrawals?.total?.sol).toFixed(4)} fees ◎${feesSol.toFixed(4)})`);
  console.log(`  perf:   pnl_pct ${perf.pnl_pct} → ${pnlPct}   pnl_sol ${perf.pnl_sol} → ${r6(pnlSol)}   pnl_sol_net ${perf.pnl_sol_net} → ${pnlSolNet}   family ${perf.exit_family} → phantom_stop   mae ${perf.mae_pnl_pct} → ${ticks.mae}`);
  console.log(`  pos:    exit_pnl_pct ${pos.exit_pnl_pct} → ${pnlPct}   exit_pnl_sol ${pos.exit_pnl_sol} → ${r6(pnlSol)}`);
  console.log(`  pool:   deploy ${dep ? `${dep.pnl_pct} → ${pnlPct}` : "NOT FOUND"}`);

  Object.assign(perf, perfPatch);
  Object.assign(pos, posPatch);
  if (dep) {
    Object.assign(dep, { pnl_pct: pnlPct, pnl_usd: r2(pnlUsdTrue), gas_adjusted_pnl_sol: pnlSolNet, fees_earned_sol: r6(feesSol), correction_note: note });
    const withPnl = pm.deploys.filter((d) => d.pnl_pct != null);
    pm.avg_pnl_pct = r2(withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length);
    pm.win_rate = r2(withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length);
    const last = pm.deploys[pm.deploys.length - 1];
    pm.last_outcome = (last.pnl_pct ?? 0) >= 0 ? "profit" : "loss";
    console.log(`          pool avg_pnl_pct → ${pm.avg_pnl_pct}  win_rate → ${pm.win_rate}  last_outcome → ${pm.last_outcome}`);
  }
  if (c.remove_lesson) {
    const before = lessons.lessons.length;
    lessons.lessons = lessons.lessons.filter((l) => !(String(l.rule).startsWith(c.remove_lesson) && /PnL -4\d\.\d+%/.test(String(l.rule))));
    console.log(`  lesson: removed ${before - lessons.lessons.length} phantom "${c.remove_lesson}" lesson(s)`);
  }
  if (apply) await client.query("update positions set data=$2, updated_at=now() where position_address=$1", [c.position, pos]);
}

if (apply) {
  await client.query("update kv_store set doc=$1, updated_at=now() where key='lessons'", [lessons]);
  await client.query("update kv_store set doc=$1, updated_at=now() where key='pool-memory'", [poolMemory]);
  console.log("\nwritten");
} else console.log("\n(dry run — pass --apply to write)");
await client.end();
