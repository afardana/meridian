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
 * any store's .set()/save().
 *
 * ⚠ ENV LOADING (root cause of a real coverage bug): db/pool.js usePg() reads
 * process.env.PERSIST_BACKEND, which is only populated by envcrypt.js's
 * import-time loadEnv() (repo .env). index.js and cli.js import envcrypt.js
 * FIRST; if this script doesn't, it silently falls back to the LEGACY JSON
 * files — which on the VM are a stale cold copy frozen at the 2026-06-18 pg
 * cutover. Hence the static import below must stay the first meridian-module
 * import in this file.
 *
 * Usage:
 *   node scripts/replay/extract.js            # write dataset.json
 *   node scripts/replay/extract.js --summary  # write + print coverage summary
 *   node scripts/replay/extract.js --diagnose # per-position join/exclusion reasons
 *   node scripts/replay/extract.js --out foo.json
 *
 * Join: perf.position (address) ↔ snapshot.position within getPoolSnapshots(perf.pool).
 * Fallback for snapshots missing a position field: timestamp inside the position's
 * hold window [deployed_at − 10m, recorded_at + 10m] (join_method: "time_window").
 *
 * SNAPSHOT FIELD ERAS (git-dated; the join + replay must tolerate all of them):
 *   - since 621c687 (2026-03-20): ts, position, pnl_pct, in_range, minutes_out_of_range
 *   - since 486a832 (2026-06-16): active_bin, lower_bin, upper_bin (bin fields)
 *   - later                      : pool_tvl / pool_volume enrichment
 * Perf-record path features (mfe/mae/max_bins_*) exist only on closes after ~2026-07-05.
 */

import "../../envcrypt.js"; // MUST be first meridian import — loads .env → PERSIST_BACKEND (see header)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(__dirname, "dataset.json");
const TIME_JOIN_SLACK_MS = 10 * 60_000; // hold-window slack for the time-window fallback join

function parseArgs(argv) {
  const args = { summary: false, diagnose: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--summary") args.summary = true;
    else if (a === "--diagnose") args.diagnose = true;
    else if (a === "--out") args.out = path.resolve(argv[++i]);
    else if (a.startsWith("--out=")) args.out = path.resolve(a.slice("--out=".length));
  }
  return args;
}

/**
 * Prime the state + doc-store caches exactly like cli.js does. Required so the
 * synchronous getters below return real data under the pg backend; a cheap file
 * load under json.
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

function normalizeSnap(s) {
  return {
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
  };
}

/**
 * Join one perf record to its snapshot series.
 * Returns { series, join_method, reason } — reason is the exclusion/coverage
 * classification used by --diagnose:
 *   ok | no_pool_addr | no_pool_entry | no_matching_position_snaps | too_few_snaps
 */
function joinSnapshots(perf, getPoolSnapshots) {
  const posAddr = perf.position || null;
  const poolAddr = perf.pool || perf.pool_address || null;
  if (!poolAddr) return { series: [], join_method: null, reason: "no_pool_addr" };

  const all = getPoolSnapshots(poolAddr) || [];
  if (all.length === 0) {
    // getPoolSnapshots returns [] both for an absent pool entry and for an
    // entry whose 48-snapshot ring has been fully evicted by a later position
    // in the same pool — indistinguishable through the getter.
    return { series: [], join_method: null, reason: "no_pool_entry" };
  }

  // Preferred: exact position-address match (snapshot.position exists since 2026-03-20).
  let matched = posAddr ? all.filter((s) => s.position === posAddr) : [];
  let join_method = "position";

  // Fallback: snapshots with NO position field whose ts falls inside the hold
  // window. (Snapshots with a DIFFERENT position value belong to another
  // position in the same pool — never claim those.)
  if (matched.length === 0) {
    const t0 = Date.parse(perf.deployed_at ?? "");
    const t1 = Date.parse(perf.recorded_at ?? "");
    if (Number.isFinite(t0) && Number.isFinite(t1)) {
      matched = all.filter((s) => {
        if (s.position != null) return false;
        const t = Date.parse(s.ts ?? "");
        return Number.isFinite(t) && t >= t0 - TIME_JOIN_SLACK_MS && t <= t1 + TIME_JOIN_SLACK_MS;
      });
      join_method = matched.length ? "time_window" : null;
    } else {
      join_method = null;
    }
    if (matched.length === 0) {
      return { series: [], join_method: null, reason: "no_matching_position_snaps" };
    }
  }

  const series = matched
    .map(normalizeSnap)
    .filter((s) => s.ts != null)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  if (series.length < 2) return { series, join_method, reason: "too_few_snaps" };
  return { series, join_method, reason: "ok" };
}

/**
 * Load all price_ticks (pg only) grouped by pool_address. The table is a 72h
 * ring, so this is bounded and small. Returns { byPool: Map, available: bool }.
 * Pre-migration DBs (table missing, error 42P01) and any other error degrade to
 * an empty map — tick data is purely additive here, never fatal.
 */
