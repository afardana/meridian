/**
 * One-shot importer: seed kv_store from the legacy non-state JSON files.
 *
 *   node db/import-kv.js          # import (skips stores already populated)
 *   node db/import-kv.js --force  # overwrite existing kv_store rows
 *
 * Run with production stopped so files and DB can't diverge mid-import.
 * The key names MUST match the makeDocStore() names in each module.
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import "../envcrypt.js";
import { query, closePool } from "./pool.js";

// key -> legacy file path
const STORES = {
  "lessons": repoPath("lessons.json"),
  "pool-memory": repoPath("pool-memory.json"),
  "decision-log": repoPath("decision-log.json"),
  "signal-weights": repoPath("signal-weights.json"),
  "strategy-library": repoPath("strategy-library.json"),
  "smart-wallets": repoPath("smart-wallets.json"),
  "token-blacklist": repoPath("token-blacklist.json"),
  "dev-blocklist": repoPath("dev-blocklist.json"),
  "balance-history": repoPath("balance-history.json"),
  "error-telemetry": repoPath("logs/error-telemetry.json"),
};

async function main() {
  const force = process.argv.includes("--force");
  for (const [key, file] of Object.entries(STORES)) {
    if (!fs.existsSync(file)) {
      console.log(`skip ${key} — no file`);
      continue;
    }
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.error(`skip ${key} — unreadable: ${e.message}`);
      continue;
    }
    const { rows } = await query("SELECT 1 FROM kv_store WHERE key = $1", [key]);
    if (rows.length && !force) {
      console.log(`skip ${key} — already in kv_store (use --force)`);
      continue;
    }
    await query(
      "INSERT INTO kv_store (key, doc, updated_at) VALUES ($1, $2::jsonb, now()) " +
        "ON CONFLICT (key) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()",
      [key, JSON.stringify(doc)]
    );
    const size = Array.isArray(doc) ? `${doc.length} items` : `${Object.keys(doc).length} keys`;
    console.log(`imported ${key} (${size})`);
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => closePool());
