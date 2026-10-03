#!/usr/bin/env node
// One-off (2026-10-03): make deposit_usd_true / deposit_sol_true on closed perf records agree
// with the capital the record's pnl % is measured on. The web dashboard shows a closed
// position's percent as pnl_usd_true / deposit_usd_true, so a record whose deposit fields
// still carry Meteora's lifetime (re-deposit-inflated or pre-adoption) totals displays a
// diluted percent even after pnl_pct was corrected:
//   - records re-expressed on capital today (capital_basis / straddle_capital_basis):
//       deposits × capital / Meteora deposits, deposit_sol_true = capital
//   - adoption-rebased records (adoption_lifetime) whose USD deposit was never rebased:
//       deposit_usd_true × deposit_sol_true / lifetime deposits
// Run with the agent STOPPED (kv_store write-through race).
// Usage: node scripts/correct_deposit_usd_records.js [--apply]
import "../envcrypt.js";
import pg from "pg";

const apply = process.argv.includes("--apply");
const r2 = (v) => Math.round(v * 100) / 100;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const client = new pg.Client();
await client.connect();
const lessons = (await client.query("select doc from kv_store where key='lessons'")).rows[0].doc;
const dashPct = (r) => (Number(r.deposit_usd_true) > 0 && r.pnl_usd_true != null ? (Number(r.pnl_usd_true) / Number(r.deposit_usd_true)) * 100 : null);
let fixed = 0, unchanged = 0;
for (const r of lessons.performance || []) {
  const cb = r.capital_basis || r.straddle_capital_basis;
  const life = r.adoption_lifetime;
  let scale = null, newSol = null, why = null;
  if (cb && Number(cb.meteora_deposits_sol) > Number(cb.capital_sol) && Number(r.deposit_usd_true) > 0) {
    // already scaled? (deposit_sol_true set to the capital AND usd/sol ratio consistent with it)
    const solNow = Number(r.deposit_sol_true);
    const alreadyUsd = Math.abs(solNow - cb.capital_sol) < 1e-6 && Math.abs(dashPct(r) - r.pnl_pct) < 1;
    if (!alreadyUsd) { scale = cb.capital_sol / cb.meteora_deposits_sol; newSol = cb.capital_sol; why = "capital basis"; }
  } else if (life && Number(life.deposit_sol_true) > 0 && Number(r.deposit_sol_true) > 0 && Number(r.deposit_usd_true) > 0
             && Number(r.deposit_sol_true) < Number(life.deposit_sol_true) * 0.95) {
    const p = dashPct(r);
    if (p != null && Math.abs(p - Number(r.pnl_pct)) > 1) { scale = Number(r.deposit_sol_true) / Number(life.deposit_sol_true); newSol = Number(r.deposit_sol_true); why = "adoption rebase"; }
  }
  if (scale == null) { unchanged++; continue; }
  const before = dashPct(r);
  const usd = r2(Number(r.deposit_usd_true) * scale);
  const after = r.pnl_usd_true != null && usd > 0 ? (Number(r.pnl_usd_true) / usd) * 100 : null;
  console.log(`${String(r.pool_name).padEnd(14)} ${String(r.position).slice(0, 8)}  ${why.padEnd(15)} deposit ◎${r6(Number(r.deposit_sol_true))} → ◎${r6(newSol)}  $${r2(Number(r.deposit_usd_true))} → $${usd}  dashboard % ${before != null ? r2(before) : "–"} → ${after != null ? r2(after) : "–"}  (pnl_pct ${r.pnl_pct})`);
  r.deposit_usd_true = usd;
  r.deposit_sol_true = r6(newSol);
  r.deposit_fields_corrected_at = new Date().toISOString();
  fixed++;
}
console.log(`\nrecords: corrected ${fixed}, unchanged ${unchanged}`);
if (apply) {
  await client.query("update kv_store set doc=$1, updated_at=now() where key='lessons'", [lessons]);
  console.log("written");
} else console.log("(dry run — pass --apply to write)");
await client.end();