async function loadTicksByPool(usePg) {
  if (!usePg()) return { byPool: new Map(), available: false };
  try {
    const { query } = await import("../../db/pool.js");
    const { rows } = await query(
      "SELECT pool_address, position_address, ts, active_bin, pnl_pct FROM price_ticks ORDER BY ts ASC",
    );
    const byPool = new Map();
    for (const r of rows) {
      if (!byPool.has(r.pool_address)) byPool.set(r.pool_address, []);
      byPool.get(r.pool_address).push(r);
    }
    return { byPool, available: true };
  } catch (e) {
    if (e.code !== "42P01") console.error("price_ticks load failed (non-fatal):", e.message);
    return { byPool: new Map(), available: false };
  }
}

/**
 * Attach the dense real-time tick series overlapping a position's hold window.
 * Poller ticks carry position_address (must match); socket ticks are pool-level
 * (position_address null) and are accepted for any position in the pool within
 * the window. Returns [{ ts, pnl_pct, active_bin }] oldest→newest.
 */
function joinTicks(perf, byPool) {
  const poolAddr = perf.pool || perf.pool_address || null;
  if (!poolAddr || !byPool.has(poolAddr)) return [];
  const posAddr = perf.position || null;
  const t0 = Date.parse(perf.deployed_at ?? "");
  const t1 = Date.parse(perf.recorded_at ?? "");
  const lo = Number.isFinite(t0) ? t0 - TIME_JOIN_SLACK_MS : -Infinity;
  const hi = Number.isFinite(t1) ? t1 + TIME_JOIN_SLACK_MS : Infinity;
  const out = [];
  for (const r of byPool.get(poolAddr)) {
    const t = new Date(r.ts).getTime();
    if (!Number.isFinite(t) || t < lo || t > hi) continue;
    if (r.position_address != null && posAddr != null && r.position_address !== posAddr) continue;
    out.push({ ts: r.ts, pnl_pct: num(r.pnl_pct), active_bin: num(r.active_bin) });
  }
  out.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return out;
}

/**
 * Build the normalized per-position replay records. Pure given the loaders.
 * `ticksByPool` is the Map from loadTicksByPool() (empty when unavailable).
 */
function buildDataset(perfRecords, getPoolSnapshots, ticksByPool = new Map()) {
  const positions = [];

  for (const perf of perfRecords) {
    const { series, join_method, reason } = joinSnapshots(perf, getPoolSnapshots);
    // Dense real-time ticks (data-capture ring, ≤72h). Additive: carried for the
    // next replay iteration; this phase does NOT change confidence tiering.
    const tick_series = joinTicks(perf, ticksByPool);

    // Path features live on the perf record (copied from state.js at close;
    // only present on closes after ~2026-07-05).
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

    // Era coverage: bin fields exist only on snapshots recorded after 2026-06-16.
    const nSnapsWithBins = series.filter((s) => s.active_bin != null && s.lower_bin != null).length;

    // Snapshot cadence stats — drive confidence tiering in replay.js.
    const gapsMin = [];
    for (let i = 1; i < series.length; i++) {
      const t0 = Date.parse(series[i - 1].ts);
      const t1 = Date.parse(series[i].ts);
      if (Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) gapsMin.push((t1 - t0) / 60000);
    }
    gapsMin.sort((a, b) => a - b);
    const medianGapMin = gapsMin.length ? gapsMin[Math.floor(gapsMin.length / 2)] : null;

    positions.push({
      position: perf.position || null,
      pool: perf.pool || perf.pool_address || null,
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
      n_snaps_with_bins: nSnapsWithBins,
      has_bins_fields: nSnapsWithBins > 0,
      median_snapshot_gap_min: medianGapMin,
      tick_series,
      n_ticks: tick_series.length,
      has_dense_ticks: tick_series.length > 0,
      join_method,
      join_reason: reason,
    });
  }

  return positions;
}

function summarize(positions, backend) {
  const n = positions.length;
  const withSeries = positions.filter((p) => p.n_snapshots >= 2).length;
  const withBins = positions.filter((p) => p.n_snapshots >= 2 && p.has_bins_fields).length;
  const withPath = positions.filter((p) => p.has_path_features).length;
  const withPostClose = positions.filter((p) => p.has_post_close).length;
  const dense = positions.filter(
    (p) => p.median_snapshot_gap_min != null && p.median_snapshot_gap_min <= 5
  ).length;
  const withTicks = positions.filter((p) => p.has_dense_ticks).length;

  const reasons = {};
  for (const p of positions) reasons[p.join_reason] = (reasons[p.join_reason] || 0) + 1;

  const dates = positions.map((p) => p.recorded_at).filter(Boolean).sort();
  const dateRange = dates.length
    ? { first: dates[0], last: dates[dates.length - 1] }
    : { first: null, last: null };

  return { backend, n, withSeries, withBins, withPath, withPostClose, dense, withTicks, reasons, dateRange };
}

