/**
 * One-shot: project the legacy state_doc jsonb document into the normalized
 * state tables (positions / position_events / state_meta).
 *
 *   node db/import-state-normalized.js          # skip if positions table already has rows
 *   node db/import-state-normalized.js --force  # truncate + reimport
 *
 * Run with the agent stopped. After this, initState() reads from the normalized
 * tables; state_doc is left untouched as a rollback snapshot.
 */

import { query, withTransaction, closePool } from "./pool.js";
import { positionColumns } from "../state.js";

const META_KEYS = ["baseline", "cumulative_gas_sol", "_lastBriefingDate", "recentEvents", "lastUpdated"];

async function main() {
  const force = process.argv.includes("--force");

  const existing = await query("SELECT count(*)::int AS n FROM positions");
  if (existing.rows[0].n > 0 && !force) {
    console.error(`positions table already has ${existing.rows[0].n} rows — re-run with --force to reimport.`);
    process.exitCode = 1;
    return;
  }

  const docRes = await query("SELECT doc FROM state_doc WHERE id = 1");
  const doc = docRes.rows[0]?.doc;
  if (!doc || !doc.positions) {
    console.log("state_doc has no positions — nothing to import.");
    return;
  }

  const positions = Object.values(doc.positions);
  const events = Array.isArray(doc.recentEvents) ? doc.recentEvents : [];

  await withTransaction(async (client) => {
    if (force) {
      await client.query("TRUNCATE positions, position_events, state_meta");
    }
    for (const obj of positions) {
      const c = positionColumns(obj);
      await client.query(
        `INSERT INTO positions
           (position_address, pool_address, base_mint, pair, lower_bin, upper_bin,
            strategy, deployed_at, out_of_range_at, gas_sol, note, closed, closed_at, data, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb, now())
         ON CONFLICT (position_address) DO UPDATE SET data=EXCLUDED.data`,
        [obj.position, c.pool_address, c.base_mint, c.pair, c.lower_bin, c.upper_bin, c.strategy,
         c.deployed_at, c.out_of_range_at, c.gas_sol, c.note, c.closed, c.closed_at, JSON.stringify(obj)]
      );
    }
    for (const ev of events) {
      const { ts, action, position, ...payload } = ev;
      await client.query(
        "INSERT INTO position_events (position_address, kind, payload, created_at) VALUES ($1,$2,$3::jsonb,$4)",
        [position ?? null, action ?? "event", JSON.stringify(payload), ts ?? new Date().toISOString()]
      );
    }
    const meta = {
      baseline: doc.baseline ?? null,
      cumulative_gas_sol: doc.cumulative_gas_sol ?? null,
      _lastBriefingDate: doc._lastBriefingDate ?? null,
      recentEvents: events,
      lastUpdated: doc.lastUpdated ?? null,
    };
    for (const key of META_KEYS) {
      await client.query(
        "INSERT INTO state_meta (key, value, updated_at) VALUES ($1,$2::jsonb,now()) " +
          "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()",
        [key, JSON.stringify(meta[key] ?? null)]
      );
    }
  });

  const open = positions.filter((p) => !p.closed).length;
  console.log(`Imported ${positions.length} positions (${open} open), ${events.length} events, ${META_KEYS.length} meta keys into normalized tables.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => closePool());
