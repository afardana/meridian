/**
 * Minimal forward-only SQL migration runner.
 *
 *   node db/migrate.js          # apply all pending migrations
 *   node db/migrate.js --status # list applied / pending without applying
 *
 * Migrations are *.sql files in db/migrations/, applied in filename order.
 * Each runs inside a transaction and is recorded in schema_migrations.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getPool, closePool } from "./pool.js";

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

async function appliedSet(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);
  const { rows } = await pool.query("SELECT name FROM schema_migrations");
  return new Set(rows.map((r) => r.name));
}

function migrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
}

async function main() {
  const statusOnly = process.argv.includes("--status");
  const pool = getPool();
  const applied = await appliedSet(pool);
  const files = migrationFiles();
  const pending = files.filter((f) => !applied.has(f));

  if (statusOnly) {
    console.log("Applied:", [...applied].sort().join(", ") || "(none)");
    console.log("Pending:", pending.join(", ") || "(none)");
    return;
  }

  if (pending.length === 0) {
    console.log("No pending migrations.");
    return;
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log("Applied", file);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("FAILED", file, "-", err.message);
      throw err;
    } finally {
      client.release();
    }
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => closePool());
