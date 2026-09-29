#!/usr/bin/env node
/**
 * scripts/replay/trailing_bin_replay.js — OFFLINE, read-only replay of a bin-estimated
 * trailing-TP trigger (2026-09-29, JEANPHIL-SOL overshoot review).
 *
 * Live trailing acts on PnL VALUATIONS (~15 s apart, lagging the active bin): JEANPHIL fell
 * 10 bins in 15 s on the socket while the valuations still read 5.40 / 5.00 / 5.14 above the
 * 4.79 threshold, and the next one was 4.01 (0.78 pp overshoot). The proposal: between
 * valuations, estimate pnl from every active-bin change —
 *     est = lastValuation.pnl + slope × (bin − lastValuation.bin)
 * with slope = the position's own recent pnl-per-bin (least squares over the valuation pairs
 * of the last 60 min whose bin moved; ≥ 3 pairs, slope > 0, else no estimate) — and fire the
 * trailing TP when est ≤ threshold − margin has held for `hold` seconds.
 *
 * Baseline = the live rule on valuations (confirmed peak: 2 same-or-higher valuations or the
 * 10-min management confirm; arm at peak ≥ 2; fire at pnl ≤ peak − 1.5 on 2 valuations, or
 * at once when ≥ 0.5 pp below; adopted grace 60 min; stop −15 on 2 valuations). Each variant =
 * baseline + the bin trigger (it can only fire earlier or additionally). Outcome of a fire =
 * the first valuation ≥ LATENCY s after it (close tx latency, as in tick_exit_replay.js);
 * no fire = the recorded exit. Scored per position against the baseline outcome.
 * hold_mode positions are excluded (no rule touches them).
 *
 *   cd /opt/meridian && node scripts/replay/trailing_bin_replay.js [--days 30] [--json out.json]
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
const LATENCY_S = Number(opt("--latency", 10));
const SUSPECT_PP = 15;
const LIVE = { trigger: 2, drop: 1.5, overshoot: 0.5, stop: -15, graceMs: 60 * 60e3 };

const VARIANTS = [];
for (const margin of [0, 0.25, 0.5]) for (const hold of [0, 5, 10]) VARIANTS.push({ margin, hold, key: `m${margin}_h${hold}` });

function valuationsOf(rows) {
  const out = []; let lastKey = null, lastPnl = null;
  for (const t of rows) {
    if (t.src !== "poller" || t.pnl == null || !Number.isFinite(t.pnl)) continue;
    const key = `${t.pnl}|${t.bin}`;
    if (key === lastKey) continue;
    out.push({ t: t.t, pnl: t.pnl, bin: t.bin, suspect: lastPnl != null && t.pnl - lastPnl > SUSPECT_PP });
    lastKey = key; lastPnl = t.pnl;
  }
  return out;
}

function realizedAfter(vals, t) {
  for (const v of vals) if (v.t >= t + LATENCY_S * 1000) return v.pnl;
  return vals.length ? vals[vals.length - 1].pnl : null;
}

function slopeAt(vals, i) {
  let sxy = 0, sxx = 0, n = 0;
  const t = vals[i].t;
  for (let j = i; j > 0 && vals[j].t >= t - 60 * 60e3; j--) {
    const a = vals[j - 1], b = vals[j];
    if (a.suspect || b.suspect) continue;
    const db = b.bin - a.bin;
    if (!db) continue;
    sxy += (b.pnl - a.pnl) * db; sxx += db * db; n++;
  }
  if (n < 3 || sxx === 0) return null;
  const s = sxy / sxx;
  return s > 0 ? s : null;
}

/** One pass over merged events. variant=null → live baseline only. */
function simulate(events, vals, { adoptedAtMs }, variant) {
  let confirmedPeak = 0, pendingPeak = null, pendingN = 0, lastMgmt = vals[0]?.t ?? 0;
  let armed = false, trailStreak = 0, stopN = 0;
  let vi = -1, lastVal = null, slope = null, belowSince = null;
  for (const e of events) {
    if (e.src === "poller") {
      // advance to this valuation (events carry every poller row; only distinct ones count)
      while (vi + 1 < vals.length && vals[vi + 1].t <= e.t) {
        vi++;
        const v = vals[vi];
        if (v.suspect) continue;
        lastVal = v; slope = slopeAt(vals, vi);
        if (v.pnl > confirmedPeak) {
          if (v.t - lastMgmt >= 600e3) { confirmedPeak = v.pnl; pendingPeak = null; pendingN = 0; lastMgmt = v.t; }
          else if (pendingPeak != null && v.pnl >= pendingPeak) { pendingN++; pendingPeak = v.pnl; if (pendingN >= 2) { confirmedPeak = pendingPeak; pendingPeak = null; pendingN = 0; } }
          else { pendingPeak = v.pnl; pendingN = 1; }
        } else { pendingPeak = null; pendingN = 0; if (v.t - lastMgmt >= 600e3) lastMgmt = v.t; }
        if (v.pnl <= LIVE.stop) { if (++stopN >= 2) return { t: v.t, rule: "stop", read: v.pnl }; } else stopN = 0;
        const inGrace = adoptedAtMs != null && v.t - adoptedAtMs < LIVE.graceMs;
        if (!armed && confirmedPeak >= LIVE.trigger) armed = true;
        if (armed && !inGrace) {
          const thr = confirmedPeak - LIVE.drop;
          if (v.pnl <= thr) {
            trailStreak++;
            if (thr - v.pnl >= LIVE.overshoot || trailStreak >= 2) return { t: v.t, rule: "trailing", read: v.pnl, thr, peak: confirmedPeak };
          } else trailStreak = 0;
        }
        if (variant) belowSince = null; // a fresh valuation re-bases the estimate
      }
      continue;
    }
    // socket bin change → bin-estimated trigger
    if (!variant || !armed || !lastVal || slope == null) continue;
    if (adoptedAtMs != null && e.t - adoptedAtMs < LIVE.graceMs) continue;
    if (e.bin >= lastVal.bin) { belowSince = null; continue; }
    const thr = confirmedPeak - LIVE.drop;
    const est = lastVal.pnl + slope * (e.bin - lastVal.bin);
    if (est <= thr - variant.margin) {
      if (belowSince == null) belowSince = e.t;
      if (e.t - belowSince >= variant.hold * 1000) return { t: e.t, rule: "trailing_bin", read: est, thr, peak: confirmedPeak };
    } else belowSince = null;
  }
  return null;
}

