// balance-history.js — AUM time-series persistence.
//
// Append-only samples of wallet AUM, written every ~5 min by index.js. Under the
// pg backend each sample is ONE row in the normalized `balance_history` table
// (incremental INSERT + count-based retention) — replacing the old single
// `kv_store` document that was re-serialized whole on every write (O(n) write
// amplification that grew unbounded). Under the json backend it stays a flat
// array file, for rollback parity.
import fs from "fs";
import { usePg, query } from "./db/pool.js";
import { repoPath } from "./repo-root.js";

const FILE = repoPath("balance-history.json");
const MAX_ENTRIES = 17280; // ~30 days at the ~2.5-3 min piggyback cadence (was 8640 @ 5-min)

function readFile() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeFile(arr) {
  const tmp = FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(arr));
  fs.renameSync(tmp, FILE);
}

/** Epoch-ms timestamp of the most recent sample, or null if there are none. */
export async function latestBalanceTs() {
  if (usePg()) {
    const { rows } = await query(
      "SELECT created_at FROM balance_history ORDER BY created_at DESC LIMIT 1",
    );
    return rows[0]?.created_at ? new Date(rows[0].created_at).getTime() : null;
  }
  const arr = readFile();
  const last = arr[arr.length - 1];
  return last?.ts ? new Date(last.ts).getTime() : null;
}

/**
 * Append one AUM sample. `entry` is the full snapshot object:
 *   { ts, idleSol, deployedSol, unclaimedFeesSol, rentSol, totalSol, solPriceUsd, totalUsd }
 * Under pg: one INSERT + count-based retention to MAX_ENTRIES. Under json: array append + slice.
 */
export async function recordBalanceEntry(entry) {
  if (usePg()) {
    await query(
      "INSERT INTO balance_history (total_usd, snapshot, created_at) VALUES ($1, $2::jsonb, $3)",
      [entry.totalUsd ?? null, JSON.stringify(entry), entry.ts],
    );
    // Count-based retention — keep the newest MAX_ENTRIES rows (small table, cheap).
    await query(
      "DELETE FROM balance_history WHERE id NOT IN " +
        "(SELECT id FROM balance_history ORDER BY created_at DESC LIMIT $1)",
      [MAX_ENTRIES],
    );
    return;
  }
  const arr = readFile();
  arr.push(entry);
  writeFile(arr.length > MAX_ENTRIES ? arr.slice(-MAX_ENTRIES) : arr);
}

/**
 * Read samples oldest→newest for analysis/CLI. `limit` caps to the newest N.
 * (The dashboard queries the table directly; this is the in-process accessor.)
 */
export async function getBalanceHistory({ limit = null } = {}) {
  if (usePg()) {
    const { rows } = limit
      ? await query(
          "SELECT snapshot FROM (SELECT snapshot, created_at FROM balance_history " +
            "ORDER BY created_at DESC LIMIT $1) t ORDER BY created_at ASC",
          [limit],
        )
      : await query("SELECT snapshot FROM balance_history ORDER BY created_at ASC");
    return rows.map((r) => r.snapshot);
  }
  const arr = readFile();
  return limit ? arr.slice(-limit) : arr;
}
