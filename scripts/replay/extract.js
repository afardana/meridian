#!/usr/bin/env node
/**
 * scripts/replay/extract.js — Shadow-replay dataset builder (OFFLINE, read-only).
 *
 * Loads the three recorded datasets that let us replay counterfactual EXIT rules
 * against positions we actually held, joins them, and writes a normalized dataset
 * to scripts/replay/dataset.json.
 *
 *   1. Closed-position performance records  — lessons.getAllPerformance()
 *   2. Per-position pool snapshot time series — pool-memory.getPoolSnapshots(pool)
 *   3. Post-close probes                      — perf.post_close (already on the perf record)
 *
 * ZERO runtime footprint on the live agent. It is a pure CONSUMER: it never calls
 * any store's .set()/save(). It primes the same caches cli.js does (so it works
 * under PERSIST_BACKEND=pg on the VM) and degrades gracefully to an empty dataset
 * on a dev machine with no .env / no pg (PERSIST_BACKEND defaults to json → empty
 * JSON files → empty datasets, reported honestly rather than crashing).
 *
 * Usage:
 *   node scripts/replay/extract.js            # write dataset.json
 *   node scripts/replay/extract.js --summary  # write + print coverage summary
 *   node scripts/replay/extract.js --out foo.json
 *
 * The join key is the position address. Each pool-memory snapshot carries a
 * `position` field; a perf record carries `position` (address) + `pool` (address).
 * We fetch getPoolSnapshots(perf.pool) and keep the snapshots whose `position`
 * matches, giving the per-position path series (oldest→newest).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(__dirname, "dataset.json");

function parseArgs(argv) {
  const args = { summary: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--summary") args.summary = true;
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a.startsWith("--out=")) args.out = path.resolve(a.slice("--out=".length));
  }
  return args;
}

/**
 * Prime the state + doc-store caches exactly like cli.js does. Required so the
 * synchronous getters below return real data under the pg backend; a no-op-ish
 * cheap load under json. Never throws for the "no data" case — a missing pg
 * connection would throw, which we surface as a clear message and exit 1.
 */
async function primeCaches() {
  const { initState } = await import("../../state.js");
  await initState();
  // Eagerly import every module that registers a doc store, so they are all
  // registered before initAllDocStores() primes them (mirrors cli.js).
  await import("../../lessons.js");
  await import("../../pool-memory.js");
  await import("../../decision-log.js");
  await import("../../signal-weights.js");
  await import("../../strategy-library.js");
  await import("../../smart-wallets.js");
  await import("../../token-blacklist.js");
  await import("../../dev-blocklist.js");
  await import("../../error-telemetry.js");
  const { initAllDocStores } = await import("../../db/doc-store.js");
  await initAllDocStores();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the normalized per-position replay records. Pure given the two loaders.
 */
function buildDataset(perfRecords, getPoolSnapshots) {
  const positions = [];

  for (const perf of perfRecords) {
    const posAddr = perf.position || null;
    const poolAddr = perf.pool || perf.pool_address || null;

    // Pull this pool's recorded snapshots, keep only this position's series.
    let series = [];
    if (poolAddr) {
      const all = getPoolSnapshots(poolAddr) || [];
      series = all
        .filter((s) => !posAddr || s.position == null || s.position === posAddr)
        // If some snapshots have position and some don't, prefer the matching
        // ones; but if NONE match the address yet the pool only ever held this
        // one position, the unmatched (position==null) rows are still ours.
        .map((s) => ({
          ts: s.ts ?? null,
          pnl_pct: num(s.pnl_pct),
          in_range: s.in_range ?? null,
          active_bin: num(s.active_bin),
          lower_bin: num(s.lower_bin),
          upper_bin: num(s.upper_bin),
          minutes_out_of_range: num(s.minutes_out_of_range),
          age_minutes: num(s.age_minutes),
          unclaimed_fees_usd: num(s.unclaimed_fees_usd),
          fee_per_tvl_24h: num(s.fee_per_tvl_24h),
          total_value_usd: num(s.total_value_usd),
          pool_tvl: num(s.pool_tvl),
          pool_volume: num(s.pool_volume),
          pool_fee_active_tvl_ratio: num(s.pool_fee_active_tvl_ratio),
        }))
        .filter((s) => s.ts != null);
      // If the address filter produced rows that mix matched + null-position and
      // there IS at least one address match, drop the null-position rows to avoid
      // cross-position contamination.
      const hasAddrMatch = all.some((s) => s.position === posAddr);
      if (hasAddrMatch) {
        series = all
          .filter((s) => s.position === posAddr)
          .map((s) => ({
            ts: s.ts ?? null,
            pnl_pct: num(s.pnl_pct),
            in_range: s.in_range ?? null,
            active_bin: num(s.active_bin),
            lower_bin: num(s.lower_bin),
            upper_bin: num(s.upper_bin),
            minutes_out_of_range: num(s.minutes_out_of_range),
            age_minutes: num(s.age_minutes),
            unclaimed_fees_usd: num(s.unclaimed_fees_usd),
            fee_per_tvl_24h: num(s.fee_per_tvl_24h),
            total_value_usd: num(s.total_value_usd),
            pool_tvl: num(s.pool_tvl),
            pool_volume: num(s.pool_volume),
            pool_fee_active_tvl_ratio: num(s.pool_fee_active_tvl_ratio),
          }))
          .filter((s) => s.ts != null);
      }
      series.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    }

    // Path features live on the perf record (copied from state.js at close).
    const path_features = {
      mfe_pnl_pct: num(perf.mfe_pnl_pct),
      mae_pnl_pct: num(perf.mae_pnl_pct),
      peak_pnl_pct: num(perf.peak_pnl_pct),
      max_bins_below: num(perf.max_bins_below),
      max_bins_above: num(perf.max_bins_above),
    };
    const hasPathFeatures =
      path_features.mfe_pnl_pct != null ||
      path_features.mae_pnl_pct != null ||
      path_features.max_bins_below != null ||
      path_features.max_bins_above != null;

    // Snapshot cadence stats — the honesty backbone. Median gap in minutes drives
    // the confidence tiering in replay.js.
    const gapsMin = [];
    for (let i = 1; i < series.length; i++) {
      const t0 = Date.parse(series[i - 1].ts);
      const t1 = Date.parse(series[i].ts);
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) {
        gapsMin.push((t1 - t0) / 60000);
      }
    }
    gapsMin.sort((a, b) => a - b);
    const medianGapMin = gapsMin.length
      ? gapsMin[Math.floor(gapsMin.length / 2)]
      : null;

    positions.push({
      position: posAddr,
      pool: poolAddr,
      pool_name: perf.pool_name ?? null,
      base_mint: perf.base_mint ?? null,
      deployed_at: perf.deployed_at ?? null,
      recorded_at: perf.recorded_at ?? null,
      minutes_held: num(perf.minutes_held),
      minutes_in_range: num(perf.minutes_in_range),
      range_efficiency: num(perf.range_efficiency),
      // canonical realized outcome (unit-agnostic; see CLAUDE.md unit landmine —
      // pnl_usd may be SOL-denominated in solMode. We only ever compare deltas
      // against this same field, so units cancel.)
      actual_pnl_pct: num(perf.pnl_pct),
      actual_pnl_usd: num(perf.pnl_usd),
      fees_earned_usd: num(perf.fees_earned_usd),
      close_reason: perf.close_reason ?? null,
      strategy: perf.strategy ?? null,
      volatility: num(perf.volatility),
      bin_step: num(perf.bin_step),
      bin_range: perf.bin_range ?? null,
      path_features,
      has_path_features: hasPathFeatures,
      post_close: perf.post_close ?? null,
      has_post_close: !!(perf.post_close && (perf.post_close.m30 || perf.post_close.m60 || perf.post_close.m180)),
      snapshots: series,
      n_snapshots: series.length,
      median_snapshot_gap_min: medianGapMin,
    });
  }

  return positions;
}

