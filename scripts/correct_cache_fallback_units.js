#!/usr/bin/env node
// One-off (2026-10-04): closes scored from the pre-close cache (urgent and manual closes, which
// make a single closed-API attempt) wrote REAL-USD figures into the legacy *_usd record fields,
// which carry SOL under solMode, and left the deposit/fee dual fields empty. DUST-SOL 10-03:
// pnl_usd −21.06 for a −0.1774 SOL stop loss → the morning briefing summed "◎-19.53" for a
// +1.36 SOL day. This rewrites those records' legacy fields in SOL and fills the dual fields;
// pnl_sol, pnl_usd_true and pnl_pct are kept. Run with the agent STOPPED.
// Usage: node scripts/correct_cache_fallback_units.js [--apply]
import "../envcrypt.js";
import pg from "pg";

const apply = process.argv.includes("--apply");
const r2 = (v) => Math.round(v * 100) / 100;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const fin = (v) => v != null && Number.isFinite(Number(v));
const client = new pg.Client();
await client.connect();
const lessons = (await client.query("select doc from kv_store where key='lessons'")).rows[0].doc;
let fixed = 0;
for (const r of lessons.performance || []) {
  if (!fin(r.pnl_sol) || !fin(r.pnl_usd_true) || !fin(r.pnl_usd) || !(Number(r.amount_sol) > 0)) continue;
  if (r.deposit_sol_true != null || r.legacy_units_corrected_at) continue;
  const usdInLegacy = Math.abs(Number(r.pnl_usd) - Number(r.pnl_usd_true)) <= 0.011
    && Math.abs(Number(r.pnl_usd_true) - Number(r.pnl_sol)) > 0.02;
  // initial_value_usd is the deploy-time USD value: tens of dollars per SOL of capital.
  const initialIsUsd = Number(r.initial_value_usd) > Number(r.amount_sol) * 20;
  if (!usdInLegacy || !initialIsUsd) continue;
  const cap = Number(r.amount_sol);
  const pnlSol = Number(r.pnl_sol);
  // SOL price at the close, from the nearest balance sample (pnl_usd_true / pnl_sol is not a
  // price: the two are measured on different bases); deploy-time value per SOL as a fallback.
  const near = (await client.query(
    "select (snapshot->>'solPriceUsd')::float8 px from balance_history where created_at between $1::timestamptz - interval '30 min' and $1::timestamptz + interval '30 min' and (snapshot->>'solPriceUsd')::float8 > 0 order by abs(extract(epoch from created_at - $1::timestamptz)) limit 1",
    [r.recorded_at])).rows[0]?.px;
  const px = near > 0 ? near : Number(r.initial_value_usd) / cap;
  const feesUsd = Number(r.fees_earned_usd) || 0;
  const feesSol = px > 0 ? feesUsd / px : 0;
  console.log(`${String(r.pool_name).padEnd(15)} ${String(r.recorded_at).slice(0, 16)}  pnl ${r.pnl_usd} → ◎${r2(pnlSol)} (pnl_sol ${pnlSol}, $${r.pnl_usd_true})  fees ${r6(feesUsd)} → ◎${r6(feesSol)}  initial ${r.initial_value_usd} → ◎${cap}  @ $${r2(px)}/SOL`);
  r.legacy_units_before = { pnl_usd: r.pnl_usd, fees_earned_usd: r.fees_earned_usd, initial_value_usd: r.initial_value_usd, final_value_usd: r.final_value_usd };
  r.deposit_usd_true = r2(Number(r.initial_value_usd));
  r.deposit_sol_true = r6(cap);
  r.fees_usd_true = r6(feesUsd);
  r.fees_sol_true = r6(feesSol);
  r.pnl_usd = r2(pnlSol);
  r.fees_earned_usd = r6(feesSol);
  r.initial_value_usd = r6(cap);
  r.final_value_usd = r6(Math.max(0, cap + pnlSol - feesSol));
  r.legacy_units_corrected_at = new Date().toISOString();
  fixed++;
}
console.log(`\nrecords corrected: ${fixed}`);
if (apply) {
  await client.query("update kv_store set doc=$1, updated_at=now() where key='lessons'", [lessons]);
  console.log("written");
} else console.log("(dry run — pass --apply to write)");
await client.end();
