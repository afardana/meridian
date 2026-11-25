#!/usr/bin/env node
// Backfill baseline withdrawals the hourly scan missed (2026-11-25: three Jupiter "QR code pay"
// payments). The scan's checkpoint is already past them, so the classifier fix alone never books
// them. This re-walks the wallet's signatures in a window through the SAME classifier the scan
// uses (baseline-classify.js `classifyBaselineWithdrawal`) and adds only the withdrawals whose
// signature is not in the baseline yet — idempotent, a second run adds nothing.
//
// Default is a DRY RUN: chain reads + one read-only query, prints the table, writes nothing.
// --apply writes ONE row (state_meta 'baseline') in a transaction, and only with the agent AND
// meridian-watchdog STOPPED: the live agent keeps the baseline in its cache and rewrites every state_meta
// singleton on its next save, so a write made while it runs is silently overwritten (and the
// agent would not see it either). No Telegram message, no ROI notice: the next agent start reads
// the new total_withdrawn and every consumer (ROI line, ledger-truth, report, skimmer cap) uses
// it from there.
//
// Usage (on the VM, as angga, from /opt/meridian):
//   node scripts/backfill_baseline_payments.js --since 2026-11-25T00:00:00Z [--until <ISO>] [--apply]
// Never prints secrets or the RPC URL. pg backend only for --apply.
import "../envcrypt.js";
import fs from "fs";
import { execFileSync } from "child_process";
import { pathToFileURL } from "url";
import { classifyBaselineWithdrawal, planBaselineBackfill, applyBaselineBackfill } from "../baseline-classify.js";
import { repoPath } from "../repo-root.js";

// The agent (and its watchdog) must be seen stopped by PM2 AND the agent's heartbeat — written
// on every ~5 s PnL poll — must be this old (or absent).
export const HEARTBEAT_STALE_MS = 120_000;
const LIVE_PM2_STATES = new Set(["online", "launching", "stopping", "waiting restart", "one-launch-status"]);

/**
 * Is the agent stopped? Pure. `pm2List` = parsed `pm2 jlist` (or null when PM2 could not be
 * asked); `heartbeatAgeMs` = age of the agent's .heartbeat file (null = no file).
 * @returns {{ ok: boolean, reason: string }}
 */
export function agentStoppedVerdict(pm2List, heartbeatAgeMs) {
  if (!Array.isArray(pm2List)) return { ok: false, reason: "could not read `pm2 jlist` — run as the PM2 user (angga)" };
  const apps = pm2List.filter((a) => a?.name === "meridian");
  const live = apps.find((a) => LIVE_PM2_STATES.has(a?.pm2_env?.status));
  if (live) return { ok: false, reason: `PM2 app 'meridian' is ${live.pm2_env.status} — stop it first (pm2 stop meridian-watchdog meridian)` };
  // The watchdog restarts meridian once its heartbeat is 5 min stale (`pm2 restart` starts a
  // stopped app), which could land between the check and the write.
  const dog = pm2List.find((a) => a?.name === "meridian-watchdog" && LIVE_PM2_STATES.has(a?.pm2_env?.status));
  if (dog) return { ok: false, reason: `PM2 app 'meridian-watchdog' is ${dog.pm2_env.status} — it restarts a stopped agent after 5 min; stop it too (pm2 stop meridian-watchdog meridian)` };
  if (heartbeatAgeMs != null && heartbeatAgeMs < HEARTBEAT_STALE_MS) {
    return { ok: false, reason: `the agent heartbeat is ${Math.round(heartbeatAgeMs / 1000)} s old — wait until it is ≥ ${HEARTBEAT_STALE_MS / 1000} s` };
  }
  const st = apps.length ? apps.map((a) => a?.pm2_env?.status).join(",") : "not registered";
  return { ok: true, reason: `PM2 'meridian' ${st}; heartbeat ${heartbeatAgeMs == null ? "absent" : `${Math.round(heartbeatAgeMs / 1000)} s old`}` };
}

function readPm2List() {
  try { return JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 })); } catch { return null; }
}
function heartbeatAgeMs() {
  try { return Date.now() - fs.statSync(repoPath(".heartbeat")).mtimeMs; } catch { return null; }
}
function checkAgentStopped() { return agentStoppedVerdict(readPm2List(), heartbeatAgeMs()); }

const wib = (iso) => (iso ? new Date(Date.parse(iso) + 7 * 3600e3).toISOString().replace("T", " ").slice(0, 16) + " WIB" : "?");

function parseArgs(argv) {
  const out = { apply: argv.includes("--apply"), since: null, until: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--since") out.since = argv[++i];
    else if (argv[i] === "--until") out.until = argv[++i];
  }
  return out;
}

