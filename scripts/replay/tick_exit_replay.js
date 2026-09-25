#!/usr/bin/env node
/**
 * scripts/replay/tick_exit_replay.js — OFFLINE, read-only counterfactual replay of two
 * proposed exit rules (audit 01 §4.1 / §4.2, Phase 2) over the 30-day `price_ticks` history.
 *
 *   PEAK-CRASH   raw (unconfirmed) tick peak >= minPeak, then pnl <= peak - dropPp within
 *                windowSec of the peak → urgent exit. Realized at the first valuation
 *                >= latencySec after detection (models confirm + tx latency).
 *   SLOW-BLEED   pnl <= levelPct continuously for >= hours AND no active-bin change in the
 *                last quietMin minutes → close. Realized at that valuation.
 *
 * Mirrors the live valuation semantics: consecutive identical (pnl, bin) poller ticks are ONE
 * valuation; a positive jump > suspectPp between valuations is suspect (excluded from peaks and
 * from firing) — same as assessValuation() in index.js.
 *
 * Counterfactual outcome = pnl at the rule's fire; actual = exit_pnl_pct (fallback: last
 * valuation). delta_sol = (cf − actual) / 100 × amount_sol. hold_mode positions are excluded
 * from the totals (the live rules skip them) and counted separately.
 *
 * READ-ONLY: SELECT statements only. Run on the VM:
 *   cd /opt/meridian && node scripts/replay/tick_exit_replay.js [--since 2026-08-26] [--json out.json]
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import "../../envcrypt.js";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SINCE = opt("--since", null);
const JSON_OUT = opt("--json", null);
const SUSPECT_PP = 15;
const LATENCY_SEC = 10;

const PEAK_CRASH_GRID = [];
for (const minPeak of [2, 3, 5])
  for (const dropPp of [2, 3, 4, 5])
    for (const windowSec of [5, 30, 60, 300, Infinity])
      PEAK_CRASH_GRID.push({ minPeak, dropPp, windowSec });

const SLOW_BLEED_GRID = [];
for (const levelPct of [-3, -5, -7])
  for (const hours of [2, 4, 6])
    for (const quietMin of [30, 60])
      SLOW_BLEED_GRID.push({ levelPct, hours, quietMin });

function family(reason) {
  const r = String(reason || "").toLowerCase();
  if (!r) return "unknown";
  if (r.includes("young")) return "young_stop";
  if (r.includes("stop loss") || r.includes("stop_loss")) return "stop_loss";
  if (r.includes("rug")) return "rug";
  if (r.includes("crash")) return "crash";
  if (r.includes("round-trip") || r.includes("harvest")) return "harvest";
  if (r.includes("trailing")) return "trailing_tp";
  if (r.includes("take profit") || r.includes("take_profit")) return "take_profit";
  if (r.includes("converted") || r.includes("toxic")) return "toxic";
  if (r.includes("dynamic fee") || r.includes("surge")) return "surge_decay";
  if (r.includes("unfilled")) return "oor_above_unfilled";
  if (r.includes("above")) return "oor_above";
  if (r.includes("below")) return "oor_below";
  if (r.includes("low yield") || r.includes("low_yield") || r.includes("fee")) return "low_yield";
  if (r.includes("rebalanc")) return "rebalance_leg";
  if (r.includes("external") || r.includes("on-chain")) return "external";
  if (r.includes("manual") || r.includes("operator") || r.includes("telegram")) return "manual";
  return "other";
}

function closeReasonOf(row) {
  if (row.close_reason) return row.close_reason;
  const notes = Array.isArray(row.notes) ? row.notes : [];
  for (let i = notes.length - 1; i >= 0; i--) {
    const m = /^Closed at [^:]+:\s*(.*)$/s.exec(String(notes[i]));
    if (m) return m[1];
  }
  return null;
}

/** Collapse poller ticks into distinct valuations, flag suspects like assessValuation(). */
function valuationsOf(ticks) {
  const out = [];
  let lastKey = null, lastPnl = null;
  for (const t of ticks) {
    if (t.source !== "poller" || t.pnl_pct == null) continue;
    const pnl = Number(t.pnl_pct);
    if (!Number.isFinite(pnl)) continue;
    const key = `${pnl}|${t.active_bin}`;
    if (key === lastKey) continue;
    const suspect = lastPnl != null && pnl - lastPnl > SUSPECT_PP;
    out.push({ ts: t.ts, pnl, bin: t.active_bin, suspect });
    lastKey = key; lastPnl = pnl;
  }
  return out;
}

function realizedAfter(vals, i, latencySec) {
  const t0 = vals[i].ts;
  for (let j = i; j < vals.length; j++) if (vals[j].ts - t0 >= latencySec * 1000) return vals[j].pnl;
  return vals[vals.length - 1].pnl;
}

