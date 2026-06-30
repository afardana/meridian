/**
 * One-time migration: copy the legacy `kv_store` "balance-history" document
 * (a single jsonb array) into the normalized `balance_history` table.
 *
 * Idempotent — skips entries whose timestamp (created_at) is already present, so
 * it is safe to re-run (e.g. immediately before deploying the table-backed code
 * to catch the last few doc writes). Pass --force to TRUNCATE the table first.
 *
 * Requires PERSIST_BACKEND=pg. Safe to run while the agent is live: the old code
 * only writes the kv_store doc, the new code only writes the table — no overlap.
 *
 *   node scripts/migrate_balance_history_to_table.js [--force]
 */
import "../envcrypt.js";
import { usePg, query, closePool } from "../db/pool.js";

async function main() {
  if (!usePg()) {
    console.error("This migration requires PERSIST_BACKEND=pg.");
    process.exitCode = 1;
    return;
  }
  const force = process.argv.includes("--force");

  const { rows } = await query("SELECT doc FROM kv_store WHERE key = 'balance-history'");
  const history = rows[0]?.doc;
  if (!Array.isArray(history)) {
    console.error("No balance-history doc found in kv_store — nothing to migrate.");
    process.exitCode = 1;
    return;
  }
  console.log(`Source: kv_store 'balance-history' doc has ${history.length} entries.`);

  if (force) {
    await query("TRUNCATE balance_history RESTART IDENTITY");
    console.log("--force: truncated balance_history.");
  }

  // Existing timestamps in the table (for idempotency).
  const existing = new Set(
    (await query("SELECT created_at FROM balance_history")).rows.map(
      (r) => new Date(r.created_at).getTime(),
    ),
  );

  const toInsert = history.filter(
    (e) => e && e.ts && !existing.has(new Date(e.ts).getTime()),
  );
  console.log(`${toInsert.length} new entries to insert (${history.length - toInsert.length} already present).`);

  let inserted = 0;
  const CHUNK = 500;
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const batch = toInsert.slice(i, i + CHUNK);
    const values = [];
    const params = [];
    batch.forEach((e, j) => {
      const b = j * 3;
      values.push(`($${b + 1}, $${b + 2}::jsonb, $${b + 3})`);
      params.push(e.totalUsd ?? null, JSON.stringify(e), e.ts);
    });
    await query(
      `INSERT INTO balance_history (total_usd, snapshot, created_at) VALUES ${values.join(", ")}`,
      params,
    );
    inserted += batch.length;
  }

  const { rows: cnt } = await query("SELECT count(*)::int n, min(created_at) lo, max(created_at) hi FROM balance_history");
  console.log(`Inserted ${inserted}. Table now has ${cnt[0].n} rows (${cnt[0].lo} … ${cnt[0].hi}).`);
}

main()
  .catch((e) => { console.error("Migration failed:", e.message); process.exitCode = 1; })
  .finally(() => closePool());
