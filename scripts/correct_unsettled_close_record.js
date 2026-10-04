#!/usr/bin/env node
// One-off (2026-10-04): CLAUDIA-SOL pGRQ7rRK was booked from Meteora's closed record 6 s after the
// close, before the last fee claim was indexed (−0.041 SOL / −4.37 %; settled −0.0058 / −0.61 %).
// Rewrites the three stored copies (lessons record, pool-memory deploy, positions row) from the
// settled record and drops the "FAILED … −4.37 %" auto-lesson it produced. The audited wallet net
// (pnl_sol_net) is kept. Run with the agent STOPPED.
// Usage: node scripts/correct_unsettled_close_record.js <position-prefix> [--apply]
import "../envcrypt.js";
import pg from "pg";

const prefix = process.argv[2];
const apply = process.argv.includes("--apply");
if (!prefix) { console.error("usage: correct_unsettled_close_record.js <position-prefix> [--apply]"); process.exit(1); }
const r2 = (v) => Math.round(v * 100) / 100;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const client = new pg.Client();
await client.connect();
const lessons = (await client.query("select doc from kv_store where key='lessons'")).rows[0].doc;
const rec = (lessons.performance || []).find((x) => String(x.position || "").startsWith(prefix));
if (!rec) { console.error("record not found"); process.exit(1); }
const wallet = (await client.query("select value from state_meta where key ilike '%wallet%' limit 1")).rows[0].value.replace(/"/g, "");
const res = await fetch(`https://dlmm.datapi.meteora.ag/positions/${rec.pool}/pnl?user=${wallet}&status=closed&pageSize=50&page=1`);
const api = ((await res.json()).positions || []).find((p) => p.positionAddress === rec.position);
if (!api) { console.error("settled record not found on Meteora"); process.exit(1); }
const dep = Number(api.allTimeDeposits.total.sol), wd = Number(api.allTimeWithdrawals.total.sol), fees = Number(api.allTimeFees.total.sol);
const pnlSol = wd + fees - dep;
const capital = Number(rec.deposit_sol_true) || Number(rec.amount_sol);
const pct = r2((pnlSol / capital) * 100);
console.log(`${rec.pool_name} ${rec.position.slice(0, 8)}: pnl ◎${rec.pnl_sol} (${rec.pnl_pct}%) → ◎${r6(pnlSol)} (${pct}%); fees ◎${rec.fees_sol_true} → ◎${r6(fees)}`);
const oldPct = rec.pnl_pct;
rec.unsettled_close_before = { pnl_sol: rec.pnl_sol, pnl_pct: rec.pnl_pct, pnl_usd: rec.pnl_usd, pnl_usd_true: rec.pnl_usd_true, fees_sol_true: rec.fees_sol_true, fees_usd_true: rec.fees_usd_true };
rec.pnl_sol = r6(pnlSol); rec.pnl_usd = r2(pnlSol); rec.pnl_pct = pct;
rec.pnl_usd_true = Number(api.pnlUsd);
rec.fees_sol_true = r6(fees); rec.fees_earned_usd = r6(fees); rec.fees_usd_true = Number(api.allTimeFees.total.usd);
rec.final_value_usd = r6(wd);
const modelled = r6(pnlSol - (Number(rec.total_gas_sol) || 0) - (Number(rec.exit_slippage_sol) || 0));
if (rec.pnl_sol_net_source === "wallet") {
  rec.pnl_sol_net_modelled = modelled;
  if (rec.chain_audit) { rec.chain_audit.booked_sol = modelled; rec.chain_audit.diff_sol = r6(modelled - Number(rec.chain_audit.net_sol)); rec.chain_audit.status = Math.abs(rec.chain_audit.diff_sol) <= Number(rec.chain_audit.tolerance_sol) ? "ok" : "mismatch"; }
} else rec.pnl_sol_net = modelled;
rec.unsettled_close_corrected_at = new Date().toISOString();
const before = (lessons.lessons || []).length;
lessons.lessons = (lessons.lessons || []).filter((l) => !(String(l.rule || "").includes(rec.pool_name) && String(l.rule || "").includes(`PnL ${oldPct}%`)));
console.log(`auto-lessons removed: ${before - lessons.lessons.length}; net result stays ◎${rec.pnl_sol_net} (${rec.pnl_sol_net_source || "modelled"})`);

const pm = (await client.query("select doc from kv_store where key='pool-memory'")).rows[0].doc;
const d = (pm[rec.pool]?.deploys || []).find((x) => x.closed_at === rec.recorded_at || Math.abs(new Date(x.closed_at) - new Date(rec.recorded_at)) < 5000);
if (d) { console.log(`pool-memory deploy: ${d.pnl_pct}% → ${pct}%`); d.pnl_pct = pct; d.pnl_usd = r2(pnlSol); d.fees_earned_usd = r6(fees); d.fee_earned_pct = r2((fees / capital) * 100); d.gas_adjusted_pnl_sol = r6(pnlSol - (Number(d.total_gas_sol) || 0)); }
else console.log("pool-memory deploy not found");
const pos = (await client.query("select data from positions where position_address=$1", [rec.position])).rows[0]?.data;
if (pos) { console.log(`positions row exit_pnl_pct: ${pos.exit_pnl_pct} → ${pct}`); pos.exit_pnl_pct = pct; pos.exit_pnl_usd = Number(api.pnlUsd); }
if (apply) {
  await client.query("update kv_store set doc=$1, updated_at=now() where key='lessons'", [lessons]);
  await client.query("update kv_store set doc=$1, updated_at=now() where key='pool-memory'", [pm]);
  if (pos) await client.query("update positions set data=$1 where position_address=$2", [pos, rec.position]);
  console.log("written");
} else console.log("(dry run — pass --apply to write)");
await client.end();
