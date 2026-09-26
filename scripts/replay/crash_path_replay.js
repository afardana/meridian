#!/usr/bin/env node
/**
 * scripts/replay/crash_path_replay.js — OFFLINE, read-only replay of the downside fast
 * paths (crash-below + in-range rug) over price_ticks, with parameter variants and a
 * per-pair-profile breakdown. SELECT statements only; no Meridian module besides the
 * env loader. Run on the VM:
 *   cd /opt/meridian && node scripts/replay/crash_path_replay.js [--days 30] [--json out.json]
 *
 * What is modelled (mirrors index.js):
 *   • crash-below: trail of bins over crashWindowSec; gates = below lower edge, distance
 *     ≥ D, trail span ≥ S, net drop > 0, velocity ≥ V b/min. Poller mode confirms on N
 *     consecutive DISTINCT poller valuations (a poll without the signal resets the
 *     streak — registerExitSignal semantics). Socket mode feeds socket bin events AND
 *     poller bins into the trail, arms on the first gate-passing event and fires once
 *     N gate-passing events have been seen spanning ≥ X s (the shadow twin's rule).
 *   • in-range rug: poller trail over rugWindowSec, gates = in range, pnl ≤ P, span ≥ S,
 *     drop ≥ M bins, velocity ≥ V; poller confirm N. Optional socket-fed trail.
 *   • stop loss −15 on 2 distinct valuations as the backstop in every variant.
 * A fire realises the PnL of the first poller valuation ≥ LATENCY s after the fire
 * (P(DOOM)-SOL 2026-09-26: confirm → on-chain close 17 s). A fire after the recorded
 * close is "not reached"; a variant that does not fire on a position the live crash/rug
 * path closed is "missed" (its counterfactual beyond the close is unobservable).
 * Excluded: hold-mode positions (no rule touches them) and positions rebalanced in
 * place (their row carries only the final range).
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import "../../envcrypt.js";

const require = createRequire(import.meta.url);
const { Client } = require("pg");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const DAYS = Number(opt("--days", 30));
const JSON_OUT = opt("--json", null);
const LATENCY_S = Number(opt("--latency", 15));
const STOP = -15;

const CRASH = (o) => ({ kind: "crash", W: 90, D: 8, S: 9, V: 12, N: 3, mode: "poller", X: 0, ...o });
const RUG = (o) => ({ kind: "rug", W: 300, S: 60, M: 10, V: 12, P: -3, N: 3, socketTrail: false, ...o });
const CRASH_VARIANTS = {
  "live (poller N3 D8 V12)": CRASH({}),
  "poller N2": CRASH({ N: 2 }),
  "poller N1": CRASH({ N: 1 }),
  "poller N2 D4": CRASH({ N: 2, D: 4 }),
  "poller N3 V16": CRASH({ V: 16 }),
  "poller N3 V8": CRASH({ V: 8 }),
  "socket twin (N3 X15)": CRASH({ mode: "socket", N: 3, X: 15 }),
  "socket N3 X5": CRASH({ mode: "socket", N: 3, X: 5 }),
  "socket N2 X0": CRASH({ mode: "socket", N: 2, X: 0 }),
  "socket N1 (arm)": CRASH({ mode: "socket", N: 1, X: 0 }),
  "socket N2 X0 D4": CRASH({ mode: "socket", N: 2, X: 0, D: 4 }),
  "socket N2 X0 V16": CRASH({ mode: "socket", N: 2, X: 0, V: 16 }),
};
const RUG_VARIANTS = {
  "live (W300 M10 V12 P-3 N3)": RUG({}),
  "N2": RUG({ N: 2 }),
  "N1": RUG({ N: 1 }),
  "socket trail N2": RUG({ N: 2, socketTrail: true }),
  "P-2 N2": RUG({ P: -2, N: 2 }),
  "V10 M8 N2": RUG({ V: 10, M: 8, N: 2 }),
  "W120 S30 M8 N2 socket": RUG({ W: 120, S: 30, M: 8, N: 2, socketTrail: true }),
};

function segOf(p) {
  const age = p.token_age_hours != null ? Number(p.token_age_hours) : null;
  const tvl = p.entry_tvl != null ? Number(p.entry_tvl) : null;
  const vol = p.volatility != null ? Number(p.volatility) : null;
  return {
    age: age == null ? "age ?" : age < 24 ? "age <24h" : age < 168 ? "age 1–7d" : "age >7d",
    tvl: tvl == null ? "tvl ?" : tvl < 50_000 ? "tvl <50k" : tvl < 100_000 ? "tvl 50–100k" : "tvl ≥100k",
    vol: vol == null ? "vol ?" : vol < 3 ? "vol <3" : vol < 6 ? "vol 3–6" : "vol ≥6",
    who: p.adopted ? "adopted" : "bot",
    mcap: p.entry_mcap == null ? "mcap ?" : Number(p.entry_mcap) < 1_000_000 ? "mcap <1M" : Number(p.entry_mcap) < 5_000_000 ? "mcap 1–5M" : "mcap ≥5M",
  };
}

function realizedAt(polls, tFire) {
  const target = tFire + LATENCY_S * 1000;
  for (const v of polls) if (v.t >= target) return v.pnl;
  return polls.length ? polls[polls.length - 1].pnl : null;
}

function crashGates(trail, bin, lower, c) {
  if (!(bin < lower)) return null;
  const dist = lower - bin;
  if (dist < c.D) return null;
  if (trail.length < 2) return null;
  const first = trail[0], last = trail[trail.length - 1];
  const span = (last.t - first.t) / 1000;
  if (span < c.S) return null;
  const drop = first.bin - last.bin;
  if (drop <= 0) return null;
  const v = drop / (span / 60);
  return v >= c.V ? { dist, drop, span, v } : null;
}

function simulateCrash(pos, events, polls, c) {
  const trail = [];
  let streak = 0, lastKey = null, armedAt = null, confirms = 0;
  for (const e of events) {
    if (c.mode === "poller" && e.src !== "poller") continue;
    trail.push({ t: e.t, bin: e.bin });
    while (trail.length && trail[0].t < e.t - c.W * 1000) trail.shift();
    const hit = crashGates(trail, e.bin, pos.lower, c);
    if (c.mode === "poller") {
      const key = `${e.pnl}|${e.bin}`; const fresh = key !== lastKey; lastKey = key;
      if (!hit) { streak = 0; continue; }
      if (fresh) streak++;
      if (streak >= c.N) return { t: e.t, pnl: realizedAt(polls, e.t), dist: hit.dist };
    } else {
      if (e.bin >= pos.lower) { armedAt = null; confirms = 0; continue; }
      if (!hit) continue;
      if (armedAt == null) { armedAt = e.t; confirms = 1; } else confirms++;
      if (confirms >= c.N && (e.t - armedAt) / 1000 >= c.X) return { t: e.t, pnl: realizedAt(polls, e.t), dist: hit.dist };
    }
  }
  return null;
}

function simulateRug(pos, events, polls, r) {
  const trail = [];
  let streak = 0, lastKey = null, lastPnl = null;
  for (const e of events) {
    if (e.src === "poller") lastPnl = e.pnl;
    if (e.src !== "poller" && !r.socketTrail) continue;
    trail.push({ t: e.t, bin: e.bin });
    while (trail.length && trail[0].t < e.t - r.W * 1000) trail.shift();
    if (e.src !== "poller") continue; // the pnl gate is evaluated on valuations
    const key = `${e.pnl}|${e.bin}`; const fresh = key !== lastKey; lastKey = key;
    let ok = e.bin >= pos.lower && lastPnl != null && lastPnl <= r.P && trail.length >= 2;
    if (ok) {
      const first = trail[0], last = trail[trail.length - 1];
      const span = (last.t - first.t) / 1000, drop = first.bin - last.bin;
      ok = span >= r.S && drop >= r.M && drop / (span / 60) >= r.V;
    }
    if (!ok) { streak = 0; continue; }
    if (fresh) streak++;
    if (streak >= r.N) return { t: e.t, pnl: realizedAt(polls, e.t) };
  }
  return null;
}

/**
 * Unified downside detector (proposal): ONE streak across the lower edge, velocity measured
 * peak-to-current inside the window (a flat stretch no longer dilutes a sudden drop), and
 * optional thresholds scaled by the pair's own causal noise estimate:
 *   noise = p95 of ordinary 60 s in-range drops over the previous 30 min (excluding the
 *   last 2 min), prior `u.prior` until 20 samples exist.
 *   V_eff = clamp(k × noise, vMin, vMax); D_eff = clamp(round(noise / 2), dMin, 8)
 *   below range: dist ≥ D_eff and peak-velocity ≥ V_eff
 *   in range:    pnl ≤ P, drop ≥ M, peak-velocity ≥ V_eff (window W_in)
 *   confirm N distinct valuations (poller) / N events spanning ≥ X s (socket);
 *   violent bypass: velocity ≥ 2 × V_eff fires on the first confirming observation.
 */
