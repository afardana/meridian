/**
 * One-shot importer: seed the Postgres state_doc from the legacy state.json.
 *
 *   node db/import-state.js          # import (refuses if state_doc already populated)
 *   node db/import-state.js --force  # overwrite existing state_doc
 *
 * Run this with production stopped so the file and DB can't diverge mid-import.
 */

import fs from "fs";
import { repoPath } from "../repo-root.js";
import { query, closePool } from "./pool.js";

const STATE_FILE = repoPath("state.json");

async function main() {
  const force = process.argv.includes("--force");

  if (!fs.existsSync(STATE_FILE)) {
    console.log("No state.json found — nothing to import.");
    return;
  }
  const doc = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

  const { rows } = await query("SELECT doc FROM state_doc WHERE id = 1");
  const existing = rows[0]?.doc || {};
  const hasData = existing.positions && Object.keys(existing.positions).length > 0;
  if (hasData && !force) {
    console.error("Refusing to import: state_doc already has positions. Re-run with --force to overwrite.");
    process.exitCode = 1;
    return;
  }

  await query(
    "INSERT INTO state_doc (id, doc, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, updated_at = now()",
    [JSON.stringify(doc)]
  );

  const count = doc.positions ? Object.keys(doc.positions).length : 0;
  const open = doc.positions ? Object.values(doc.positions).filter((p) => !p.closed).length : 0;
  console.log(`Imported state.json into state_doc: ${count} positions (${open} open).`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => closePool());
