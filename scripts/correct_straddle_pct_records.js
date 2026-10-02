#!/usr/bin/env node
// One-off (2026-10-03): re-express the closed records of in-place-straddled positions on
// their capital. Every straddle runs RebalanceLiquidity twice (withdraw all + re-deposit)
// and Meteora counts each re-deposit in allTimeDeposits, so the recorded pnl_pct was the
// pnl over ~2.5× the capital (SAPLING-SOL 6oDW9432: +6.44 % recorded, +16.2 % real).
// The SOL pnl was right. Rewrites, per position: the lessons perf row (pnl_pct, the
// legacy initial/final value fields so final + fees − initial = pnl, deposit_sol_true),
// the positions row (exit_pnl_pct / exit_pnl_sol) and the pool-memory deploy (pnl_pct).
// A record booked from a pre-settle cache keeps its pnl_sol replaced by the settled one
// (pnl_sol_net moves by the same amount).
// Run with the agent STOPPED (kv_store write-through race).
// Usage: node scripts/correct_straddle_pct_records.js [--apply]
import "../envcrypt.js";
import pg from "pg";

const apply = process.argv.includes("--apply");
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r2 = (v) => Math.round(v * 100) / 100;
const client = new pg.Client();
await client.connect();
const wallet = (await client.query("select value #>> '{}' as w from state_meta where key='walletAddress'")).rows[0].w;
const lessons = (await client.query("select doc from kv_store where key='lessons'")).rows[0].doc;
const poolMemory = (await client.query("select doc from kv_store where key='pool-memory'")).rows[0].doc;
const rows = (await client.query(
  "select position_address, pool_address, pair, data from positions where closed and coalesce((data->>'straddle_count')::int,0) > 0 order by closed_at")).rows;
const note = `Corrected ${new Date().toISOString().slice(0, 10)}: pnl % re-expressed on the capital (in-place straddle re-deposits inflate Meteora's deposits).`;
const closedCache = new Map();
for (const row of rows) {
  if (!closedCache.has(row.pool_address)) {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/positions/${row.pool_address}/pnl?user=${wallet}&status=closed&pageSize=100&page=1`);
    closedCache.set(row.pool_address, (await res.json()).positions || []);
  }
  const e = closedCache.get(row.pool_address).find((p) => p.positionAddress === row.position_address);
  const perf = [...(lessons.performance || [])].reverse().find((p) => p.position === row.position_address);
  if (!e || !perf) { console.log(`${row.pair} ${row.position_address.slice(0, 8)}: ${!e ? "closed record" : "perf record"} missing — skipped`); continue; }
  if (perf.straddle_capital_basis) { console.log(`${row.pair} ${row.position_address.slice(0, 8)}: already corrected — skipped`); continue; }
  const pos = row.data;
  const capital = Number(pos.amount_sol);
  const deposits = Number(e.allTimeDeposits?.total?.sol || 0);
  const pnlSol = Number(e.pnlSol);
  const feesSol = Number(e.allTimeFees?.total?.sol || 0);
  if (!(capital > 0) || !(deposits > capital)) { console.log(`${row.pair}: deposits ◎${deposits} not above capital ◎${capital} — skipped`); continue; }
  const pnlPct = r2((pnlSol / capital) * 100);
  const dPnl = pnlSol - Number(perf.pnl_sol ?? pnlSol);
  const legacySol = Math.abs(Number(perf.initial_value_usd) - deposits) < 0.05; // solMode records carry SOL in *_usd
  const perfPatch = {
    pnl_pct: pnlPct, pnl_sol: r6(pnlSol),
    pnl_sol_net: perf.pnl_sol_net != null ? r6(Number(perf.pnl_sol_net) + dPnl) : perf.pnl_sol_net,
    deposit_sol_true: capital,
    straddle_capital_basis: { capital_sol: capital, meteora_deposits_sol: r6(deposits), recorded_pnl_pct: perf.pnl_pct },
    corrected_at: new Date().toISOString(), correction_note: note,
  };
  if (legacySol) Object.assign(perfPatch, { initial_value_usd: capital, final_value_usd: r6(capital + pnlSol - feesSol), pnl_usd: r6(pnlSol) });
  const pm = poolMemory[row.pool_address];
  const dep = pm?.deploys?.find((d) => Math.abs(new Date(d.closed_at) - new Date(perf.recorded_at)) < 120_000);
  console.log(`${row.pair.padEnd(14)} ${row.position_address.slice(0, 8)}  deposits ◎${deposits.toFixed(4)} on ◎${capital}  pnl ◎${pnlSol.toFixed(4)}`
    + `  perf ${perf.pnl_pct}% → ${pnlPct}%  pos ${pos.exit_pnl_pct != null ? Number(pos.exit_pnl_pct).toFixed(2) : "?"}% → ${pnlPct}%  pool ${dep ? `${dep.pnl_pct}% → ${pnlPct}%` : "deploy NOT FOUND"}`
    + `${Math.abs(dPnl) > 1e-6 ? `  pnl_sol ${perf.pnl_sol} → ${r6(pnlSol)} (net ${perf.pnl_sol_net} → ${perfPatch.pnl_sol_net})` : ""}${legacySol ? "" : "  [legacy *_usd fields left: not SOL]"}`);
  Object.assign(perf, perfPatch);
  Object.assign(pos, { exit_pnl_pct: pnlPct, exit_pnl_sol: r6(pnlSol), notes: [...(Array.isArray(pos.notes) ? pos.notes : []), note] });
  if (dep) {
    Object.assign(dep, { pnl_pct: pnlPct, correction_note: note });
    const withPnl = pm.deploys.filter((d) => d.pnl_pct != null);
    pm.avg_pnl_pct = r2(withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length);
    pm.win_rate = r2(withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length);
  }
  if (apply) await client.query("update positions set data=$2, updated_at=now() where position_address=$1", [row.position_address, pos]);
}
if (apply) {
  await client.query("update kv_store set doc=$1, updated_at=now() where key='lessons'", [lessons]);
  await client.query("update kv_store set doc=$1, updated_at=now() where key='pool-memory'", [poolMemory]);
  console.log("\nwritten");
} else console.log("\n(dry run — pass --apply to write)");
await client.end();
