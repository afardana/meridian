#!/usr/bin/env node
// One-off: stamp `exit_family` on every lessons.performance record that lacks it.
// Run with the agent STOPPED (kv_store write-through race). Usage: node scripts/backfill_exit_family.js [--dry]
import "../envcrypt.js";
import { exitFamilyFromReason } from "../lessons.js";
import pg from "pg";
const dry = process.argv.includes("--dry");
const client = new pg.Client();
await client.connect();
const { rows } = await client.query("select doc from kv_store where key='lessons'");
const doc = rows[0].doc;
let n = 0; const counts = {};
for (const r of doc.performance || []) {
  if (!r.exit_family) { r.exit_family = exitFamilyFromReason(r.close_reason); n++; }
  counts[r.exit_family] = (counts[r.exit_family] || 0) + 1;
}
console.log(`records=${(doc.performance || []).length} stamped=${n}`, counts);
if (!dry && n > 0) {
  await client.query("update kv_store set doc=$1, updated_at=now() where key='lessons'", [doc]);
  console.log("written");
}
await client.end();