async function rpc(method, params) {
  const url = process.env.RPC_URL;
  if (!url) throw new Error("RPC_URL is not set");
  let lastErr;
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500)); continue; }
      const j = await r.json();
      if (j.error) { const e = new Error(`${method}: ${j.error.message || j.error.code}`); e.rpcCode = j.error.code; throw e; }
      return j.result;
    } catch (e) {
      if (e.rpcCode === -32015) throw e; // unsupported transaction version: retrying will not help
      lastErr = e; await new Promise((s) => setTimeout(s, 1000));
    }
  }
  throw new Error(`${method} failed after retries: ${lastErr?.message || "rate limited"}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const since = Date.parse(args.since);
  const until = args.until ? Date.parse(args.until) : Date.now();
  if (!Number.isFinite(since) || !Number.isFinite(until) || until <= since) {
    console.error("usage: backfill_baseline_payments.js --since <ISO> [--until <ISO>] [--apply]");
    process.exit(2);
  }
  if ((process.env.PERSIST_BACKEND || "json").toLowerCase() !== "pg") {
    console.error("PERSIST_BACKEND is not pg — this script reads and writes state_meta in Postgres only.");
    process.exit(2);
  }
  if (args.apply) {
    const v = checkAgentStopped();
    if (!v.ok) { console.error(`refusing --apply: ${v.reason}`); process.exit(3); }
    console.log(`agent check: ${v.reason}`);
  }

  const pg = (await import("pg")).default;
  const client = new pg.Client();
  await client.connect();
  try {
    const wRow = (await client.query("SELECT value FROM state_meta WHERE key = 'walletAddress'")).rows[0];
    const wallet = typeof wRow?.value === "string" ? wRow.value : null;
    if (!wallet) throw new Error("state_meta walletAddress is not set");

    // Signatures in the window, newest first, paged with `before`.
    const sigs = [];
    let before;
    for (let page = 0; page < 50; page++) {
      const rows = await rpc("getSignaturesForAddress", [wallet, { limit: 1000, before, commitment: "confirmed" }]);
      if (!rows?.length) break;
      let done = false;
      for (const r of rows) {
        const t = Number(r.blockTime) * 1000;
        if (!Number.isFinite(t) || t > until) continue;
        if (t < since) { done = true; break; }
        sigs.push(r);
      }
      if (done || rows.length < 1000) break;
      before = rows[rows.length - 1].signature;
    }
    sigs.reverse();
    console.log(`window ${new Date(since).toISOString()} → ${new Date(until).toISOString()}: ${sigs.length} signatures`);

    const found = [];
    const unreadable = [];
    for (const s of sigs) {
      if (s.err) continue; // failed: moved nothing but its fee
      await new Promise((r) => setTimeout(r, 120));
      const opts = (v) => [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: v, commitment: "confirmed" }];
      let tx = null;
      try { tx = await rpc("getTransaction", opts(0)); }
      catch (e) {
        // Version-1 transactions (seen in the wallet's history, third-party) need the higher setting.
        if (e.rpcCode !== -32015) throw e;
        tx = await rpc("getTransaction", opts(1)).catch(() => null);
        if (!tx) { unreadable.push(s); continue; }
      }
      if (!tx) throw new Error(`transaction ${s.signature} could not be fetched — nothing written; run again`);
      const signer = (tx.transaction?.message?.accountKeys || []).some((k) => (k?.pubkey ?? k) === wallet && k?.signer);
      if (!signer) continue;
      const w = classifyBaselineWithdrawal(tx, wallet, s);
      if (w) found.push(w);
    }

    const bRow = (await client.query("SELECT value FROM state_meta WHERE key = 'baseline'")).rows[0];
    const baseline = bRow?.value || {};
    const { rows, toAdd } = planBaselineBackfill(baseline, found);
    console.log("signature  | time             | SOL          | type         | status         | delivered");
    for (const r of rows) {
      const d = r.delivered_mint ? `${r.delivered_amount} ${r.delivered_mint.slice(0, 6)}… → ${r.delivered_to.slice(0, 6)}…` : "";
      console.log(`${r.signature.slice(0, 10)} | ${wib(r.timestamp)} | ◎${Number(r.amount).toFixed(9)} | ${(r.withdrawal_type || "send").padEnd(12)} | ${r.status.padEnd(14)} | ${d}`);
    }
    for (const s of unreadable) console.log(`unreadable (unsupported transaction version): ${s.signature} at ${wib(new Date(Number(s.blockTime) * 1000).toISOString())} — not classified, check it by hand`);
    const addSol = toAdd.reduce((s, w) => s + (Number(w.amount) || 0), 0);
    console.log(`would add ${toAdd.length} withdrawal(s), ◎${addSol.toFixed(9)}; total_withdrawn ${baseline.total_withdrawn ?? 0} → ${Math.round((Number(baseline.total_withdrawn || 0) + addSol) * 1e6) / 1e6}`);

    if (!args.apply) { console.log("(dry run — pass --apply, with the agent stopped, to write)"); return; }
    if (!toAdd.length) { console.log("nothing to add"); return; }

    // Re-check just before the write, then write against a locked, re-read row.
    const v = checkAgentStopped();
    if (!v.ok) throw new Error(`agent no longer stopped: ${v.reason} — nothing written`);
    await client.query("BEGIN");
    try {
      const fresh = (await client.query("SELECT value FROM state_meta WHERE key = 'baseline' FOR UPDATE")).rows[0]?.value;
      if (!fresh) throw new Error("state_meta baseline row missing");
      const again = planBaselineBackfill(fresh, found).toAdd;
      const next = applyBaselineBackfill(fresh, again);
      await client.query("UPDATE state_meta SET value = $1::jsonb, updated_at = now() WHERE key = 'baseline'", [JSON.stringify(next)]);
      await client.query("COMMIT");
      console.log(`written: ${again.length} withdrawal(s) added; total_withdrawn ${fresh.total_withdrawn ?? 0} → ${next.total_withdrawn}. Start the agent and its watchdog again now (pm2 start ecosystem.config.cjs --only meridian,meridian-watchdog).`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`backfill failed: ${e.message}`); process.exit(1); });
}