function summarize(positions) {
  const n = positions.length;
  const withSeries = positions.filter((p) => p.n_snapshots >= 2).length;
  const withPath = positions.filter((p) => p.has_path_features).length;
  const withPostClose = positions.filter((p) => p.has_post_close).length;
  const dense = positions.filter(
    (p) => p.median_snapshot_gap_min != null && p.median_snapshot_gap_min <= 5
  ).length;

  const dates = positions
    .map((p) => p.recorded_at)
    .filter(Boolean)
    .sort();
  const dateRange = dates.length
    ? { first: dates[0], last: dates[dates.length - 1] }
    : { first: null, last: null };

  return { n, withSeries, withPath, withPostClose, dense, dateRange };
}

function printSummary(s, outPath) {
  const line = "─".repeat(56);
  console.log(line);
  console.log("SHADOW-REPLAY DATASET COVERAGE");
  console.log(line);
  console.log(`positions (closed perf records) : ${s.n}`);
  console.log(`  with snapshot series (n>=2)   : ${s.withSeries}`);
  console.log(`  with path features            : ${s.withPath}`);
  console.log(`  with post-close probes        : ${s.withPostClose}`);
  console.log(`  dense series (<=5m median gap): ${s.dense}  (crash-rule evaluable)`);
  console.log(`date range (recorded_at)        : ${s.dateRange.first ?? "—"}  →  ${s.dateRange.last ?? "—"}`);
  console.log(line);
  console.log(`written → ${outPath}`);
  if (s.n === 0) {
    console.log("");
    console.log("NOTE: zero positions. On this dev machine there is typically no");
    console.log(".env / pg and the JSON stores are empty — this is expected. Run on");
    console.log("the VM (cd /opt/meridian && node scripts/replay/extract.js --summary)");
    console.log("where PERSIST_BACKEND=pg + real history live.");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  try {
    await primeCaches();
  } catch (e) {
    console.error("Failed to prime persistence caches:", e.message);
    console.error(
      "If you are on the VM this usually means pg is unreachable; check /opt/meridian/.env."
    );
    process.exit(1);
  }

  const { getAllPerformance } = await import("../../lessons.js");
  const { getPoolSnapshots } = await import("../../pool-memory.js");

  let perfRecords = [];
  try {
    perfRecords = getAllPerformance() || [];
  } catch (e) {
    console.error("getAllPerformance() failed:", e.message);
    perfRecords = [];
  }

  const positions = buildDataset(perfRecords, getPoolSnapshots);
  const summary = summarize(positions);

  const dataset = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    persist_backend: process.env.PERSIST_BACKEND || "json",
    counts: summary,
    positions,
  };

  fs.writeFileSync(args.out, JSON.stringify(dataset, null, 2));

  if (args.summary) {
    printSummary(summary, args.out);
  } else {
    console.log(`Wrote ${positions.length} positions → ${args.out}`);
  }

  // Flush any pending writes (there are none — we never mutate — but keeping the
  // process clean for pg pools). No flushState/flushAllDocStores CALL is made
  // because those would drain write chains we intentionally never touched; we
  // just let the pg pool idle-close on process exit.
  process.exit(0);
}

main();
