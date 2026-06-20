/**
 * One-time data migration: backfill missing `rentSol` / `unclaimedFeesSol` on
 * historical balance-history entries.
 *
 * Why: early entries stored only idle/deployed/total; the agent's recorded
 * `totalSol` (authoritative AUM) already baked in rent + unclaimed fees, but the
 * dashboard recomputes total from components and silently dropped the missing
 * ones — making the chart's historical totals fall short of the actual amounts.
 *
 * Fix: decompose the residual (total − idle − deployed) back into rent + unclaimed
 *   residual = max(0, totalSol − idleSol − deployedSol)
 *   rentSol   = min(0.065 × openPositions(ts), residual)
 *   unclaimed = residual − rentSol
 * This preserves the recorded total EXACTLY (zero drift beyond rounding) while
 * making every entry component-complete, so the dashboard recompute reproduces
 * the actual amount.
 *
 * Idempotent (only touches entries missing a component). MUST run with the
 * `meridian` agent STOPPED — it owns the balance-history doc-store cache and would
 * otherwise overwrite this backfill on its next 5-min write.
 *
 *   pm2 stop meridian && node scripts/backfill_balance_history.js && pm2 start meridian
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "../envcrypt.js";
import { usePg, query, closePool } from "../db/pool.js";

const RENT_PER_POSITION_SOL = 0.065;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const round5 = (x) => Math.round((Number(x) || 0) * 1e5) / 1e5;

async function main() {
  if (!usePg()) {
    console.error("This migration requires PERSIST_BACKEND=pg.");
    process.exitCode = 1;
    return;
  }

  const { rows } = await query("SELECT doc FROM kv_store WHERE key = 'balance-history'");
  const history = rows[0]?.doc;
  if (!Array.isArray(history)) {
    console.error("No balance-history doc found.");
    process.exitCode = 1;
    return;
  }

  // Backup outside the repo so the git syncer can't touch it.
  const backupDir = fs.existsSync("/opt/meridian-backups") ? "/opt/meridian-backups" : path.join(__dirname, "..");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `balance-history-pre-backfill-${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(history));
  console.log(`Backed up ${history.length} entries → ${backupPath}`);

  // Position open-intervals (open + closed) for rent estimation.
  const pr = await query("SELECT data FROM positions");
  const intervals = [];
  for (const r of pr.rows) {
    const d = r.data || {};
    if (!d.deployed_at) continue;
    intervals.push([new Date(d.deployed_at).getTime(), d.closed_at ? new Date(d.closed_at).getTime() : Date.now()]);
  }
  const openAt = (t) => intervals.reduce((n, [s, e]) => n + (t >= s && t <= e ? 1 : 0), 0);

  let filled = 0;
  let maxDrift = 0;
  for (const e of history) {
    if (e.rentSol != null && e.unclaimedFeesSol != null) continue; // already complete
    const idle = e.idleSol || 0;
    const dep = e.deployedSol || 0;
    const tot = e.totalSol || 0;
    const residual = Math.max(0, tot - idle - dep);
    const oc = openAt(new Date(e.ts).getTime());
    const rent = e.rentSol != null ? e.rentSol : Math.min(RENT_PER_POSITION_SOL * oc, residual);
    const unclaimed = e.unclaimedFeesSol != null ? e.unclaimedFeesSol : Math.max(0, residual - rent);
    e.rentSol = round5(rent);
    e.unclaimedFeesSol = round5(unclaimed);
    maxDrift = Math.max(maxDrift, Math.abs((idle + dep + e.rentSol + e.unclaimedFeesSol) - tot));
    filled++;
  }

  console.log(`Filled ${filled} entries. Max total drift: ${maxDrift.toFixed(6)} SOL (rounding only).`);

  await query("UPDATE kv_store SET doc = $1::jsonb, updated_at = now() WHERE key = 'balance-history'", [JSON.stringify(history)]);
  console.log("Backfill written to kv_store.");
}

main()
  .catch((err) => { console.error("backfill failed:", err.message); process.exitCode = 1; })
  .finally(() => closePool().catch(() => {}));
