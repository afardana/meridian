#!/usr/bin/env node
// One-off (2026-10-04): swordcat-SOL ABUEPEvU closed on Meteora's net deposit instead of ours.
// Its straddle's base deposit landed 10 bins above the buy, Meteora booked it at that price,
// and when the pending flow expired ◎0.096 was booked as outside capital (amount_sol 1.49 →
// 1.586) and dropped out of pnl: recorded +0.0943 SOL / 5.95 % of ◎1.586; with the fix
// (393f286) it is +0.1903 SOL / 12.77 % of ◎1.49. Rewrites the lessons perf row, the
// positions row and the pool-memory deploy. Run with the agent STOPPED.
// Usage: node scripts/correct_flow_basis_record.js <position> <offset_sol> <capital_sol> [--apply]
import "../envcrypt.js";
import pg from "pg";

const [position, offArg, capArg] = process.argv.slice(2);
const apply = process.argv.includes("--apply");
const off = Number(offArg), capital = Number(capArg);
if (!position || !Number.isFinite(off) || !(capital > 0)) { console.error("usage: <position> <offset_sol> <capital_sol> [--apply]"); process.exit(1); }
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r2 = (v) => Math.round(v * 100) / 100;
const client = new pg.Client();
await client.connect();
const lessons = (await client.query("select doc from kv_store where key='lessons'")).rows[0].doc;
const poolMemory = (await client.query("select doc from kv_store where key='pool-memory'")).rows[0].doc;
const row = (await client.query("select position_address, pool_address, pair, data from positions where position_address=$1 and closed", [position])).rows[0];
const perf = [...(lessons.performance || [])].reverse().find((p) => p.position === position);
if (!row || !perf) { console.error("closed position or perf record not found"); process.exit(1); }
if (perf.flow_basis_offset_sol) { console.log("already corrected"); process.exit(0); }
const pos = row.data;
const pnlSol = r6(Number(perf.pnl_sol) + off);
const pnlPct = r2((pnlSol / capital) * 100);
const oldDep = Number(perf.deposit_sol_true) || Number(perf.amount_sol);
const solPx = Number(perf.deposit_usd_true) > 0 && oldDep > 0 ? Number(perf.deposit_usd_true) / oldDep : 0;
const feesSol = Number(perf.fees_sol_true) || 0;
const note = `Corrected ${new Date().toISOString().slice(0, 10)}: the straddle's own-flow basis difference (◎${off}) was booked as outside capital and left out of pnl; restored on the ◎${capital} capital.`;
const legacySol = Math.abs(Number(perf.initial_value_usd) - oldDep) < 0.05; // solMode records carry SOL in *_usd
const patch = {
  pnl_sol: pnlSol, pnl_pct: pnlPct,
  pnl_sol_net: perf.pnl_sol_net != null ? r6(Number(perf.pnl_sol_net) + off) : perf.pnl_sol_net,
  pnl_usd_true: solPx > 0 ? r2(Number(perf.pnl_usd_true) + off * solPx) : perf.pnl_usd_true,
  amount_sol: capital, deposit_sol_true: capital,
  deposit_usd_true: solPx > 0 ? r2(capital * solPx) : perf.deposit_usd_true,
  flow_basis_offset_sol: off,
  flow_basis_correction: { recorded_pnl_sol: perf.pnl_sol, recorded_pnl_pct: perf.pnl_pct, recorded_amount_sol: perf.amount_sol },
  corrected_at: new Date().toISOString(), correction_note: note,
};
if (legacySol) Object.assign(patch, { initial_value_usd: capital, final_value_usd: r6(capital + pnlSol - feesSol), pnl_usd: r2(pnlSol) });
const pm = poolMemory[row.pool_address];
const dep = pm?.deploys?.find((d) => Math.abs(new Date(d.closed_at) - new Date(perf.recorded_at)) < 120_000 && Math.abs(Number(d.pnl_pct) - Number(perf.pnl_pct)) < 0.05);
console.log(`${row.pair} ${position.slice(0, 8)}: pnl ◎${perf.pnl_sol} → ◎${pnlSol}; ${perf.pnl_pct}% of ◎${perf.amount_sol} → ${pnlPct}% of ◎${capital}; net ${perf.pnl_sol_net} → ${patch.pnl_sol_net}; usd ${perf.pnl_usd_true} → ${patch.pnl_usd_true}; deposit usd ${perf.deposit_usd_true} → ${patch.deposit_usd_true}; pool deploy ${dep ? `${dep.pnl_pct}% → ${pnlPct}%` : "NOT FOUND"}`);
Object.assign(perf, patch);
Object.assign(pos, { exit_pnl_pct: pnlPct, exit_pnl_sol: pnlSol, amount_sol: capital, flow_basis_offset_sol: off, notes: [...(Array.isArray(pos.notes) ? pos.notes : []), note] });
if (dep) {
  Object.assign(dep, { pnl_pct: pnlPct, correction_note: note });
  const withPnl = pm.deploys.filter((d) => d.pnl_pct != null);
  pm.avg_pnl_pct = r2(withPnl.reduce((s, d) => s + d.pnl_pct, 0) / withPnl.length);
  pm.win_rate = r2(withPnl.filter((d) => d.pnl_pct >= 0).length / withPnl.length);
}
if (apply) {
  await client.query("update positions set data=$2, updated_at=now() where position_address=$1", [position, pos]);
  await client.query("update kv_store set doc=$1, updated_at=now() where key='lessons'", [lessons]);
  await client.query("update kv_store set doc=$1, updated_at=now() where key='pool-memory'", [poolMemory]);
  console.log("written");
} else console.log("(dry run — pass --apply to write)");
await client.end();
