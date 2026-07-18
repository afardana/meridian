#!/usr/bin/env node
/**
 * adopt_orphans.js — one-shot manual re-import of orphaned on-chain positions.
 *
 * An orphan is a DLMM position that is live on-chain but has no open row in
 * local state — typically a deploy whose transaction bundle reported failure
 * (failed simulation on one instruction) yet actually landed the liquidity, so
 * trackPosition() was never called. reconcileStateWithChain() now auto-adopts
 * these every management cycle; this script does the same thing on demand
 * (e.g. to heal one immediately without waiting for a cycle, or from an
 * operator shell).
 *
 * Read-only against the chain; the only write is into local state (positions).
 * It NEVER touches on-chain liquidity — no close, no claim, no swap.
 *
 * Usage (run on the VM as the agent user so it shares .env/pg creds):
 *   node scripts/adopt_orphans.js            # adopt every untracked open on-chain position
 *   node scripts/adopt_orphans.js --dry-run  # report what WOULD be adopted, write nothing
 *
 * NOTE: the long-running PM2 `meridian` process keeps its own in-memory state
 * cache primed at boot, so a row written here won't be visible to it until it
 * restarts OR its own reconcile pass re-reads the chain and re-adopts (idempotent).
 * Preferred path in production is simply to deploy the code and let the agent's
 * reconcile heal the orphan in-process. Use this script for a manual/immediate
 * fix or when the agent is stopped.
 */

import "../envcrypt.js";
import { usePg } from "../db/pool.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const { initState, flushState, getTrackedPosition, adoptOrphanPosition } =
    await import("../state.js");
  const { initAllDocStores, flushAllDocStores } = await import("../db/doc-store.js");
  const { getMyPositions } = await import("../tools/dlmm.js");

  console.log(`[adopt] backend=${usePg() ? "pg" : "json"}${dryRun ? " (DRY RUN)" : ""}`);

  // Prime caches (mandatory under pg; harmless under json).
  await initState();
  await initAllDocStores();

  const live = await getMyPositions({ force: true, silent: true });
  const onChain = live?.positions || [];
  console.log(`[adopt] on-chain open positions: ${onChain.length}`);

  const orphans = onChain.filter((p) => {
    const tracked = getTrackedPosition(p.position);
    return !tracked || tracked.closed;
  });

  if (orphans.length === 0) {
    console.log("[adopt] no orphans — every on-chain position is already tracked open. Nothing to do.");
    await flushState();
    await flushAllDocStores();
    return;
  }

  console.log(`[adopt] found ${orphans.length} orphan(s):`);
  let adoptedCount = 0;
  for (const p of orphans) {
    console.log(`  • ${p.position} (${p.pair}) pool=${p.pool} bins=${p.lower_bin}..${p.upper_bin} age=${p.age_minutes}m in_range=${p.in_range}`);
    if (dryRun) continue;
    const ok = adoptOrphanPosition(p, { reason: "manual adopt_orphans.js" });
    if (ok) adoptedCount++;
    console.log(`    → ${ok ? "adopted" : "skip (already tracked open / no-op)"}`);
  }

  if (!dryRun) {
    await flushState();
    console.log(`[adopt] done — adopted ${adoptedCount}/${orphans.length}. State flushed to ${usePg() ? "pg" : "json"}.`);
  } else {
    console.log(`[adopt] DRY RUN — no state written. ${orphans.length} orphan(s) would be adopted.`);
  }
  await flushAllDocStores();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("[adopt] FAILED:", e.stack || e.message);
  process.exit(1);
});
