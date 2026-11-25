#!/usr/bin/env node
/**
 * scripts/replay/fill_markout_study.js — OFFLINE, read-only, DESCRIPTIVE (no pass rule).
 * Markouts of the bot's own ladder fills and fees vs the inventory mark-down, on the same
 * population as scripts/replay/hybrid_shape_replay.js (docs/research/2026-11-25-hawkfi-post-assessment.md, Part 4).
 *
 *   node scripts/replay/fill_markout_study.js --records performance.json --ticks ticks.csv.gz [--json out.json]
 *
 * Fills: when the active bin moves down through an in-range bin i the ladder buys tokens with that
 * bin's SOL (y_i) at p(i) ("buy"); moving back up through it sells them at p(i) ("sell").
 * Markout of a buy at horizon h = p(t+h)/p(i) − 1 (sell: 1 − p(t+h)/p(i)); positive = good for us.
 * p(t+h): last tick's active bin at or before t+h while the position is open; after the close the
 * close price is carried with the pool's mcap ratio from the post-close probes (exit_mcap → m30 /
 * m60 / m180, log-linear in time; mcap is USD, so SOL/USD drift is included). A horizon past the
 * last probe is "unavailable".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { feesSol, ladderValue, readTicksFile, quantile, crossedRange } from "./bidask_flip_replay.js";
import {
  classifyRecord, evaluatePosition, shapeFractions, actualKind, ladderFromFractions,
  MAX_MODEL_ERR_PP, STOP_CLASS, DEFAULT_FROM, DEFAULT_TO,
} from "./hybrid_shape_replay.js";

export const HORIZONS_MIN = [0, 1, 5, 30, 60];

/** Log mcap ratio after the close at offset m minutes (log-linear between probes), or null. */
export function postCloseLogRatio(pc, m) {
  const ex = Number(pc?.exit_mcap);
  if (!(ex > 0)) return null;
  const pts = [[0, 0]];
  for (const [k, off] of [["m30", 30], ["m60", 60], ["m180", 180]]) {
    const v = Number(pc?.[k]?.mcap);
    if (v > 0) pts.push([off, Math.log(v / ex)]);
  }
  for (let j = 1; j < pts.length; j++) {
    if (m <= pts[j][0]) {
      const [t0, v0] = pts[j - 1], [t1, v1] = pts[j];
      return v0 + ((v1 - v0) * (m - t0)) / (t1 - t0);
    }
  }
  return null;
}

/** Active bin at time T (step function over sorted ticks), T within the ticks' span. */
export function binAt(ticks, T) {
  let lo = 0, hi = ticks.length - 1;
  if (T < ticks[0].t) return ticks[0].a;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ticks[mid].t <= T) lo = mid; else hi = mid - 1;
  }
  return ticks[lo].a;
}

export function tvlBand(v) {
  const x = Number(v);
  if (v == null || !Number.isFinite(x)) return "unknown";
  return x < 100000 ? "< $100k" : x < 200000 ? "$100–200k" : "≥ $200k";
}
export function ageBand(v) {
  const x = Number(v);
  if (v == null || !Number.isFinite(x)) return "unknown";
  return x < 24 ? "< 24 h" : x < 168 ? "1–7 d" : "≥ 7 d";
}

export function positionFills(geom, ticks, tClose, pc) {
  const s = geom.binStep / 1e4;
  const ln1s = Math.log(1 + s);
  const n = geom.hi - geom.lo + 1;
  const fills = [];
  for (let k = 1; k < ticks.length; k++) {
    const r = crossedRange(ticks[k - 1].a, ticks[k].a);
    if (!r) continue;
    const side = ticks[k].a < ticks[k - 1].a ? "buy" : "sell";
    const jump = Math.abs(ticks[k].a - ticks[k - 1].a);
    // bins moved over the previous 60 s (velocity at the fill)
    const back = binAt(ticks, ticks[k].t - 60);
    const vel60 = Math.abs(ticks[k].a - back);
    for (let i = Math.max(r[0], geom.lo); i <= Math.min(r[1], geom.hi); i++) {
      const y = geom.y[i - geom.lo];
      const t = ticks[k].t;
      const mk = {};
      for (const h of HORIZONS_MIN) {
        const T = t + h * 60;
        let lr; // log(p(T)/p(i))
        if (T <= tClose) lr = (binAt(ticks, T) - i) * ln1s;
        else {
          const aEnd = ticks[ticks.length - 1].a;
          const pcr = postCloseLogRatio(pc, (T - tClose) / 60);
          lr = pcr == null ? null : (aEnd - i) * ln1s + pcr;
        }
        mk[h] = lr == null ? null : side === "buy" ? Math.exp(lr) - 1 : 1 - Math.exp(lr);
        mk[`${h}_in_life`] = T <= tClose;
      }
      fills.push({ side, bin: i, y, t, jump, vel60, mk });
    }
  }
  return fills;
}