function simulateUnified(pos, events, polls, u) {
  const trail = [];
  const noiseLog = []; // [t, drop60]
  let streak = 0, lastKey = null, armedAt = null, confirms = 0, lastPnl = null;
  for (const e of events) {
    if (e.src === "poller") lastPnl = e.pnl;
    if (u.mode === "poller" && e.src !== "poller") continue;
    trail.push({ t: e.t, bin: e.bin });
    const wMax = Math.max(u.W, u.Win);
    while (trail.length && trail[0].t < e.t - wMax * 1000) trail.shift();
    // ordinary-dip log (healthy, in range)
    let max60 = -Infinity;
    for (let i = trail.length - 1; i >= 0 && trail[i].t >= e.t - 60_000; i--) max60 = Math.max(max60, trail[i].bin);
    if (e.bin >= pos.lower && (lastPnl == null || lastPnl > -3)) noiseLog.push([e.t, max60 - e.bin]);
    let noise = u.prior;
    if (u.adaptive) {
      const vals = [];
      for (let i = noiseLog.length - 1; i >= 0 && noiseLog[i][0] >= e.t - 30 * 60_000; i--) if (noiseLog[i][0] <= e.t - 120_000) vals.push(noiseLog[i][1]);
      if (vals.length >= 20) { vals.sort((a, b) => a - b); noise = Math.max(1, vals[Math.floor(vals.length * 0.95)]); }
    }
    const V = u.adaptive ? Math.min(u.vMax, Math.max(u.vMin, u.k * noise)) : u.V;
    const D = u.adaptive ? Math.min(8, Math.max(u.dMin, Math.round(noise / 2))) : u.D;
    const inRange = e.bin >= pos.lower;
    const W = inRange ? u.Win : u.W;
    let peak = -Infinity, peakT = e.t;
    for (let i = trail.length - 1; i >= 0 && trail[i].t >= e.t - W * 1000; i--) if (trail[i].bin > peak) { peak = trail[i].bin; peakT = trail[i].t; }
    const drop = peak - e.bin, span = (e.t - peakT) / 1000;
    const vel = span >= u.S ? drop / (span / 60) : 0;
    let hit = false;
    if (!inRange) hit = pos.lower - e.bin >= D && drop > 0 && vel >= V;
    else hit = lastPnl != null && lastPnl <= u.P && drop >= u.M && vel >= V;
    const violent = hit && u.violent && vel >= 2 * V;
    if (u.mode === "poller") {
      const key = `${e.pnl}|${e.bin}`; const fresh = key !== lastKey; lastKey = key;
      if (!hit) { streak = 0; continue; }
      if (fresh) streak++;
      if (streak >= (violent ? 1 : u.N)) return { t: e.t, pnl: realizedAt(polls, e.t), V, D };
    } else {
      if (!hit) { if (inRange && drop <= 0) { armedAt = null; confirms = 0; } continue; }
      if (armedAt == null) { armedAt = e.t; confirms = 1; } else confirms++;
      if (violent || (confirms >= u.N && (e.t - armedAt) / 1000 >= u.X)) return { t: e.t, pnl: realizedAt(polls, e.t), V, D };
    }
  }
  return null;
}
const UNI = (o) => ({ mode: "poller", W: 90, Win: 300, S: 9, V: 12, D: 8, M: 10, P: -3, N: 3, X: 0, adaptive: false, prior: 6, k: 2.5, vMin: 6, vMax: 20, dMin: 3, violent: false, ...o });
const UNIFIED_VARIANTS = {
  "U1 unified+peak, fixed V12 D8 N3": UNI({}),
  "U2 unified+peak, fixed V12 D4 N2": UNI({ D: 4, N: 2 }),
  "U3 adaptive k2.5 N2 +violent": UNI({ adaptive: true, N: 2, violent: true }),
  "U4 adaptive k2.5 N2 +violent, socket": UNI({ adaptive: true, N: 2, violent: true, mode: "socket" }),
  "U5 adaptive k2 N2 +violent": UNI({ adaptive: true, k: 2, N: 2, violent: true }),
  "U6 adaptive k3 N2 +violent": UNI({ adaptive: true, k: 3, N: 2, violent: true }),
  "U7 adaptive k2.5 N3": UNI({ adaptive: true, N: 3 }),
  "U8 adaptive k2.5 N2 +violent vMin8": UNI({ adaptive: true, N: 2, violent: true, vMin: 8 }),
};

