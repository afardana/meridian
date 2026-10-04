#!/usr/bin/env node
// One-off (2026-10-04): the in-place straddle's net-deposit basis treated the fees a
// RebalanceLiquidity claims as withdrawn principal, so the "own-flow basis offset" added those
// fees to the closed pnl a second time. Verified against the wallet's on-chain flows
// (CLAUDIA-SOL: all legs and swaps net +0.1258 SOL; Meteora 0.1250; recorded 0.1426).
// Takes the double-counted fees back out of three closed records; fee amounts are the
// indexer's allTimeFees right after each straddle (agent log "claimed fees floored to indexer").
// Run with the agent STOPPED. Usage: node scripts/correct_straddle_fee_basis_records.js [--apply]
import "../envcrypt.js";
import pg from "pg";

const FIXES = [
  { position: "CC9jDsKq", pair: "CLAUDIA-SOL", fees_sol: 0.017686 },
  { position: "8Scki4XQ", pair: "CRAWL-SOL", fees_sol: 0.008327 },
  { position: "ABUEPEvU", pair: "swordcat-SOL", fees_sol: 0.020626 },
];
const apply = process.argv.includes("--apply");
const r2 = (v) => Math.round(v * 100) / 100;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const client = new pg.Client();
await client.connect();
const lessons = (await client.query("select doc from kv_store where key='lessons'")).rows[0].doc;
let fixed = 0;
for (const f of FIXES) {
  const r = (lessons.performance || []).find((x) => String(x.position || "").startsWith(f.position));
  if (!r) { console.log(`${f.pair}: record not found`); continue; }
  if (r.straddle_fee_basis_corrected_at) { console.log(`${f.pair}: already corrected`); continue; }
  const px = (await client.query(
    "select (snapshot->>'solPriceUsd')::float8 px from balance_history where created_at between $1::timestamptz - interval '30 min' and $1::timestamptz + interval '30 min' and (snapshot->>'solPriceUsd')::float8 > 0 order by abs(extract(epoch from created_at - $1::timestamptz)) limit 1",
    [r.recorded_at])).rows[0]?.px || 0;
  const d = f.fees_sol;
  const dep = Number(r.deposit_sol_true) || Number(r.amount_sol);
  const before = { pnl_sol: r.pnl_sol, pnl_pct: r.pnl_pct, pnl_usd: r.pnl_usd, pnl_usd_true: r.pnl_usd_true, pnl_sol_net: r.pnl_sol_net, final_value_usd: r.final_value_usd };
  r.pnl_sol = r6(Number(r.pnl_sol) - d);
  if (Number.isFinite(Number(r.pnl_sol_net))) r.pnl_sol_net = r6(Number(r.pnl_sol_net) - d);
  r.pnl_usd = r2(Number(r.pnl_sol));
  if (Number.isFinite(Number(r.final_value_usd))) r.final_value_usd = r6(Number(r.final_value_usd) - d);
  if (Number.isFinite(Number(r.pnl_usd_true)) && px > 0) r.pnl_usd_true = r6(Number(r.pnl_usd_true) - d * px);
  if (dep > 0) r.pnl_pct = r2((Number(r.pnl_sol) / dep) * 100);
  r.straddle_fee_basis_before = before;
  r.straddle_fee_basis_corrected_at = new Date().toISOString();
  console.log(`${f.pair.padEnd(13)} ${f.position}  pnl ◎${before.pnl_sol} → ◎${r.pnl_sol}  (${before.pnl_pct}% → ${r.pnl_pct}%)  $${before.pnl_usd_true} → $${r.pnl_usd_true}  net ◎${before.pnl_sol_net} → ◎${r.pnl_sol_net}`);
  fixed++;
}
console.log(`\nrecords corrected: ${fixed}`);
if (apply && fixed) {
  await client.query("update kv_store set doc=$1, updated_at=now() where key='lessons'", [lessons]);
  console.log("written");
} else console.log("(dry run — pass --apply to write)");
await client.end();