function agg(fills, h) {
  const use = fills.filter((f) => f.mk[h] != null);
  const ySum = use.reduce((a, f) => a + f.y, 0);
  const wMean = ySum > 0 ? use.reduce((a, f) => a + f.y * f.mk[h], 0) / ySum : null;
  return {
    n: use.length, n_unavailable: fills.length - use.length,
    n_in_life: use.filter((f) => f.mk[`${h}_in_life`]).length,
    sol: ySum, sol_markout: use.reduce((a, f) => a + f.y * f.mk[h], 0),
    mean_w: wMean, median: quantile(use.map((f) => f.mk[h]), 0.5),
    share_pos: use.length ? use.filter((f) => f.mk[h] > 0).length / use.length : null,
  };
}

export function runStudy(records, ticksByPos, { from = DEFAULT_FROM, to = DEFAULT_TO } = {}) {
  const pos = [];
  for (const rec of records) {
    const c = classifyRecord(rec, ticksByPos, { from, to });
    if (c.reason) continue;
    const F = feesSol(rec) ?? 0;
    const ev = evaluatePosition({ lo: c.lo, hi: c.hi, binStep: c.binStep, C: c.C }, rec.strategy, c.ticks,
      { F, r: 0, pnlRec: Number(rec.pnl_pct), variants: [{ id: "actual", mix: null }] });
    if (!(Math.abs(ev.err) <= MAX_MODEL_ERR_PP)) continue;
    const geom = { lo: c.lo, hi: c.hi, binStep: c.binStep, C: c.C };
    const L = ladderFromFractions(geom, shapeFractions(c.hi - c.lo + 1, actualKind(rec.strategy)));
    geom.y = L.y;
    const capPnl = ladderValue(L, c.ticks[c.ticks.length - 1].a) - c.C;
    const fills = positionFills(geom, c.ticks, c.tClose, rec.post_close);
    pos.push({
      rec, C: c.C, F, capPnl, fills,
      family: rec.exit_family ?? "unknown",
      tvl: tvlBand(rec.entry_tvl), age: ageBand(rec.entry_pool_age_h),
    });
  }
  const groupBy = (keyFn) => {
    const g = {};
    for (const p of pos) {
      const k = keyFn(p);
      g[k] ||= { positions: 0, capital: 0, fees: 0, cap_pnl: 0, fills: [] };
      g[k].positions++; g[k].capital += p.C; g[k].fees += p.F; g[k].cap_pnl += p.capPnl;
      g[k].fills.push(...p.fills);
    }
    const out = {};
    for (const [k, v] of Object.entries(g)) {
      const buys = v.fills.filter((f) => f.side === "buy");
      out[k] = {
        positions: v.positions, capital: v.capital, fees: v.fees, inventory_markdown: v.cap_pnl,
        net: v.fees + v.cap_pnl, fees_pct: (100 * v.fees) / v.capital, markdown_pct: (100 * v.cap_pnl) / v.capital,
        buy_fills: buys.length, buy_sol: buys.reduce((a, f) => a + f.y, 0),
        markout_buy: Object.fromEntries(HORIZONS_MIN.map((h) => [h, agg(buys, h)])),
      };
    }
    return out;
  };
  const all = pos.flatMap((p) => p.fills);
  const buys = all.filter((f) => f.side === "buy"), sells = all.filter((f) => f.side === "sell");
  const by = (arr, fn) => {
    const g = {};
    for (const f of arr) (g[fn(f)] ||= []).push(f);
    return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Object.fromEntries(HORIZONS_MIN.map((h) => [h, agg(v, h)]))]));
  };
  const perPos = pos.map((p) => ({ fees: p.F, md: p.capPnl, C: p.C, filled: p.fills.some((f) => f.side === "buy") }));
  const filled = perPos.filter((x) => x.filled);
  return {
    generated_at: new Date().toISOString(), window: { from, to },
    positions: pos.length,
    totals: {
      capital: pos.reduce((a, p) => a + p.C, 0), fees: pos.reduce((a, p) => a + p.F, 0),
      inventory_markdown: pos.reduce((a, p) => a + p.capPnl, 0),
      positions_with_a_buy_fill: filled.length,
      filled_fees: filled.reduce((a, x) => a + x.fees, 0), filled_markdown: filled.reduce((a, x) => a + x.md, 0),
      fees_cover_markdown: filled.filter((x) => x.fees + x.md >= 0).length,
    },
    markout_buy: Object.fromEntries(HORIZONS_MIN.map((h) => [h, agg(buys, h)])),
    markout_sell: Object.fromEntries(HORIZONS_MIN.map((h) => [h, agg(sells, h)])),
    buy_by_jump: by(buys, (f) => (f.jump <= 1 ? "1 bin/tick" : f.jump <= 3 ? "2–3 bins/tick" : "≥ 4 bins/tick")),
    buy_by_vel60: by(buys, (f) => (f.vel60 <= 2 ? "≤ 2 bins/60 s" : f.vel60 <= 6 ? "3–6 bins/60 s" : "≥ 7 bins/60 s")),
    by_family: groupBy((p) => p.family),
    by_stop_class: groupBy((p) => (STOP_CLASS.has(p.family) ? "stop-class" : "other")),
    by_tvl: groupBy((p) => p.tvl),
    by_age: groupBy((p) => p.age),
  };
}

