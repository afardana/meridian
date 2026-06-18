/**
 * PostgreSQL connection pool + persistence-backend switch.
 *
 * The whole DB layer is opt-in: persistence stays on the legacy JSON files
 * until PERSIST_BACKEND=pg. This lets us land the migration incrementally and
 * roll back instantly by flipping one env var.
 *
 * Connection params come from standard libpq env vars (PGHOST/PGPORT/PGUSER/
 * PGPASSWORD/PGDATABASE), so node-postgres picks them up with zero config.
 */

import pg from "pg";

/** True when the SQL backend is active. JSON remains the default. */
export function usePg() {
  return (process.env.PERSIST_BACKEND || "json").toLowerCase() === "pg";
}

let _pool = null;

/** Lazily-created shared pool. Small max — the VM shares RAM with NeoTasker + PG. */
export function getPool() {
  if (!_pool) {
    _pool = new pg.Pool({
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    _pool.on("error", (err) => {
      // Background client errors must never crash the process.
      console.error("[db] idle client error:", err.message);
    });
  }
  return _pool;
}

/** Run a query against the pool. */
export function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Run `fn` inside a transaction. `fn` receives a dedicated client; the
 * transaction commits on success and rolls back on any throw. Use this for all
 * read-modify-write paths (e.g. position updates with SELECT ... FOR UPDATE).
 */
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Close the pool (tests / graceful shutdown). */
export async function closePool() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
