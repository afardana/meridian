#!/usr/bin/env node
// One-off (2026-10-03): re-express the closed records of RE-RANGED positions (Meteora-UI
// rebalances, "External rebalance detected", and in-place straddles) on their capital.
// Each re-range withdraws everything and re-deposits it, and Meteora counts every re-deposit
// in allTimeDeposits (one UI rebalance → 2× deposits, several → 3–5×), so a pnl % measured
// on Meteora's deposits — or, for adopted accounts, on capital + "post-adoption top-ups"
// that were really re-deposits — was a fraction of the real one (CTO-SOL −41.0 % recorded,
// −81.6 % on its 2.03 SOL). The record's own pnl_sol is kept; only the percent (and the
// legacy solMode initial/final value fields, so final + fees − initial = pnl) change.
// Records whose percent is already on the capital are left alone.
// Rewrites the lessons perf row, the positions row (exit_pnl_pct) and the pool-memory deploy.
// Run with the agent STOPPED (kv_store write-through race).
// Usage: node scripts/correct_rebalance_pct_records.js [--apply]
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
const rows = (await client.query(`select position_address, pool_address, pair, data from positions where closed
  and (coalesce((data->>'rebalance_count')::int,0) > 0 or coalesce((data->>'straddle_count')::int,0) > 0) order by closed_at`)).rows;
const note = `Corrected ${new Date().toISOString().slice(0, 10)}: pnl % re-expressed on the capital (a re-range re-deposits the position and inflates Meteora's deposits).`;
const closedCache = new Map();
async function closedFor(pool) {
  if (!closedCache.has(pool)) {
    const all = [];
    for (let page = 1; page <= 5; page++) {
      const res = await fetch(`https://dlmm.datapi.meteora.ag/positions/${pool}/pnl?user=${wallet}&status=closed&pageSize=100&page=${page}`);
      const got = res.ok ? ((await res.json()).positions || []) : [];
      all.push(...got);
      if (got.length < 100) break;
    }
    closedCache.set(pool, all);
    await new Promise((r) => setTimeout(r, 300));
  }
  return closedCache.get(pool);
}
const tally = { fixed: 0, already: 0, skipped: 0 };
for (const row of rows) {
  const tag = `${row.pair.padEnd(14)} ${row.position_address.slice(0, 8)}`;
  const perf = [...(lessons.performance || [])].reverse().find((p) => p.position === row.position_address);
  if (!perf) { tally.skipped++; continue; }
  if (perf.straddle_capital_basis || perf.capital_basis) { tally.already++; continue; }
  const e = (await closedFor(row.pool_address)).find((p) => p.positionAddress === row.position_address);
  const pos = row.data;
  const capital = Number(pos.amount_sol);
  const deposits = Number(e?.allTimeDeposits?.total?.sol || 0);
  const pnlSol = Number(perf.pnl_sol);
  if (!e || !(capital > 0) || !(deposits > capital * 1.05) || !Number.isFinite(pnlSol) || perf.pnl_pct == null) {
    tally.skipped++;
    if (e && capital > 0 && deposits > capital * 1.05) console.log(`${tag}  skipped: no pnl_sol / pnl_pct on the record`);
    continue;
  }
  const onCapital = r2((pnlSol / capital) * 100);
  const recorded = Number(perf.pnl_pct);
  if (Math.abs(recorded - onCapital) < 0.05) { tally.already++; continue; }
  // Diluted if the recorded percent sits closer to pnl over Meteora's deposits (or the
  // adoption rebase's inflated capital) than to pnl over the capital.
  const onDeposits = (pnlSol / deposits) * 100;
  const adoptedRebase = !!perf.adoption_lifetime;
  if (!adoptedRebase && Math.abs(recorded - onDeposits) > Math.abs(recorded - onCapital)) {
    console.log(`${tag}  left: recorded ${recorded}% is not the diluted ${r2(onDeposits)}% (capital ${onCapital}%)`);
    tally.skipped++; continue;
  }
  const feesSol = Number(perf.fees_sol_true ?? e.allTimeFees?.total?.sol ?? 0);
  const legacySol = Math.abs(Number(perf.initial_value_usd) - deposits) < deposits * 0.05;
  const perfPatch = { pnl_pct: onCapital, capital_basis: { capital_sol: capital, meteora_deposits_sol: r6(deposits), recorded_pnl_pct: recorded }, corrected_at: new Date().toISOString(), correction_note: note };
  if (legacySol) Object.assign(perfPatch, { initial_value_usd: capital, final_value_usd: r6(capital + pnlSol - feesSol) });
  const pm = poolMemory[row.pool_address];
  // Same pool, closed within 2 min AND still carrying this record's percent — two positions
  // of one pool can close together (PURPS-SOL 09-14), and the first one may already be updated.
  const dep = (pm?.deploys || [])
    .filter((d) => Math.abs(new Date(d.closed_at) - new Date(perf.recorded_at)) < 120_000 && Math.abs(Number(d.pnl_pct) - recorded) < 0.05)
    .sort((a, b) => Math.abs(new Date(a.closed_at) - new Date(perf.recorded_at)) - Math.abs(new Date(b.closed_at) - new Date(perf.recorded_at)))[0];
  console.log(`${tag}  ${perf.adopted ? "adopted" : "bot    "}  deposits ◎${deposits.toFixed(3)} on ◎${capital}  pnl ◎${pnlSol.toFixed(4)}  ${recorded}% → ${onCapital}%  pos ${pos.exit_pnl_pct != null ? r2(Number(pos.exit_pnl_pct)) + "%" : "–"}  pool ${dep ? dep.pnl_pct + "%" : "–"}`);
  Object.assign(perf, perfPatch);
  Object.assign(pos, { exit_pnl_pct: onCapital, notes: [...(Array.isArray(pos.notes) ? pos.notes : []), note] });
  if (dep) {
    Object.assign(dep, { pnl_pct: onCapital, correction_note: note });
    const withPnl = pm.deploys.filter((d) => d.pnl_pct != null);
    pm.avg_pnl_pct = r2(withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length);
    pm.win_rate = r2(withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length);
  }
  tally.fixed++;
  if (apply) await client.query("update positions set data=$2, updated_at=now() where position_address=$1", [row.position_address, pos]);
}
console.log(`\nre-ranged closed positions ${rows.length}: corrected ${tally.fixed}, already on capital ${tally.already}, skipped ${tally.skipped}`);
if (apply) {
  await client.query("update kv_store set doc=$1, updated_at=now() where key='lessons'", [lessons]);
  await client.query("update kv_store set doc=$1, updated_at=now() where key='pool-memory'", [poolMemory]);
  console.log("written");
} else console.log("(dry run — pass --apply to write)");
await client.end();