const pc = (x) => (x == null || !Number.isFinite(x) ? "n/a" : (100 * x).toFixed(2) + "%");
const s4 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + x.toFixed(4));

export function formatReport(R) {
  const L = [];
  L.push(`FILL MARKOUT STUDY (descriptive) — ${R.positions} positions, window ${R.window.from} … ${R.window.to}`);
  const T = R.totals;
  L.push(`capital ◎${T.capital.toFixed(2)}; fees ◎${s4(T.fees)}; inventory mark-down at close ◎${s4(T.inventory_markdown)}; net ◎${s4(T.fees + T.inventory_markdown)}`);
  L.push(`positions with ≥ 1 buy fill ${T.positions_with_a_buy_fill}: fees ◎${s4(T.filled_fees)} vs mark-down ◎${s4(T.filled_markdown)}; fees ≥ mark-down on ${T.fees_cover_markdown}`);
  const line = (lab, m) => `  ${lab.padEnd(18)} ` + Object.entries(m).map(([h, a]) => `${h}m n${a.n}(${a.n_in_life} in-life, ${a.n_unavailable} n/a) w-mean ${pc(a.mean_w)} med ${pc(a.median)} pos ${pc(a.share_pos)} ◎${s4(a.sol_markout)}`).join(" | ");
  L.push("buy fills:"); L.push(line("all", R.markout_buy));
  L.push("sell fills:"); L.push(line("all", R.markout_sell));
  L.push("buy fills by move size in the tick:"); for (const [k, m] of Object.entries(R.buy_by_jump)) L.push(line(k, m));
  L.push("buy fills by bins moved over the prior 60 s:"); for (const [k, m] of Object.entries(R.buy_by_vel60)) L.push(line(k, m));
  for (const [title, g] of [["exit family", R.by_family], ["stop class", R.by_stop_class], ["entry TVL", R.by_tvl], ["pool age at entry", R.by_age]]) {
    L.push(`by ${title}: positions, capital, fees, mark-down, net (◎ and % of capital), buy fills, buy markout 5m / 60m (w-mean, share +)`);
    for (const [k, v] of Object.entries(g).sort((a, b) => b[1].positions - a[1].positions)) {
      L.push(`  ${k.padEnd(20)} ${String(v.positions).padStart(4)} ◎${v.capital.toFixed(1).padStart(6)} fees ${s4(v.fees)} (${v.fees_pct.toFixed(2)}%) md ${s4(v.inventory_markdown)} (${v.markdown_pct.toFixed(2)}%) net ${s4(v.net)} fills ${v.buy_fills} 5m ${pc(v.markout_buy[5].mean_w)}/${pc(v.markout_buy[5].share_pos)} 60m ${pc(v.markout_buy[60].mean_w)}/${pc(v.markout_buy[60].share_pos)} (n ${v.markout_buy[60].n})`);
    }
  }
  return L.join("\n") + "\n";
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const rp = opt("--records", null), tp = opt("--ticks", null);
  if (!rp || !tp) { console.error("usage: node scripts/replay/fill_markout_study.js --records <performance.json> --ticks <ticks.csv[.gz]> [--json out.json]"); process.exit(2); }
  const { byPos } = readTicksFile(tp);
  const R = runStudy(JSON.parse(fs.readFileSync(rp, "utf8")), byPos);
  process.stdout.write(formatReport(R));
  const j = opt("--json", null);
  if (j) fs.writeFileSync(j, JSON.stringify(R, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