function simulateStop(polls) {
  let streak = 0, lastKey = null;
  for (const v of polls) {
    const key = `${v.pnl}|${v.bin}`; const fresh = key !== lastKey; lastKey = key;
    if (v.pnl > STOP) { streak = 0; continue; }
    if (fresh) streak++;
    if (streak >= 2) return { t: v.t, pnl: realizedAt(polls, v.t) };
  }
  return null;
}

/** Pool "noise": the fastest in-range 60 s bin drop seen while the position was healthy
 *  (pnl > −3), p95 over rolling windows — what an ordinary dip looks like for this pair. */
function noiseProfile(events, lower) {
  const drops = [];
  const win = [];
  for (const e of events) {
    win.push(e);
    while (win.length && win[0].t < e.t - 60_000) win.shift();
    if (e.bin < lower) continue;
    const maxBin = Math.max(...win.map((w) => w.bin));
    drops.push(maxBin - e.bin);
  }
  if (!drops.length) return null;
  drops.sort((a, b) => a - b);
  return { p95: drops[Math.floor(drops.length * 0.95)], p99: drops[Math.floor(drops.length * 0.99)], max: drops[drops.length - 1] };
}

async function main() {
  const c = new Client({ host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE });
  await c.connect();
  const { rows: positions } = await c.query(
    `select position_address, pair, data->>'pool' as pool, lower_bin as lower, upper_bin as upper, deployed_at, closed_at,
            (data->>'exit_pnl_pct')::float as exit_pnl, coalesce(data->>'close_reason','') as reason,
            coalesce((data->>'hold_mode')::bool,false) as hold, coalesce((data->>'adopted')::bool,false) as adopted,
            coalesce((data->>'amount_sol')::float,0) as amount, (data->>'token_age_hours_at_deploy')::float as token_age_hours,
            (data->>'entry_tvl')::float as entry_tvl, (data->>'volatility')::float as volatility,
            coalesce((data->>'rebalance_count')::int,0) + coalesce((data->>'straddle_count')::int,0) as rebal,
            data->'notes' as notes, (data->>'entry_mcap')::float as entry_mcap
       from positions where closed and closed_at > now() - make_interval(days => $1) order by closed_at`, [DAYS]);
  const out = [];
  let excluded = { hold: 0, rebal: 0, noticks: 0 };
  for (const p of positions) {
    if (p.hold) { excluded.hold++; continue; }
    if (p.rebal > 0) { excluded.rebal++; continue; }
    const { rows: pr } = await c.query(
      `select extract(epoch from ts)*1000 as t, active_bin as bin, pnl_pct as pnl from price_ticks
        where position_address=$1 and source='poller' and pnl_pct is not null order by ts`, [p.position_address]);
    if (pr.length < 5) { excluded.noticks++; continue; }
    // Live valuation guards: a reading ≤ −90 % while the position holds value, or a
    // positive jump > 15 pp between two valuations, is suspect and never acted on.
    const polls = [];
    let prevPnl = null;
    for (const r of pr) {
      const pnl = Number(r.pnl);
      const suspect = pnl <= -90 || (prevPnl != null && pnl - prevPnl > 15);
      if (!suspect) polls.push({ t: Number(r.t), bin: Number(r.bin), pnl, src: "poller" });
      prevPnl = pnl;
    }
    if (polls.length < 5) { excluded.noticks++; continue; }
    const { rows: sr } = await c.query(
      `select extract(epoch from ts)*1000 as t, active_bin as bin from price_ticks
        where pool_address=$1 and source='socket' and ts between $2 and $3 order by ts`, [p.pool, p.deployed_at, p.closed_at]);
    const events = [...polls, ...sr.map((r) => ({ t: Number(r.t), bin: Number(r.bin), src: "socket" }))].sort((a, b) => a.t - b.t || (a.src === "poller" ? 1 : -1));
    const closedAt = new Date(p.closed_at).getTime();
    const actual = Number.isFinite(p.exit_pnl) ? p.exit_pnl : polls[polls.length - 1].pnl;
    let reason = p.reason;
    if (!reason && Array.isArray(p.notes)) {
      for (let i = p.notes.length - 1; i >= 0; i--) { const m = /^Closed at [^:]+:\s*(.*)$/s.exec(String(p.notes[i])); if (m) { reason = m[1]; break; } }
    }
    p.reason = reason || "";
    const liveFast = /crash-below|in-range rug/i.test(p.reason);
    const stop = simulateStop(polls);
    const rec = { pair: p.pair, adopted: p.adopted, amount: p.amount, actual, liveFast, reason: p.reason.slice(0, 60), seg: segOf(p), noise: noiseProfile(events, Number(p.lower)), crash: {}, rug: {} };
    const pos = { lower: Number(p.lower) };
    for (const [k, v] of Object.entries(CRASH_VARIANTS)) rec.crash[k] = simulateCrash(pos, events, polls, v);
    for (const [k, v] of Object.entries(RUG_VARIANTS)) rec.rug[k] = simulateRug(pos, events, polls, v);
    rec.stop = stop;
    rec.uni = {};
    for (const [k, v] of Object.entries(UNIFIED_VARIANTS)) rec.uni[k] = simulateUnified(pos, events, polls, v);
    rec.closedAt = closedAt;
    out.push(rec);
  }
  await c.end();

  // Evaluate a stack = {crash variant, rug variant} + stop backstop against the recorded close.
  // Outcome of a stack on one position: the first fire before the recorded close, else the
  // recorded exit. Scored against the SIMULATED live stack, so only decisions that differ
  // from what the live detectors do count as saves/truncations.
  const outcome = (r, ck, rk) => {
    const first = [r.crash[ck], r.rug[rk], r.stop].filter((f) => f && f.t < r.closedAt + 1000).sort((a, b) => a.t - b.t)[0];
    return first ? { pnl: first.pnl, t: first.t, fired: true } : { pnl: r.actual, t: r.closedAt, fired: false };
  };
  const evalStack = (ck, rk, rows) => {
    let fires = 0, saves = 0, trunc = 0, missed = 0, sol = 0, pp = 0; const worst = [], best = [];
    for (const r of rows) {
      const base = outcome(r, liveC, liveR);
      const o = outcome(r, ck, rk);
      if (o.fired) fires++;
      if (r.liveFast && !o.fired) missed++;
      if (o.t === base.t && o.pnl === base.pnl) continue;
      const d = o.pnl - base.pnl; pp += d; sol += d / 100 * r.amount;
      if (d > 0.05) saves++; else if (d < -0.05) trunc++;
      worst.push([d, r.pair]); best.push([d, r.pair]);
    }
    worst.sort((a, b) => a[0] - b[0]); best.sort((a, b) => b[0] - a[0]);
    return { fires, saves, trunc, missed, sol: +sol.toFixed(3), pp: +pp.toFixed(1), worst: worst[0] ? `${worst[0][1]} ${worst[0][0].toFixed(1)}pp` : "-", best: best[0] ? `${best[0][1]} +${best[0][0].toFixed(1)}pp` : "-" };
  };
  const liveC = "live (poller N3 D8 V12)", liveR = "live (W300 M10 V12 P-3 N3)";
  const outcomeU = (r, uk) => {
    const first = [r.uni[uk], r.stop].filter((f) => f && f.t < r.closedAt + 1000).sort((a, b) => a.t - b.t)[0];
    return first ? { pnl: first.pnl, t: first.t, fired: true } : { pnl: r.actual, t: r.closedAt, fired: false };
  };
  const evalUnified = (uk, rows) => {
    let fires = 0, saves = 0, trunc = 0, missed = 0, sol = 0, pp = 0; const ds = [];
    for (const r of rows) {
      const base = outcome(r, liveC, liveR);
      const o = outcomeU(r, uk);
      if (o.fired) fires++;
      if (r.liveFast && !o.fired) missed++;
      if (o.t === base.t && o.pnl === base.pnl) continue;
      const d = o.pnl - base.pnl; pp += d; sol += d / 100 * r.amount;
      if (d > 0.05) saves++; else if (d < -0.05) trunc++;
      ds.push([d, r.pair]);
    }
    ds.sort((a, b) => a[0] - b[0]);
    return { fires, saves, trunc, missed, sol: +sol.toFixed(3), pp: +pp.toFixed(1), worst: ds[0] ? `${ds[0][1]} ${ds[0][0].toFixed(1)}pp` : "-", best: ds.length ? `${ds[ds.length - 1][1]} +${ds[ds.length - 1][0].toFixed(1)}pp` : "-" };
  };
  const segments = { all: () => true };
  for (const dim of ["age", "tvl", "vol", "who", "mcap"]) for (const v of new Set(out.map((r) => r.seg[dim]))) segments[v] = (r) => r.seg[dim] === v;

  console.log(`# Crash-path replay — ${out.length} closes over ${DAYS} d (excluded: ${excluded.hold} hold, ${excluded.rebal} rebalanced, ${excluded.noticks} without ticks); latency ${LATENCY_S}s`);
  const fid = out.filter((r) => r.liveFast);
  console.log(`\n## Fidelity — live crash/rug closes (${fid.length}): recorded exit vs simulated live stack`);
  console.log("| pair | recorded | sim live | Δ | sim socket N2 X0 | sim poller N1 | noise p95 60s |");
  console.log("|---|---|---|---|---|---|---|");
  for (const r of fid) {
    const live = [r.crash[liveC], r.rug[liveR], r.stop].filter(Boolean).sort((a, b) => a.t - b.t)[0];
    const sock = [r.crash["socket N2 X0"], r.rug[liveR], r.stop].filter(Boolean).sort((a, b) => a.t - b.t)[0];
    const p1 = [r.crash["poller N1"], r.rug["N1"], r.stop].filter(Boolean).sort((a, b) => a.t - b.t)[0];
    console.log(`| ${r.pair} | ${r.actual.toFixed(2)} | ${live ? live.pnl.toFixed(2) : "—"} | ${live ? (live.pnl - r.actual).toFixed(2) : "—"} | ${sock ? sock.pnl.toFixed(2) : "—"} | ${p1 ? p1.pnl.toFixed(2) : "—"} | ${r.noise ? r.noise.p95 : "?"} |`);
  }
  for (const [segName, pred] of Object.entries(segments)) {
    const rows = out.filter(pred);
    if (rows.length < 3) continue;
    console.log(`\n## Segment ${segName} (n=${rows.length}, live crash/rug closes ${rows.filter((r) => r.liveFast).length})`);
    console.log("| crash variant (rug live) | fires | better than live | worse than live | missed | net ◎ vs live | net pp | worst | best |");
    console.log("|---|---|---|---|---|---|---|---|---|");
    for (const ck of Object.keys(CRASH_VARIANTS)) {
      const s = evalStack(ck, liveR, rows);
      console.log(`| ${ck} | ${s.fires} | ${s.saves} | ${s.trunc} | ${s.missed} | ${s.sol.toFixed(3)} | ${s.pp.toFixed(1)} | ${s.worst} | ${s.best} |`);
    }
    console.log("| **unified detector (replaces crash + rug)** | | | | | | | | |");
    for (const uk of Object.keys(UNIFIED_VARIANTS)) {
      const s = evalUnified(uk, rows);
      console.log(`| ${uk} | ${s.fires} | ${s.saves} | ${s.trunc} | ${s.missed} | ${s.sol.toFixed(3)} | ${s.pp.toFixed(1)} | ${s.worst} | ${s.best} |`);
    }
    console.log("| **rug variant (crash live)** | | | | | | | | |");
    for (const rk of Object.keys(RUG_VARIANTS)) {
      const s = evalStack(liveC, rk, rows);
      console.log(`| ${rk} | ${s.fires} | ${s.saves} | ${s.trunc} | ${s.missed} | ${s.sol.toFixed(3)} | ${s.pp.toFixed(1)} | ${s.worst} | ${s.best} |`);
    }
  }
  console.log("\n## Noise vs crash (fastest ordinary 60 s in-range drop, p95 per position, by segment)");
  for (const [segName, pred] of Object.entries(segments)) {
    const rows = out.filter(pred).filter((r) => r.noise);
    if (rows.length < 3) continue;
    const p = rows.map((r) => r.noise.p95).sort((a, b) => a - b);
    const q = (x) => p[Math.min(p.length - 1, Math.floor(p.length * x))];
    console.log(`- ${segName}: n=${rows.length} median p95 ${q(0.5)} bins/60s, p90 of p95 ${q(0.9)}, max ${p[p.length - 1]}`);
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out));
  console.error("done");
}
main().catch((e) => { console.error(e); process.exit(1); });
