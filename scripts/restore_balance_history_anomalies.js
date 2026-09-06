/**
 * Phase: Historical AUM anomaly restoration.
 *
 * Detects and repairs isolated sampling excursions (dips, spikes, and compound
 * transitions during position deployment/closure desynchronization) in the
 * PostgreSQL `balance_history` table.
 *
 * Usage:
 *   node scripts/restore_balance_history_anomalies.js [--dry-run]
 *   node scripts/restore_balance_history_anomalies.js --apply
 *
 * Safety:
 *   - Automatically creates an in-DB backup table `balance_history_backup_YYYYMMDD`
 *   - Exports pre-migration affected records to `/opt/meridian-backups/`
 *   - Updates are executed in a single atomic transaction.
 *   - Aligns deployedSol/idleSol components so recomputing consumers remain consistent.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import "../envcrypt.js";
import { usePg, query, withTransaction, closePool } from "../db/pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isApply = process.argv.includes("--apply");

async function main() {
  if (!usePg()) {
    console.error("This script requires PERSIST_BACKEND=pg.");
    process.exitCode = 1;
    return;
  }

  console.log(`[balance_history restoration] Running in ${isApply ? "APPLY" : "DRY-RUN"} mode...`);

  const { rows } = await query(
    "SELECT id, created_at, total_usd, snapshot FROM balance_history ORDER BY created_at ASC"
  );
  console.log(`Loaded ${rows.length} rows from balance_history.`);

  const history = rows.map((r) => ({
    id: r.id,
    ts: new Date(r.created_at).getTime(),
    sol: Number(r.snapshot?.totalSol),
    usd: Number(r.snapshot?.totalUsd),
    idle: Number(r.snapshot?.idleSol || 0),
    dep: Number(r.snapshot?.deployedSol || 0),
    tokens: Number(r.snapshot?.tokensSol || 0),
    rent: Number(r.snapshot?.rentSol || 0),
    unclaimed: Number(r.snapshot?.unclaimedFeesSol || 0),
    price: Number(r.snapshot?.solPriceUsd || 0),
    origSol: Number(r.snapshot?.totalSol),
    origUsd: Number(r.snapshot?.totalUsd),
    rawSnapshot: r.snapshot,
    modified: false,
  }));

  const minSolExcursion = 0.5;
  const maxAnchorDiff = 0.5;
  const maxStepMs = 12 * 60 * 1000;
  const maxWindowMs = 25 * 60 * 1000;

  const repairedRecords = [];

  function scanAndRepair(typeToRepair) {
    let count = 0;
    for (let i = 1; i < history.length - 1; i++) {
      const prev = history[i - 1];
      if (prev.modified) continue;

      for (const runLen of [4, 3, 2, 1]) {
        const nextIdx = i + runLen;
        if (nextIdx >= history.length) continue;
        const next = history[nextIdx];
        if (next.modified) continue;

        if (next.ts - prev.ts > maxWindowMs) continue;
        if (Math.abs(next.sol - prev.sol) > maxAnchorDiff) continue;

        let timeValid = true;
        let lastT = prev.ts;
        for (let k = i; k <= nextIdx; k++) {
          const curT = history[k].ts;
          if (curT <= lastT || curT - lastT > maxStepMs) {
            timeValid = false;
            break;
          }
          lastT = curT;
        }
        if (!timeValid) continue;

        const items = history.slice(i, nextIdx);
        const sols = items.map((r) => r.sol);

        const isValley = sols.every(
          (s) => prev.sol - s >= minSolExcursion && next.sol - s >= minSolExcursion * 0.55
        );
        const isPeak = sols.every(
          (s) => s - prev.sol >= minSolExcursion && s - next.sol >= minSolExcursion * 0.55
        );
        let isCompound = false;
        if (!isValley && !isPeak && runLen >= 2) {
          const hasV = sols.some(
            (s) => prev.sol - s >= minSolExcursion && next.sol - s >= minSolExcursion * 0.55
          );
          const hasP = sols.some(
            (s) => s - prev.sol >= minSolExcursion && s - next.sol >= minSolExcursion * 0.55
          );
          const allDev = sols.every(
            (s) => Math.abs(s - prev.sol) >= minSolExcursion * 0.45
          );
          if (hasV && hasP && allDev) isCompound = true;
        }

        let match = false;
        let kind = "";
        if (typeToRepair === "valleys_and_compound" && (isValley || isCompound)) {
          match = true;
          kind = isValley ? "valley" : "compound";
        } else if (typeToRepair === "peaks" && isPeak) {
          match = true;
          kind = "peak";
        }

        if (match) {
          const getExpSol = (t) =>
            prev.sol + ((next.sol - prev.sol) * (t - prev.ts)) / (next.ts - prev.ts);
          const getExpUsd = (t) =>
            prev.usd + ((next.usd - prev.usd) * (t - prev.ts)) / (next.ts - prev.ts);

          for (let k = i; k < nextIdx; k++) {
            const h = history[k];
            const expSol = Math.round(getExpSol(h.ts) * 100000) / 100000;
            const expUsd = Math.round(getExpUsd(h.ts) * 100) / 100;

            // Align deployedSol so that the recomputing formula:
            // idleSol + deployedSol + unclaimedFeesSol + rentSol + tokensSol == newSol
            const currentSum =
              h.idle + h.dep + h.unclaimed + h.rent + h.tokens;
            const solDiff = expSol - currentSum;
            const newDeployed = Math.max(0, Math.round((h.dep + solDiff) * 100000) / 100000);
            let newIdle = h.idle;
            // If deployed was clamped to 0, absorb remainder in idle
            const remainingDiff = expSol - (newIdle + newDeployed + h.unclaimed + h.rent + h.tokens);
            if (Math.abs(remainingDiff) > 0.00001) {
              newIdle = Math.round((newIdle + remainingDiff) * 100000) / 100000;
            }

            const updatedSnapshot = {
              ...h.rawSnapshot,
              idleSol: newIdle,
              deployedSol: newDeployed,
              totalSol: expSol,
              totalUsd: expUsd,
              restored: true,
              restore_reason: `${kind} anomaly restoration (interpolated between #${prev.id} and #${next.id})`,
            };

            repairedRecords.push({
              id: h.id,
              ts: new Date(h.ts).toISOString(),
              kind,
              prevAnchor: { id: prev.id, sol: prev.sol },
              nextAnchor: { id: next.id, sol: next.sol },
              origSol: h.origSol,
              newSol: expSol,
              origUsd: h.origUsd,
              newUsd: expUsd,
              origRaw: h.rawSnapshot,
              updatedSnapshot,
            });

            h.sol = expSol;
            h.usd = expUsd;
            h.modified = true;
            count++;
          }
          i = nextIdx - 1;
          break;
        }
      }
    }
    return count;
  }

  // Pass 1: valleys & compound anomalies
  const p1 = scanAndRepair("valleys_and_compound");
  // Pass 2: isolated peaks against stabilized baselines
  const p2 = scanAndRepair("peaks");

  console.log(`Identified ${repairedRecords.length} anomalous samples to restore (Pass 1: ${p1}, Pass 2: ${p2}).`);

  for (const r of repairedRecords) {
    console.log(
      `  [${r.kind.toUpperCase()}] id=${r.id} @ ${r.ts} | Sol: ${r.origSol} -> ${r.newSol} (usd: ${r.origUsd} -> ${r.newUsd})`
    );
  }

  if (!isApply) {
    console.log("\n[DRY RUN COMPLETE] No changes were written to the database. Use --apply to execute.");
    return;
  }

  // --- APPLY PHASE ---
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 8); // YYYYMMDD
  const backupTable = `balance_history_backup_${stamp}`;

  console.log(`\nCreating backup table in PostgreSQL: ${backupTable}...`);
  await query(`CREATE TABLE IF NOT EXISTS ${backupTable} AS SELECT * FROM balance_history;`);
  const { rows: bkRows } = await query(`SELECT count(*)::int AS count FROM ${backupTable};`);
  console.log(`Backup table verified with ${bkRows[0]?.count} rows.`);

  // Save offline pre-restore JSON archive
  const backupDir = fs.existsSync("/opt/meridian-backups") ? "/opt/meridian-backups" : path.join(__dirname, "..");
  const fullStamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonBackupPath = path.join(backupDir, `balance_history_prerestore_${fullStamp}.json`);
  const preRestoreArchive = repairedRecords.map((r) => ({
    id: r.id,
    ts: r.ts,
    origSol: r.origSol,
    origUsd: r.origUsd,
    snapshot: r.origRaw,
  }));
  fs.writeFileSync(jsonBackupPath, JSON.stringify(preRestoreArchive, null, 2));
  console.log(`Saved pre-restore JSON archive to ${jsonBackupPath}.`);

  console.log("\nExecuting atomic update transaction...");
  await withTransaction(async (client) => {
    for (const r of repairedRecords) {
      await client.query(
        "UPDATE balance_history SET total_usd = $1, snapshot = $2::jsonb WHERE id = $3",
        [r.newUsd, JSON.stringify(r.updatedSnapshot), r.id]
      );
    }
  });

  console.log(`Successfully updated ${repairedRecords.length} rows in balance_history.`);

  // Post-check
  const ids = repairedRecords.map((r) => r.id);
  const { rows: verifyRows } = await query(
    "SELECT id, total_usd, snapshot->>'totalSol' as sol, snapshot->>'restored' as restored FROM balance_history WHERE id = ANY($1::bigint[])",
    [ids]
  );
  const allVerified = verifyRows.every((vr) => vr.restored === "true");
  console.log(`Verification: ${verifyRows.length}/${repairedRecords.length} rows confirmed with restored=true. (allVerified=${allVerified})`);
  console.log("[RESTORATION COMPLETE]");
}

main()
  .catch((err) => {
    console.error("Migration error:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