function replayPeakCrash(vals, { minPeak, dropPp, windowSec }) {
  let peak = -Infinity, peakTs = 0;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v.suspect) continue;
    if (v.pnl > peak) { peak = v.pnl; peakTs = v.ts; continue; }
    if (peak >= minPeak && v.pnl <= peak - dropPp && (v.ts - peakTs) <= windowSec * 1000) {
      return { fired: true, ts: v.ts, detectPnl: v.pnl, peak, cf: realizedAfter(vals, i, LATENCY_SEC) };
    }
  }
  return { fired: false };
}

function replaySlowBleed(vals, binEvents, { levelPct, hours, quietMin }) {
  let belowSince = null;
  let bi = 0, lastBinChangeTs = -Infinity, lastBin = null;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    // advance the bin-change cursor (all rows: socket + poller) up to this valuation
    while (bi < binEvents.length && binEvents[bi].ts <= v.ts) {
      if (lastBin !== null && binEvents[bi].bin !== lastBin) lastBinChangeTs = binEvents[bi].ts;
      lastBin = binEvents[bi].bin; bi++;
    }
    if (v.suspect) continue;
    if (v.pnl <= levelPct) { if (belowSince == null) belowSince = v.ts; }
    else belowSince = null;
    if (belowSince != null && v.ts - belowSince >= hours * 3600e3 && v.ts - lastBinChangeTs >= quietMin * 60e3) {
      return { fired: true, ts: v.ts, cf: v.pnl, belowSince };
    }
  }
  return { fired: false };
}

function summarize(results) {
  const fired = results.filter(r => r.fired);
  const saves = fired.filter(r => r.delta_sol > 0), trunc = fired.filter(r => r.delta_sol < 0);
  const sum = (a, k) => a.reduce((s, r) => s + r[k], 0);
  const worst = trunc.slice().sort((a, b) => a.delta_sol - b.delta_sol)[0];
  const best = saves.slice().sort((a, b) => b.delta_sol - a.delta_sol)[0];
  return {
    fires: fired.length, saves: saves.length, truncations: trunc.length,
    net_sol: +sum(fired, "delta_sol").toFixed(3), saved_sol: +sum(saves, "delta_sol").toFixed(3), lost_sol: +sum(trunc, "delta_sol").toFixed(3),
    net_pp: +sum(fired, "delta_pp").toFixed(1),
    worst: worst ? `${worst.pair} ${worst.delta_pp.toFixed(1)}pp/${worst.delta_sol.toFixed(2)}◎` : "-",
    best: best ? `${best.pair} +${best.delta_pp.toFixed(1)}pp/+${best.delta_sol.toFixed(2)}◎` : "-",
  };
}