/** pnl estimate at time t: last distinct valuation ≤ t + its slope × (bin(t) − its bin). */
function estimator(vals, events) {
  const binsT = events.map((e) => e.t), binsB = events.map((e) => e.bin);
  const slopes = vals.map((_, i) => slopeAt(vals, i));
  const lastIdx = (arr, t) => { let lo = 0, hi = arr.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; } return r; };
  const valT = vals.map((v) => v.t);
  return (t) => {
    let vi = lastIdx(valT, t);
    while (vi >= 0 && vals[vi].suspect) vi--;
    if (vi < 0) return null;
    const v = vals[vi], bi = lastIdx(binsT, t);
    const bin = bi >= 0 ? binsB[bi] : v.bin;
    const sl = slopes[vi];
    return sl == null ? v.pnl : v.pnl + sl * (bin - v.bin);
  };
}

/** Event study on the REAL trailing closes: live threshold + live firing valuation from the
 *  close reason; both fires valued with the same bin-based estimate at fire + LATENCY. */
async function eventStudy(c) {
  const { rows } = await c.query(
    `select position_address, pair, pool_address, deployed_at, closed_at, coalesce((data->>'amount_sol')::float,0) as amount,
            (data->>'exit_pnl_pct')::float as exit_pnl, data->>'close_reason' as reason
       from positions where closed and closed_at > now() - make_interval(days => $1)
        and data->>'close_reason' like 'Trailing TP:%' and not coalesce((data->>'hold_mode')::bool,false)
      order by closed_at`, [DAYS]);
  const res = [];
  for (const p of rows) {
    const m = /→ current (-?[\d.]+)% \(threshold (-?[\d.]+)%/.exec(p.reason || "");
    if (!m) continue;
    const Y = Number(m[1]), Z = Number(m[2]);
    const { rows: pr } = await c.query(`select extract(epoch from ts)*1000 as t, active_bin as bin, pnl_pct as pnl from price_ticks where position_address=$1 and source='poller' order by ts`, [p.position_address]);
    const { rows: sr } = await c.query(`select extract(epoch from ts)*1000 as t, active_bin as bin from price_ticks where pool_address=$1 and source='socket' and ts between $2 and $3 order by ts`, [p.pool_address, p.deployed_at, p.closed_at]);
    if (!sr.length) continue;
    const polls = pr.map((r) => ({ t: Number(r.t), bin: Number(r.bin), pnl: r.pnl == null ? null : Number(r.pnl), src: "poller" }));
    const vals = valuationsOf(polls);
    if (vals.length < 5) continue;
    const events = [...polls.map(({ t, bin }) => ({ t, bin })), ...sr.map((r) => ({ t: Number(r.t), bin: Number(r.bin) }))].sort((a, b) => a.t - b.t);
    const est = estimator(vals, events);
    const closedAt = new Date(p.closed_at).getTime();
    let tF = null;
    for (const v of vals) if (v.t <= closedAt && Math.abs(v.pnl - Y) < 0.006) tF = v.t;
    if (tF == null) continue;
    const liveOut = est(tF + LATENCY_S * 1000);
    const socket = sr.map((r) => ({ t: Number(r.t), bin: Number(r.bin) }));
    const rec = { pair: p.pair, amount: p.amount, Z, Y, overshoot: Z - Y, actual: p.exit_pnl, liveOut, v: {} };
    for (const margin of [0, 0.25, 0.5]) {
      // earliest bin crossing in the 5 min before the live fire
      let early = null;
      for (const e of socket) if (e.t > tF - 300e3 && e.t < tF) { const x = est(e.t); if (x != null && x <= Z - margin) { early = e; break; } }
      // false alarms before that window: est crosses the running-peak threshold but the next
      // valuation is back above it (a wick the live rule rode out)
      let runMax = -Infinity, vi = 0, falseHits = 0, firstFalse = null;
      for (const e of socket) {
        if (e.t >= tF - 300e3) break;
        while (vi < vals.length && vals[vi].t <= e.t) { if (!vals[vi].suspect) runMax = Math.max(runMax, vals[vi].pnl); vi++; }
        if (runMax < LIVE.trigger) continue;
        const thr = runMax - LIVE.drop, x = est(e.t);
        if (x == null || x > thr - margin) continue;
        const next = vals.find((v) => v.t > e.t && !v.suspect);
        if (next && next.pnl > thr) { falseHits++; if (!firstFalse) firstFalse = { t: e.t, out: est(e.t + LATENCY_S * 1000) }; }
      }
      rec.v[margin] = {
        earlyS: early ? (tF - early.t) / 1000 : 0,
        out: early ? est(early.t + LATENCY_S * 1000) : liveOut,
        falseHits, falseOut: firstFalse ? firstFalse.out : null,
      };
    }
    res.push(rec);
  }
  console.log(`\n## Event study — ${res.length} live trailing closes with socket bins (live threshold + firing valuation from the close reason)`);
  console.log("Both fires valued by the same estimator (last valuation + slope × bin move) at fire + latency.");
  console.log("| margin | fired earlier | median s earlier | Σ gain pp (earlier fires) | Σ gain ◎ | positions with ≥1 false alarm | Σ cost pp if the first false alarm had closed (vs actual exit) |");
  console.log("|---|---|---|---|---|---|---|");
  for (const margin of [0, 0.25, 0.5]) {
    const early = res.filter((r) => r.v[margin].earlyS > 0);
    const s = early.map((r) => r.v[margin].earlyS).sort((a, b) => a - b);
    const gain = early.reduce((a, r) => a + (r.v[margin].out - r.liveOut), 0);
    const gainSol = early.reduce((a, r) => a + (r.v[margin].out - r.liveOut) / 100 * r.amount, 0);
    const fa = res.filter((r) => r.v[margin].falseHits > 0);
    const faCost = fa.reduce((a, r) => a + ((r.v[margin].falseOut ?? r.actual) - r.actual), 0);
    console.log(`| ${margin} | ${early.length} | ${s.length ? s[Math.floor(s.length / 2)].toFixed(0) : "-"} | ${gain >= 0 ? "+" : ""}${gain.toFixed(1)} | ${gainSol >= 0 ? "+" : ""}${gainSol.toFixed(3)} | ${fa.length} | ${faCost.toFixed(1)} |`);
  }
  const big = res.filter((r) => r.overshoot >= 0.5).sort((a, b) => b.overshoot - a.overshoot).slice(0, 10);
  console.log("\nLargest live overshoots: margin-0 bin trigger");
  for (const r of big) console.log(`- ${r.pair}: thr ${r.Z} live read ${r.Y} (overshoot ${r.overshoot.toFixed(2)}) → live est-out ${r.liveOut?.toFixed(2)}; bin ${r.v[0].earlyS ? `${r.v[0].earlyS.toFixed(0)} s earlier, est-out ${r.v[0].out?.toFixed(2)}` : "no earlier crossing"}; false alarms before: ${r.v[0].falseHits}`);
}

async function main() {
  const c = new Client({ host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE });
  await c.connect();
  const { rows: positions } = await c.query(
    `select position_address, pair, pool_address, deployed_at, closed_at,
            (data->>'exit_pnl_pct')::float as exit_pnl, coalesce((data->>'hold_mode')::bool,false) as hold,
            coalesce((data->>'adopted')::bool,false) as adopted, data->>'adopted_at' as adopted_at,
            coalesce((data->>'amount_sol')::float,0) as amount, coalesce(data->>'close_reason','') as reason
       from positions where closed and closed_at > now() - make_interval(days => $1) order by closed_at`, [DAYS]);
  const out = [];
  let skipped = { hold: 0, noticks: 0 };
  for (const p of positions) {
    if (p.hold) { skipped.hold++; continue; }
    const { rows: pr } = await c.query(
      `select extract(epoch from ts)*1000 as t, active_bin as bin, pnl_pct as pnl from price_ticks
        where position_address=$1 and source='poller' order by ts`, [p.position_address]);
    const { rows: sr } = await c.query(
      `select extract(epoch from ts)*1000 as t, active_bin as bin from price_ticks
        where pool_address=$1 and source='socket' and ts between $2 and $3 order by ts`, [p.pool_address, p.deployed_at, p.closed_at]);
    const polls = pr.map((r) => ({ t: Number(r.t), bin: Number(r.bin), pnl: r.pnl == null ? null : Number(r.pnl), src: "poller" }));
    const vals = valuationsOf(polls);
    if (vals.length < 5) { skipped.noticks++; continue; }
    const events = [...polls, ...sr.map((r) => ({ t: Number(r.t), bin: Number(r.bin), src: "socket" }))]
      .sort((a, b) => a.t - b.t || (a.src === "poller" ? -1 : 1));
    const adoptedAtMs = p.adopted ? new Date(p.adopted_at || p.deployed_at).getTime() : null;
    const closedAt = new Date(p.closed_at).getTime();
    const actual = Number.isFinite(p.exit_pnl) ? p.exit_pnl : vals[vals.length - 1].pnl;
    const base = simulate(events, vals, { adoptedAtMs }, null);
    const baseFire = base && base.t <= closedAt + 1000 ? base : null;
    const baseOut = baseFire ? realizedAfter(vals, baseFire.t) : actual;
    const rec = { pair: p.pair, adopted: p.adopted, amount: p.amount, actual, reason: p.reason.slice(0, 50), socketRows: sr.length, base: baseFire ? { ...baseFire, out: baseOut } : null, baseOut, v: {} };
    for (const variant of VARIANTS) {
      const f = simulate(events, vals, { adoptedAtMs }, variant);
      const fire = f && f.t <= closedAt + 1000 ? f : null;
      const o = fire ? realizedAfter(vals, fire.t) : actual;
      rec.v[variant.key] = fire ? { ...fire, out: o, dpp: o - baseOut, dsol: (o - baseOut) / 100 * p.amount, earlyS: baseFire ? (baseFire.t - fire.t) / 1000 : null } : null;
    }
    out.push(rec);
  }
  if (args.includes("--events")) await eventStudy(c);
  await c.end();

  const withSocket = out.filter((r) => r.socketRows > 0);
  console.log(`# Trailing bin-estimate replay — ${out.length} closes over ${DAYS} d (${withSocket.length} with socket bins; skipped ${skipped.hold} hold, ${skipped.noticks} without ticks); latency ${LATENCY_S}s`);
  const bt = out.filter((r) => r.base?.rule === "trailing");
  const os = bt.map((r) => r.base.thr - r.base.read).sort((a, b) => a - b);
  const q = (x) => os[Math.min(os.length - 1, Math.floor(os.length * x))];
  console.log(`\nBaseline (live rule on valuations): ${bt.length} trailing fires; overshoot at the firing valuation median ${q(0.5)?.toFixed(2)} pp, p75 ${q(0.75)?.toFixed(2)}, p90 ${q(0.9)?.toFixed(2)}`);
  console.log("\n| variant | bin fires | earlier than baseline | extra (baseline did not fire) | better | worse | net pp | net ◎ | median s earlier | worst | best |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const { key } of VARIANTS) {
    const fires = out.filter((r) => r.v[key]?.rule === "trailing_bin");
    const earlier = fires.filter((r) => r.base);
    const extra = fires.filter((r) => !r.base);
    const d = fires.map((r) => r.v[key]);
    const better = d.filter((x) => x.dpp > 0.05).length, worse = d.filter((x) => x.dpp < -0.05).length;
    const es = earlier.map((r) => r.v[key].earlyS).sort((a, b) => a - b);
    const sorted = fires.slice().sort((a, b) => a.v[key].dpp - b.v[key].dpp);
    const fmt = (r) => r ? `${r.pair} ${r.v[key].dpp >= 0 ? "+" : ""}${r.v[key].dpp.toFixed(2)}pp` : "-";
    console.log(`| ${key} | ${fires.length} | ${earlier.length} | ${extra.length} | ${better} | ${worse} | ${d.reduce((s, x) => s + x.dpp, 0).toFixed(1)} | ${d.reduce((s, x) => s + x.dsol, 0).toFixed(3)} | ${es.length ? es[Math.floor(es.length / 2)].toFixed(0) : "-"} | ${fmt(sorted[0])} | ${fmt(sorted[sorted.length - 1])} |`);
  }
  const focus = out.filter((r) => /JEANPHIL/.test(r.pair) && r.base?.rule === "trailing");
  for (const r of focus) console.log(`\nJEANPHIL check: baseline read ${r.base.read.toFixed(2)} thr ${r.base.thr.toFixed(2)} → out ${r.baseOut.toFixed(2)}; m0_h0 ${r.v.m0_h0 ? `${r.v.m0_h0.rule} est ${r.v.m0_h0.read.toFixed(2)} ${r.v.m0_h0.earlyS}s earlier → out ${r.v.m0_h0.out.toFixed(2)}` : "no fire"}`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out));
  console.error("done");
}
main().catch((e) => { console.error(e); process.exit(1); });