function printSummary(s, outPath) {
  const line = "─".repeat(60);
  console.log(line);
  console.log("SHADOW-REPLAY DATASET COVERAGE");
  console.log(line);
  console.log(`persistence backend (resolved)  : ${s.backend}${s.backend === "json" ? "  ⚠ legacy files — STALE on the VM (frozen at 2026-06-18 pg cutover)" : ""}`);
  console.log(`positions (closed perf records) : ${s.n}`);
  console.log(`  with snapshot series (n>=2)   : ${s.withSeries}`);
  console.log(`  …with bin fields (post 06-16) : ${s.withBins}  (oor/crash replayable at high conf)`);
  console.log(`  with path features            : ${s.withPath}`);
  console.log(`  with post-close probes        : ${s.withPostClose}`);
  console.log(`  dense series (<=5m median gap): ${s.dense}  (crash-rule evaluable)`);
  console.log(`  with real-time ticks (72h ring): ${s.withTicks}  (price_ticks overlap — recent closes only)`);
  console.log(`date range (recorded_at)        : ${s.dateRange.first ?? "—"}  →  ${s.dateRange.last ?? "—"}`);
  const reasonStr = Object.entries(s.reasons).map(([k, v]) => `${k}=${v}`).join("  ");
  console.log(`join outcomes                   : ${reasonStr || "—"}`);
  console.log(line);
  console.log(`written → ${outPath}`);
  if (s.n === 0) {
    console.log("");
    console.log("NOTE: zero positions. On a dev machine with no .env/pg and empty JSON");
    console.log("stores this is expected. Run on the VM (cd /opt/meridian && node");
    console.log("scripts/replay/extract.js --summary) where PERSIST_BACKEND=pg + real");
    console.log("history live.");
  }
}

function printDiagnose(positions) {
  const line = "─".repeat(110);
  console.log("");
  console.log(line);
  console.log("PER-POSITION JOIN DIAGNOSIS (--diagnose)");
  console.log(line);
  console.log(
    "closed_at".padEnd(22) +
      "pool".padEnd(18) +
      "reason".padEnd(28) +
      "join".padEnd(13) +
      "snaps".padStart(6) +
      "bins".padStart(6) +
      "gap(m)".padStart(8) +
      "  close_reason"
  );
  for (const p of positions) {
    console.log(
      String(p.recorded_at ?? "—").slice(0, 19).padEnd(22) +
        String(p.pool_name ?? p.pool ?? "—").slice(0, 16).padEnd(18) +
        String(p.join_reason).padEnd(28) +
        String(p.join_method ?? "—").padEnd(13) +
        String(p.n_snapshots).padStart(6) +
        String(p.n_snaps_with_bins).padStart(6) +
        String(p.median_snapshot_gap_min != null ? p.median_snapshot_gap_min.toFixed(1) : "—").padStart(8) +
        "  " +
        String(p.close_reason ?? "").slice(0, 34)
    );
  }
  console.log(line);
  console.log("reasons: ok | no_pool_addr | no_pool_entry | no_matching_position_snaps | too_few_snaps");
  console.log("bins=0 with snaps>0 ⇒ pre-2026-06-16 era snapshots (no active/lower_bin) — oor replay falls back to");
  console.log("in_range + minutes_out_of_range (side inferred from close_reason, low confidence); crash replay");
  console.log("is not evaluable for that position.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let usePg;
  try {
    ({ usePg } = await import("../../db/pool.js"));
    await primeCaches();
  } catch (e) {
    console.error("Failed to prime persistence caches:", e.message);
    console.error(
      "If you are on the VM this usually means pg is unreachable; check /opt/meridian/.env."
    );
    process.exit(1);
  }
  const backend = usePg() ? "pg" : "json";

  const { getAllPerformance } = await import("../../lessons.js");
  const { getPoolSnapshots } = await import("../../pool-memory.js");

  let perfRecords = [];
  try {
    perfRecords = getAllPerformance() || [];
  } catch (e) {
    console.error("getAllPerformance() failed:", e.message);
    perfRecords = [];
  }

  const { byPool: ticksByPool } = await loadTicksByPool(usePg);
  const positions = buildDataset(perfRecords, getPoolSnapshots, ticksByPool);
  const summary = summarize(positions, backend);

  const dataset = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    persist_backend: backend,
    counts: summary,
    positions,
  };

  fs.writeFileSync(args.out, JSON.stringify(dataset, null, 2));

  if (args.summary || args.diagnose) {
    printSummary(summary, args.out);
  } else {
    console.log(`Wrote ${positions.length} positions → ${args.out} (backend: ${backend})`);
  }
  if (args.diagnose) printDiagnose(positions);

  // Read-only consumer: we never mutated a store, so there is nothing to flush.
  process.exit(0);
}

main();