async function main() {
  const c = new Client({ host: process.env.PGHOST, port: process.env.PGPORT, user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.PGDATABASE });
  await c.connect();
  const { rows: [win] } = await c.query("select min(ts) as t0, max(ts) as t1 from price_ticks");
  const since = SINCE ? new Date(SINCE) : win.t0;
  const { rows: positions } = await c.query(
    `select position_address, pair, lower_bin, upper_bin, deployed_at, closed_at,
            (data->>'exit_pnl_pct')::float as exit_pnl_pct, data->>'close_reason' as close_reason,
            (data->>'hold_mode')::bool as hold_mode, (data->>'amount_sol')::float as amount_sol,
            (data->>'adopted')::bool as adopted, data->>'lane' as lane, (data->>'peak_pnl_pct')::float as peak_pnl_pct,
            data->'notes' as notes
       from positions where closed and closed_at > $1 order by closed_at`, [since]);
  console.error(`tick window ${win.t0.toISOString()} → ${win.t1.toISOString()}; ${positions.length} closed positions since ${new Date(since).toISOString()}`);

  const perPos = [];
  for (const p of positions) {
    const { rows: ticks } = await c.query(
      "select ts, active_bin, pnl_pct, source from price_ticks where position_address=$1 order by ts", [p.position_address]);
    for (const t of ticks) t.ts = new Date(t.ts).getTime();
    const vals = valuationsOf(ticks);
    if (vals.length < 5) { perPos.push({ ...p, skipped: "few_valuations", n_vals: vals.length }); continue; }
    const binEvents = ticks.filter(t => t.active_bin != null).map(t => ({ ts: t.ts, bin: Number(t.active_bin) }));
    const actual = Number.isFinite(p.exit_pnl_pct) ? p.exit_pnl_pct : vals[vals.length - 1].pnl;
    const amount = Number.isFinite(p.amount_sol) && p.amount_sol > 0 ? p.amount_sol : 0;
    const reason = closeReasonOf(p);
    const rec = {
      pair: p.pair, position: p.position_address, adopted: !!p.adopted, hold: !!p.hold_mode, lane: p.lane || "burst",
      family: family(reason), actual, amount, n_vals: vals.length, raw_peak: Math.max(...vals.filter(v => !v.suspect).map(v => v.pnl)),
      minutes: (new Date(p.closed_at) - new Date(p.deployed_at)) / 60e3,
      peak_crash: {}, slow_bleed: {},
    };
    const mk = (r) => r.fired ? { ...r, delta_pp: r.cf - actual, delta_sol: (r.cf - actual) / 100 * amount, minutes_early: (new Date(p.closed_at).getTime() - r.ts) / 60e3 } : r;
    for (const g of PEAK_CRASH_GRID) rec.peak_crash[`p${g.minPeak}_d${g.dropPp}_w${g.windowSec}`] = mk(replayPeakCrash(vals, g));
    for (const g of SLOW_BLEED_GRID) rec.slow_bleed[`l${g.levelPct}_h${g.hours}_q${g.quietMin}`] = mk(replaySlowBleed(vals, binEvents, g));
    perPos.push(rec);
  }
  await c.end();

  const usable = perPos.filter(r => !r.skipped);
  const scored = usable.filter(r => !r.hold);
  const held = usable.filter(r => r.hold);
  const seg = { all: scored, bot: scored.filter(r => !r.adopted), adopted: scored.filter(r => r.adopted) };
  console.log(`# Tick exit replay — ${usable.length} closed positions with ticks (${scored.length} scored, ${held.length} hold-mode excluded, ${perPos.length - usable.length} skipped)`);
  console.log(`Actual Σ pnl_sol (scored): ${seg.all.reduce((s, r) => s + r.actual / 100 * r.amount, 0).toFixed(2)}◎; bot ${seg.bot.length} / adopted ${seg.adopted.length}`);
  const giveBack = scored.filter(r => r.raw_peak >= 3 && r.actual < 1);
  console.log(`Give-back cohort (raw peak ≥3%, close <1%): n=${giveBack.length}, Σ ${giveBack.reduce((s, r) => s + r.actual / 100 * r.amount, 0).toFixed(2)}◎, avg peak ${(giveBack.reduce((s, r) => s + r.raw_peak, 0) / Math.max(1, giveBack.length)).toFixed(1)}%`);

  for (const [segName, rows] of Object.entries(seg)) {
    console.log(`\n## PEAK-CRASH — segment ${segName} (n=${rows.length})`);
    console.log("| variant | fires | saves | trunc | net ◎ | saved ◎ | lost ◎ | net pp | worst trunc | best save |");
    console.log("|---|---|---|---|---|---|---|---|---|---|");
    const lines = [];
    for (const g of PEAK_CRASH_GRID) {
      const k = `p${g.minPeak}_d${g.dropPp}_w${g.windowSec}`;
      const s = summarize(rows.map(r => ({ ...r.peak_crash[k], pair: r.pair })));
      lines.push({ k, s });
    }
    lines.sort((a, b) => b.s.net_sol - a.s.net_sol);
    for (const { k, s } of lines) console.log(`| ${k} | ${s.fires} | ${s.saves} | ${s.truncations} | ${s.net_sol} | ${s.saved_sol} | ${s.lost_sol} | ${s.net_pp} | ${s.worst} | ${s.best} |`);
  }
  for (const [segName, rows] of Object.entries(seg)) {
    console.log(`\n## SLOW-BLEED — segment ${segName} (n=${rows.length})`);
    console.log("| variant | fires | saves | trunc | net ◎ | saved ◎ | lost ◎ | net pp | worst trunc | best save |");
    console.log("|---|---|---|---|---|---|---|---|---|---|");
    const lines = [];
    for (const g of SLOW_BLEED_GRID) {
      const k = `l${g.levelPct}_h${g.hours}_q${g.quietMin}`;
      const s = summarize(rows.map(r => ({ ...r.slow_bleed[k], pair: r.pair })));
      lines.push({ k, s });
    }
    lines.sort((a, b) => b.s.net_sol - a.s.net_sol);
    for (const { k, s } of lines) console.log(`| ${k} | ${s.fires} | ${s.saves} | ${s.truncations} | ${s.net_sol} | ${s.saved_sol} | ${s.lost_sol} | ${s.net_pp} | ${s.worst} | ${s.best} |`);
  }
  // Family breakdown of the actual closes for context
  const fam = {};
  for (const r of scored) { fam[r.family] ??= { n: 0, sol: 0 }; fam[r.family].n++; fam[r.family].sol += r.actual / 100 * r.amount; }
  console.log("\n## Actual close families (scored)");
  for (const [f, v] of Object.entries(fam).sort((a, b) => a[1].sol - b[1].sol)) console.log(`- ${f}: n=${v.n} Σ ${v.sol.toFixed(2)}◎`);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ window: win, since, positions: perPos }, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
