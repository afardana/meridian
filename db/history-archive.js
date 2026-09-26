// History archive — nothing the agent records is deleted (operator, 2026-09-26).
//
// The document stores keep a bounded hot window (their jsonb doc is re-serialised on
// every write, so it must stay small); items that leave the window are appended to the
// `history_archive` table instead of being dropped. Ordered, fire-and-forget,
// fail-soft: an archive failure is logged and never blocks the caller. Under the json
// backend (dev/tests) archiving is a no-op.
import { usePg, query } from "./pool.js";

let _chain = Promise.resolve();

function tsOf(item, tsField) {
  const raw = item && tsField ? item[tsField] : null;
  if (raw == null) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Append items to history_archive.
 * @param {string} store   logical store name ("pool-snapshots", "decision-log", …)
 * @param {Array}  items   the items leaving the hot window
 * @param {object} [opts]  { key, tsField }
 */
export function archiveHistory(store, items, { key = null, tsField = "ts" } = {}) {
  if (!Array.isArray(items) || items.length === 0) return;
  if (!usePg()) return;
  const rows = items.filter((x) => x != null);
  _chain = _chain
    .then(async () => {
      for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        const params = [];
        const tuples = batch.map((item, j) => {
          params.push(store, key, tsOf(item, tsField), JSON.stringify(item));
          const b = j * 4;
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::jsonb)`;
        });
        await query(`INSERT INTO history_archive (store, key, item_ts, item) VALUES ${tuples.join(", ")}`, params);
      }
    })
    .catch((e) => console.error(`[history-archive] ${store} append failed (items kept in memory only): ${e.message}`));
}

export function flushHistoryArchive() {
  return _chain;
}
