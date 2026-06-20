/**
 * One-time data migration: backfill missing `rentSol` / `unclaimedFeesSol` on
 * historical balance-history entries.
 *
 * Why: early entries stored only idle/deployed/total and their `totalSol`
 * EXCLUDED the locked position rent (rent tracking was added later). Recent
 * entries (and the KPI card) INCLUDE rent. That definition change leaves the
 * chart's historical totals short of actual AUM and inconsistent with the KPI.
 *
 * Fix: apply the current rent-inclusive AUM definition uniformly. For each
 * incomplete (old) entry:
 *   rentSol   = 0.065 × openPositions(ts)        // recoverable rent actually locked
 *   unclaimed = max(0, totalSol − idle − deployed) // any residual already in total (≈0)
 *   totalSol  = idle + deployed + rentSol + unclaimed   // now rent-inclusive
 *   totalUsd  = totalSol × solPriceUsd
 * Genuinely-flat entries (no open positions) get rent=0 and are unchanged.
 * Recent, already-complete entries are left untouched. unclaimed fees for old
 * entries are unrecoverable and left at 0 (small).
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
  let totalAdded = 0;
  for (const e of history) {
    if (e.rentSol != null && e.unclaimedFeesSol != null) continue; // already complete (recent)
    const idle = e.idleSol || 0;
    const dep = e.deployedSol || 0;
    const tot = e.totalSol || 0;
    const oc = openAt(new Date(e.ts).getTime());
    const rent = RENT_PER_POSITION_SOL * oc;            // recoverable rent actually locked
    const unclaimed = Math.max(0, tot - idle - dep);    // residual already in the old total (≈0)
    const newTotal = idle + dep + rent + unclaimed;     // now rent-inclusive, like recent entries
    e.rentSol = round5(rent);
    e.unclaimedFeesSol = round5(unclaimed);
    totalAdded += newTotal - tot;
    e.totalSol = round5(newTotal);
    e.totalUsd = Math.round(newTotal * (e.solPriceUsd || 0) * 100) / 100;
    filled++;
  }

  console.log(`Filled ${filled} entries. Total SOL added (rent now included): ${totalAdded.toFixed(4)} across all.`);

  await query("UPDATE kv_store SET doc = $1::jsonb, updated_at = now() WHERE key = 'balance-history'", [JSON.stringify(history)]);
  console.log("Backfill written to kv_store.");
}

main()
  .catch((err) => { console.error("backfill failed:", err.message); process.exitCode = 1; })
  .finally(() => closePool().catch(() => {}));
