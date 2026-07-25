#!/usr/bin/env node
/**
 * scripts/replay/bin_trigger_study.js — OFFLINE, read-only counterfactual study.
 *
 * QUESTION
 *   tools/socket-monitor.js receives EVERY active-bin change in real time, but
 *   handlePoolAccountChange() only calls triggerImmediateSync() when the position
 *   crosses OUT OF RANGE. Between OOR crossings, exits are evaluated only by the
 *   PnL poller (~45 s observed cadence). Two positions (Syrax-SOL 2026-07-23,
 *   RAKO-SOL 2026-07-25) collapsed while grinding DOWNWARD INSIDE a 119–120-bin
 *   range, so the stops fired 10–20 pp past their thresholds.
 *
 *   Counterfactual: ALSO force an evaluation when the active bin has moved DOWN by
 *   >= N bins since the last evaluation (min-interval throttled). No threshold
 *   changes — only "evaluate closer to when the price actually moved".
 *
 *   What would that have SAVED on the losses, and what would it have COST on the
 *   positions that ended fine? (Denser sampling is an effective tightening of the
 *   exits, and this bank has confirmed 4x that tightening truncates winners.)
 *
 * ZERO runtime footprint. Pure consumer of three extracted files; imports NO
 * meridian module, touches no store, no .env, no DB. Read-only by construction.
 *
 * INPUTS (produced by the extraction SQL in the study scratchpad)
 *   --ticks   ticks.csv          position_address,pool_name,source,ts,active_bin,pnl_pct,price
 *                                source=socket → dense pool-level bin obs, NO pnl
 *                                source=poller → sparse position-level obs WITH pnl
 *   --meta    position_meta.csv  position_address,pool_address,pool_name,deployed_at,closed_at,
 *                                lower_bin,upper_bin,bin_step,amount_sol,strategy,peak_pnl_pct,
 *                                ratchet_armed,token_age_hours,initial_value_usd
 *   --closes  closes.json        array of lessons.performance records
 *
 * USAGE
 *   node scripts/replay/bin_trigger_study.js --ticks ticks.csv --meta position_meta.csv \
 *        --closes closes.json [--verbose] [--confirm hybrid|poller] [--ratchet off|on|seeded]
 *        [--young all|known] [--json out.json]
 *
 * LIVE RULE SET REPRODUCED (values reverse-engineered from the recorded
 * close_reason strings in closes.json, NOT from config.js defaults, which differ):
 *   stopLossPct           −15    ("stop loss: pnl -25.40% <= limit -15.00%")
 *   trailingTriggerPct      3    (peak +3.05% armed trailing)
 *   trailingDropPct         1    ("dropped 1.07% >= 1%")
 *   youngStopPct          −10 / <12 h  ("Young-token stop: PnL -12.15% <= -10% (token 5h old)")
 *   profitRatchet    arm +2 / stop −2  — but see --ratchet: the recorded paths PROVE it was
 *                                       DISABLED in this window (febu/looong/PUNY/BOP/RAKO all
 *                                       sat below −2% while ratchet_armed=true without firing).
 *   outOfRangeBinsToClose  50    ("60 bins past upper -466 (trigger 50)")
 *   twapGuardEnabled    false (shadow) — modelled as pass-through
 *   crash / rug fast-paths false — Syrax + RAKO closed by the stop-loss rule, not `crash`
 *
 * TWO CONFIRMATION SEMANTICS (both modelled; see the report's honesty section)
 *   "poller"  — every evaluation (poller AND forced) joins the poller's
 *               registerExitSignal stream: 2 consecutive confirming evals, plus the
 *               15 s stop_loss_violated_since / young_stop_violated_since timers.
 *               This is what the task specified.
 *   "hybrid"  — what the code would ACTUALLY do if the bin trigger reused
 *               triggerImmediateSync(): the force-sync file is picked up by the
 *               poller and runs runManagementCycle(), whose exit path
 *               (index.js:711-777) has NO 2-tick confirmation — an exit or a
 *               getDeterministicCloseRule() hit closes on the spot. The 15 s
 *               violated_since timers still apply inside updatePnlAndCheckExits,
 *               but deterministic RULE_1 (stop loss) has no timer, which is exactly
 *               why Syrax/RAKO's recorded close_reason is the lowercase
 *               "stop loss: pnl …" deterministic string. DEFAULT.
 *
 * OMITTED RULES (documented, not silently dropped): the OOR-below time rule
 * (outOfRangeWaitMinutesBelow) and LOW_YIELD are time/fee-driven, not bin-driven —
 * a denser evaluation clock changes only their granularity, and this dataset has no
 * fee/TVL series to drive them. Positions whose ACTUAL close was LOW_YIELD are
 * replayed for the bin-driven rules only; if no bin-driven rule fires, the
 * counterfactual outcome is "same as actual" (a fair no-harm result).
 */

import fs from "fs";
import path from "path";

// ── Live rule set (see header) ─────────────────────────────────────────────
const RULES = {
  stopLossPct: -15,
  trailingTakeProfit: true,
  trailingTriggerPct: 3,
  trailingDropPct: 1,
  youngStopPct: -10,
  youngStopMaxAgeHours: 12,
  profitRatchetArmPct: 2,
  profitRatchetStopPct: -2,
  outOfRangeBinsToClose: 50,
  confirmTicks: 2,
  violatedConfirmMs: 15_000,
};

const GRID_N = [4, 6, 8, 10, 12];
const GRID_INTERVAL_SEC = [20, 45];
const GRID_LAG_SEC = [5, 15];

// The three positions the study calls out as disasters.
const DISASTERS = new Set(["Syrax-SOL", "RAKO-SOL", "WORM-SOL"]);

// ── args ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    ticks: null, meta: null, closes: null,
    verbose: false, confirm: "hybrid", ratchet: "off", young: "known", json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    const eat = (k) => (s.includes("=") ? s.slice(s.indexOf("=") + 1) : argv[++i]);
    if (s.startsWith("--ticks")) a.ticks = path.resolve(eat());
    else if (s.startsWith("--meta")) a.meta = path.resolve(eat());
    else if (s.startsWith("--closes")) a.closes = path.resolve(eat());
    else if (s.startsWith("--confirm")) a.confirm = eat();
    else if (s.startsWith("--ratchet")) a.ratchet = eat();
    else if (s.startsWith("--young")) a.young = eat();
    else if (s.startsWith("--json")) a.json = path.resolve(eat());
    else if (s === "--verbose" || s === "-v") a.verbose = true;
  }
  return a;
}

// ── tiny helpers ──────────────────────────────────────────────────────────
const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const ms = (iso) => {
  if (!iso) return null;
  // Extracted timestamps are naive UTC ("2026-07-24T02:12:10.842"); force UTC.
  const t = Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
  return Number.isFinite(t) ? t : null;
};
const f2 = (v, w = 7) => (v == null || !Number.isFinite(v) ? "—".padStart(w) : v.toFixed(2).padStart(w));
const f1 = (v, w = 6) => (v == null || !Number.isFinite(v) ? "—".padStart(w) : v.toFixed(1).padStart(w));
const pad = (s, w) => String(s ?? "").padEnd(w).slice(0, w);
const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Minimal CSV split — the extracted files have no quoted/embedded commas. */
function readCsv(file) {
  const raw = fs.readFileSync(file, "utf8");
  const nl = raw.indexOf("\n");
  const header = raw.slice(0, nl).replace(/\r$/, "").split(",");
  const rows = [];
  let i = nl + 1;
  while (i < raw.length) {
    let j = raw.indexOf("\n", i);
    if (j === -1) j = raw.length;
    const line = raw.slice(i, j);
    i = j + 1;
    if (!line || line === "\r") continue;
    const f = line.replace(/\r$/, "").split(",");
    const o = {};
    for (let k = 0; k < header.length; k++) o[header[k]] = f[k];
    rows.push(o);
  }
  return rows;
}

// ══════════════════════════════════════════════════════════════════════════
//  BIN ↔ PRICE / CLOSED-FORM CL GEOMETRY  (mirrors pnl-curve.js + range-survival)
// ══════════════════════════════════════════════════════════════════════════
/**
 * Uniform-liquidity concentrated-liquidity position value as a FRACTION of the
 * all-quote (deposit) value, as a function of the active bin. Same closed form as
 * pnl-curve.js simulatePnlCurve(), re-parameterised on bins instead of price-rel:
 *   s = bin_step/1e4 ; price(bin) ∝ (1+s)^bin ; a=√P(lower) ; b=√P(upper)
 *   value/L =  P·(1/a − 1/b)         P <= P_lower  (all base)
 *              b − a                 P >= P_upper  (all quote)
 *              2√P − P/b − a         in range
 * Normalised by (b−a) so f(upper_bin) = 1 = the SOL deposit. Returns pnl in %.
 */
function cfPnlPct(bin, lowerBin, upperBin, binStep) {
  const s = binStep / 10_000;
  const P = (x) => Math.pow(1 + s, x);
  const Pa = P(lowerBin), Pb = P(upperBin);
  const a = Math.sqrt(Pa), b = Math.sqrt(Pb);
  const Pc = P(bin);
  let vPerL;
  if (Pc <= Pa) vPerL = Pc * (1 / a - 1 / b);
  else if (Pc >= Pb) vPerL = b - a;
  else vPerL = 2 * Math.sqrt(Pc) - Pc / b - a;
  return (vPerL / (b - a) - 1) * 100;
}

// ══════════════════════════════════════════════════════════════════════════
//  LOAD + ASSEMBLE PER-POSITION DATA
// ══════════════════════════════════════════════════════════════════════════
/** Pull the decision-time pnl out of a recorded close_reason string, if present. */
function decisionPnlFromReason(reason) {
  if (!reason) return null;
  let m = /stop loss: pnl\s*([+-]?[\d.]+)%/i.exec(reason);
  if (m) return Number(m[1]);
  m = /Young-token stop: PnL\s*([+-]?[\d.]+)%/i.exec(reason);
  if (m) return Number(m[1]);
  m = /Profit ratchet:.*?now\s*([+-]?[\d.]+)%/i.exec(reason);
  if (m) return Number(m[1]);
  m = /Trailing TP:.*?current\s*([+-]?[\d.]+)%/i.exec(reason);
  if (m) return Number(m[1]);
  return null; // LOW_YIELD / "pumped far above range" carry no pnl
}
/** Token age at deploy, only where the record actually proves it. */
function tokenAgeFromClose(rec, meta) {
  const direct = num(meta?.token_age_hours) ?? num(rec?.token_age_hours);
  if (direct != null) return direct;
  const m = /token\s+([\d.]+)h old at deploy/i.exec(rec?.close_reason || "");
  return m ? Number(m[1]) : null;
}
function familyOf(reason) {
  const r = (reason || "").toLowerCase();
  if (r.includes("stop loss")) return "stop_loss";
  if (r.includes("young-token stop")) return "young_stop";
  if (r.includes("profit ratchet")) return "ratchet";
  if (r.includes("trailing")) return "trailing_tp";
  if (r.includes("above range")) return "oor_above";
  if (r.includes("low yield")) return "low_yield";
  return "other";
}

function build(args) {
  const metaRows = readCsv(args.meta);
  const closes = JSON.parse(fs.readFileSync(args.closes, "utf8"));
  const closeBy = new Map();
  for (const c of closes) if (c.position) closeBy.set(c.position, c);

  const positions = new Map();
  for (const m of metaRows) {
    const addr = m.position_address;
    if (!addr) continue;
    const lower = num(m.lower_bin), upper = num(m.upper_bin), step = num(m.bin_step);
    positions.set(addr, {
      addr, name: m.pool_name, pool: m.pool_address,
      deployedMs: ms(m.deployed_at), closedMs: ms(m.closed_at),
      lower, upper, binStep: step,
      amountSol: num(m.amount_sol) ?? 1,
      strategy: m.strategy,
      metaPeak: num(m.peak_pnl_pct), metaRatchetArmed: m.ratchet_armed === "true",
      poller: [], socket: [],
      close: closeBy.get(addr) || null,
    });
  }

  // Stream ticks (44 MB) row-by-row.
  for (const t of readCsv(args.ticks)) {
    const p = positions.get(t.position_address);
    if (!p) continue;
    const at = ms(t.ts), bin = num(t.active_bin);
    if (at == null || bin == null) continue;
    if (t.source === "poller") {
      const pnl = num(t.pnl_pct);
      if (pnl != null) p.poller.push({ t: at, bin, pnl });
    } else {
      p.socket.push({ t: at, bin });
    }
  }

  for (const p of positions.values()) {
    p.poller.sort((x, y) => x.t - y.t);
    p.socket.sort((x, y) => x.t - y.t);
    const c = p.close;
    p.actualReason = c?.close_reason || null;
    p.actualFamily = familyOf(p.actualReason);
    p.actualRealizedPnl = num(c?.pnl_pct);
    p.actualDecisionPnl = decisionPnlFromReason(p.actualReason);
    p.tokenAgeHours = tokenAgeFromClose(c, p);
    p.postClose = c?.post_close || null;

    // Terminal pseudo-observation: (bin at close, decision-time pnl from the close
    // reason). This is the ONLY observation deep in a disaster's collapse zone, and
    // it anchors extrapolation there. Kept separate so it can be reported.
    p.terminal = null;
    if (p.closedMs != null && p.actualDecisionPnl != null) {
      let bin = null;
      for (const s of p.socket) { if (s.t <= p.closedMs) bin = s.bin; else break; }
      if (bin != null) p.terminal = { t: p.closedMs, bin, pnl: p.actualDecisionPnl, terminal: true };
    }
    p.obs = p.terminal ? p.poller.concat([p.terminal]) : p.poller.slice();
    p.obs.sort((x, y) => x.t - y.t);

    p.excluded = null;
    if (!p.poller.length) p.excluded = "no_poller_ticks";
    else if (!p.socket.length) p.excluded = "no_socket_ticks";
    else if (p.lower == null || p.upper == null || p.binStep == null) p.excluded = "no_bin_geometry";
    else if (p.closedMs == null) p.excluded = "still_open";
    else if (!p.close) p.excluded = "no_close_record";
  }
  return { positions, closes };
}

// ══════════════════════════════════════════════════════════════════════════
//  STEP 2 — bin→pnl MODEL + VALIDATION
// ══════════════════════════════════════════════════════════════════════════
/**
 * Per-position calibration of the closed-form's bin SENSITIVITY. Fits a single
 * scale k minimising Σ(Δpnl_observed − k·Δpnl_closedform)² over consecutive
 * observation pairs that actually moved bins. k≈1 → the uniform-CL geometry is
 * right; k≠1 → the real liquidity shape (bid_ask/spot/curve concentrates
 * differently) makes the position more/less bin-sensitive than uniform.
 * k is used ONLY for extrapolation outside the observed bin bracket.
 */
function calibrate(p) {
  let sxy = 0, sxx = 0, n = 0;
  const cf = (b) => cfPnlPct(b, p.lower, p.upper, p.binStep);
  for (let i = 1; i < p.obs.length; i++) {
    const A = p.obs[i - 1], B = p.obs[i];
    if (A.bin === B.bin) continue;
    const x = cf(B.bin) - cf(A.bin);
    const y = B.pnl - A.pnl;
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) < 1e-9) continue;
    sxy += x * y; sxx += x * x; n++;
  }
  const k = n >= 3 && sxx > 0 ? sxy / sxx : 1;
  // Clamp to a sane band — a wild fit on a noisy position must not manufacture
  // absurd extrapolations. Report when clamped.
  const kClamped = Math.min(3, Math.max(0.1, k));
  return { k: kClamped, kRaw: k, pairs: n, clamped: kClamped !== k };
}

/**
 * Modeled pnl at (t, bin).
 *   PRIMARY  "interp"  — linear interpolation in bin between the observations
 *                        bracketing t in time, when bin lies between their bins.
 *                        Both are within ~45 s, so fee drift is negligible.
 *   "time"             — bracketing obs are at the same bin → interpolate in time.
 *   FALLBACK "extrap"  — bin outside the local bracket → anchor on the temporally
 *                        nearest observation and add k·Δclosed-form. Theoretically
 *                        grounded (below range the position is 100% base, so value
 *                        is exactly linear in price) but UNVALIDATABLE where it
 *                        matters most; every use is counted.
 * Returns { pnl, method }.
 */
function makeModel(p, cal) {
  const obs = p.obs;
  const cf = (b) => cfPnlPct(b, p.lower, p.upper, p.binStep);
  return function modelPnl(t, bin) {
    if (!obs.length) return { pnl: null, method: "none" };
    let lo = -1;
    for (let i = 0; i < obs.length; i++) { if (obs[i].t <= t) lo = i; else break; }
    const A = lo >= 0 ? obs[lo] : null;
    const B = lo + 1 < obs.length ? obs[lo + 1] : null;

    if (A && B) {
      const bMin = Math.min(A.bin, B.bin), bMax = Math.max(A.bin, B.bin);
      if (A.bin !== B.bin && bin >= bMin && bin <= bMax) {
        const w = (bin - A.bin) / (B.bin - A.bin);
        return { pnl: A.pnl + w * (B.pnl - A.pnl), method: "interp" };
      }
      if (A.bin === B.bin && bin === A.bin) {
        const w = B.t === A.t ? 0 : (t - A.t) / (B.t - A.t);
        return { pnl: A.pnl + w * (B.pnl - A.pnl), method: "time" };
      }
    }
    const anchor = !A ? B : !B ? A : (t - A.t <= B.t - t ? A : B);
    if (!anchor) return { pnl: null, method: "none" };
    return { pnl: anchor.pnl + cal.k * (cf(bin) - cf(anchor.bin)), method: "extrap" };
  };
}

/**
 * Leave-one-out validation on every observed (bin, pnl) poller pair: hide obs i,
 * predict it from its neighbours with the SAME model code path, report the error.
 * Also validates the un-calibrated closed form (k=1) for comparison.
 */
function validate(p, cal) {
  const cf = (b) => cfPnlPct(b, p.lower, p.upper, p.binStep);
  const errs = [], errsCf = [], byMethod = { interp: [], time: [], extrap: [] };
  // Stratified by how far the bin actually moved across the hidden gap — the pooled
  // MAE is dominated by the ~50% of gaps where the bin did not move at all, which
  // tells us nothing about accuracy where the trigger would actually act.
  const byDisp = { d0: [], d1_3: [], d4_7: [], d8p: [] };
  for (let i = 1; i < p.poller.length - 1; i++) {
    const A = p.poller[i - 1], X = p.poller[i], B = p.poller[i + 1];
    let pred = null, method = null;
    const bMin = Math.min(A.bin, B.bin), bMax = Math.max(A.bin, B.bin);
    if (A.bin !== B.bin && X.bin >= bMin && X.bin <= bMax) {
      pred = A.pnl + ((X.bin - A.bin) / (B.bin - A.bin)) * (B.pnl - A.pnl);
      method = "interp";
    } else if (A.bin === B.bin && X.bin === A.bin) {
      const w = B.t === A.t ? 0 : (X.t - A.t) / (B.t - A.t);
      pred = A.pnl + w * (B.pnl - A.pnl);
      method = "time";
    } else {
      const anchor = X.t - A.t <= B.t - X.t ? A : B;
      pred = anchor.pnl + cal.k * (cf(X.bin) - cf(anchor.bin));
      method = "extrap";
    }
    const e = Math.abs(pred - X.pnl);
    if (Number.isFinite(e)) {
      errs.push(e); byMethod[method].push(e);
      const disp = Math.abs(A.bin - B.bin);
      (disp === 0 ? byDisp.d0 : disp <= 3 ? byDisp.d1_3 : disp <= 7 ? byDisp.d4_7 : byDisp.d8p).push(e);
    }
    // Un-calibrated closed form, one-step-ahead from the previous obs.
    const eCf = Math.abs(A.pnl + (cf(X.bin) - cf(A.bin)) - X.pnl);
    if (Number.isFinite(eCf)) errsCf.push(eCf);
  }
  const stat = (xs) => {
    const s = xs.slice().sort((a, b) => a - b);
    return { n: xs.length, mae: mean(xs), p90: quantile(s, 0.9), max: s.length ? s[s.length - 1] : null };
  };
  return {
    hybrid: stat(errs), closedForm: stat(errsCf),
    interp: stat(byMethod.interp), time: stat(byMethod.time), extrap: stat(byMethod.extrap),
    d0: stat(byDisp.d0), d1_3: stat(byDisp.d1_3), d4_7: stat(byDisp.d4_7), d8p: stat(byDisp.d8p),
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  STEP 1 — QUANTIFY THE BLIND SPOT
// ══════════════════════════════════════════════════════════════════════════
function blindSpot(p) {
  const gaps = [];
  for (let i = 1; i < p.poller.length; i++) {
    const A = p.poller[i - 1], B = p.poller[i];
    // Worst DOWNWARD excursion inside the gap, from the socket stream.
    let minBin = Math.min(A.bin, B.bin);
    for (const s of p.socket) {
      if (s.t < A.t) continue;
      if (s.t > B.t) break;
      if (s.bin < minBin) minBin = s.bin;
    }
    gaps.push({
      sec: (B.t - A.t) / 1000,
      sampledDown: A.bin - B.bin,        // as the poller SAW it
      trueDown: A.bin - minBin,          // what actually happened inside the gap
      hidden: (A.bin - minBin) - Math.max(0, A.bin - B.bin),
    });
  }
  const down = gaps.map((g) => g.trueDown).filter((v) => v > 0).sort((a, b) => a - b);
  return {
    gaps,
    nGaps: gaps.length,
    medianGapSec: quantile(gaps.map((g) => g.sec).sort((a, b) => a - b), 0.5),
    p95GapSec: quantile(gaps.map((g) => g.sec).sort((a, b) => a - b), 0.95),
    medianDown: quantile(down, 0.5), p90Down: quantile(down, 0.9),
    maxDown: down.length ? down[down.length - 1] : 0,
    maxHidden: gaps.reduce((m, g) => Math.max(m, g.hidden), 0),
    nGapsDown4: gaps.filter((g) => g.trueDown >= 4).length,
    nGapsDown8: gaps.filter((g) => g.trueDown >= 8).length,
    nGapsDown12: gaps.filter((g) => g.trueDown >= 12).length,
  };
}

// ══════════════════════════════════════════════════════════════════════════
//  STEP 3 — REPLAY THE TRIGGER
// ══════════════════════════════════════════════════════════════════════════
/**
 * @param {object} p        position bundle
 * @param {object} opts     { N, intervalSec, lagSec, confirm, ratchetEnabled, youngPolicy }
 *                          N=null → BASELINE (poller evaluations only, no bin trigger)
 * Returns { fired, rule, atMs, atBin, decisionPnl, exitBin, exitPnl, exitMethod, nForced, nExtrap }
 */
function replay(p, cal, model, opts) {
  const { N, intervalSec, lagSec, confirm, ratchetEnabled, youngPolicy } = opts;
  const isYoung = youngPolicy === "all"
    ? true
    : (p.tokenAgeHours != null && p.tokenAgeHours < RULES.youngStopMaxAgeHours);

  // Build the evaluation stream: all poller evals, plus forced evals from socket.
  // kind: "poller" (fast poller, 2-tick confirmed) | "mgmt" (10-min cron)
  //     |  "oor" (existing socket OOR force-sync) | "bin" (THE PROPOSED TRIGGER)
  const evals = p.poller.map((r) => ({ t: r.t, bin: r.bin, pnl: r.pnl, kind: "poller", method: "observed" }));
  let nForced = 0, nExtrap = 0;
  const binAt = (t) => { let b = null; for (const s of p.socket) { if (s.t <= t) b = s.bin; else break; } return b; };

  // ── EXISTING evaluation streams, present in BOTH baseline and counterfactual ──
  // (1) The 10-minute management cron (runManagementCycle). It calls
  //     confirmPeak(…, 1) — ONE tick, not two — and acts on exits/deterministic rules
  //     with no 2-tick confirmation (index.js:711-777). Several recorded trailing-TP
  //     closes only become explicable once this stream is modelled.
  const MGMT_INTERVAL_MS = 10 * 60_000;
  for (let t = p.deployedMs + MGMT_INTERVAL_MS; t <= p.closedMs; t += MGMT_INTERVAL_MS) {
    const bin = binAt(t);
    if (bin == null) continue;
    const m = model(t, bin);
    if (m.pnl == null) continue;
    evals.push({ t, bin, pnl: m.pnl, kind: "mgmt", method: m.method });
  }
  // (2) socket-monitor.handlePoolAccountChange() → triggerImmediateSync() the first
  //     time the position crosses OUT OF RANGE — in EITHER direction
  //     (`activeId < minBin || activeId > maxBin`), re-armed on return to range. The
  //     .force-sync file is picked up by the poller and runs runManagementCycle().
  //     This is what actually closed Syrax (OOR 11:00:44.97 → closed 11:01:10) and
  //     RAKO (OOR 02:51:00.5 → closed 02:51:13). Omitting it from the baseline would
  //     credit the bin trigger with saves the shipped code already makes.
  let wasOor = false;
  for (const s of p.socket) {
    const oor = s.bin < p.lower || s.bin > p.upper;
    if (oor && !wasOor) {
      const m = model(s.t, s.bin);
      if (m.pnl != null) {
        if (m.method === "extrap") nExtrap++;
        evals.push({ t: s.t, bin: s.bin, pnl: m.pnl, kind: "oor", method: m.method });
      }
    }
    wasOor = oor;
  }

  if (N != null) {
    // Walk socket + poller in time order, tracking last_eval_bin / last forced ts.
    const stream = p.poller.map((r) => ({ t: r.t, bin: r.bin, poller: true }))
      .concat(p.socket.map((r) => ({ t: r.t, bin: r.bin, poller: false })))
      .sort((a, b) => a.t - b.t || (a.poller ? -1 : 1));
    let lastEvalBin = p.poller.length ? p.poller[0].bin : null;
    let lastForcedT = -Infinity;
    for (const s of stream) {
      if (s.poller) { lastEvalBin = s.bin; continue; }
      if (lastEvalBin == null) continue;
      if (s.bin > lastEvalBin - N) continue;                     // not enough DOWN movement
      if ((s.t - lastForcedT) / 1000 < intervalSec) continue;    // min-interval throttle
      const m = model(s.t, s.bin);
      if (m.pnl == null) continue;
      if (m.method === "extrap") nExtrap++;
      evals.push({ t: s.t, bin: s.bin, pnl: m.pnl, kind: "bin", method: m.method });
      lastEvalBin = s.bin;
      lastForcedT = s.t;
      nForced++;
    }
  }
  evals.sort((a, b) => a.t - b.t || (a.kind === "poller" ? -1 : 1));

  // ── rule state (mirrors state.js position fields) ──
  // ratchetEnabled === "seeded": enable the ratchet AND start it already armed from
  // the position's RECORDED ratchet_armed flag. The 2-tick confirmed peak rebuilt from
  // 45 s poller samples tracks the live peak_pnl_pct to ~0.06 pp MAE, but it misses the
  // arm threshold on RAKO (replay 1.83 vs live 2.22 — the live peak was confirmed off
  // ticks we do not have). Seeding over-arms (armed earlier than reality), which is the
  // CONSERVATIVE direction for measuring how much harm the trigger could do once the
  // shallow −2% ratchet stop is live.
  const st = {
    peak: 0, pendingPeak: null, pendingPeakCount: 0,
    trailing: false, slSince: null, youngSince: null,
    armed: ratchetEnabled === "seeded" ? !!p.metaRatchetArmed : false, armedPeak: null,
    pendingExit: null, pendingCount: 0,
  };

  for (const e of evals) {
    // confirmPeak (state.js:769). The fast poller passes confirmTicks=2; the
    // management cron passes 1 (index.js:713).
    const peakTicks = e.kind === "mgmt" ? 1 : RULES.confirmTicks;
    if (e.pnl > st.peak) {
      if (st.pendingPeak != null && e.pnl >= st.pendingPeak) { st.pendingPeakCount++; st.pendingPeak = e.pnl; }
      else { st.pendingPeak = e.pnl; st.pendingPeakCount = 1; }
      if (st.pendingPeakCount >= peakTicks) {
        st.peak = Math.max(st.peak, st.pendingPeak);
        st.pendingPeak = null; st.pendingPeakCount = 0;
      }
    } else { st.pendingPeak = null; st.pendingPeakCount = 0; }

    // trailing activation
    if (RULES.trailingTakeProfit && !st.trailing && st.peak >= RULES.trailingTriggerPct) st.trailing = true;

    // Rule order is exactly updatePnlAndCheckExits: ratchet → young → stop → trailing.
    let signal = null;
    if (ratchetEnabled) {
      if (!st.armed && st.peak >= RULES.profitRatchetArmPct) { st.armed = true; st.armedPeak = st.peak; }
      if (st.armed && e.pnl <= RULES.profitRatchetStopPct) signal = "PROFIT_RATCHET";
    }
    if (!signal && isYoung && !st.armed && e.pnl <= RULES.youngStopPct) {
      if (st.youngSince == null) st.youngSince = e.t;
      else if (e.t - st.youngSince >= RULES.violatedConfirmMs) signal = "YOUNG_STOP";
    } else if (!(isYoung && !st.armed && e.pnl <= RULES.youngStopPct)) st.youngSince = null;

    if (!signal && e.pnl <= RULES.stopLossPct) {
      if (st.slSince == null) st.slSince = e.t;
      else if (e.t - st.slSince >= RULES.violatedConfirmMs) signal = "STOP_LOSS";
    } else if (e.pnl > RULES.stopLossPct) st.slSince = null;

    if (!signal && st.trailing && st.peak - e.pnl >= RULES.trailingDropPct) signal = "TRAILING_TP";

    // getDeterministicCloseRule (index.js:2357) — reached only when the above
    // returned nothing. RULE_1 has NO violated_since timer (this is why the recorded
    // Syrax/RAKO close_reason is the deterministic string).
    let deterministic = false;
    if (!signal) {
      if (e.pnl <= RULES.stopLossPct) { signal = "RULE_1_STOP"; deterministic = true; }
      else if (e.bin > p.upper + RULES.outOfRangeBinsToClose) { signal = "RULE_3_ABOVE"; deterministic = true; }
    }

    if (!signal) { st.pendingExit = null; st.pendingCount = 0; continue; }

    // Confirmation. The management-cycle path ("mgmt"/"oor", and "bin" too if the
    // trigger reuses triggerImmediateSync) has NO 2-tick confirmation — it acts on
    // the spot. Only the fast poller runs registerExitSignal's 2-tick streak.
    // confirm="poller" forces the PROPOSED bin trigger into the 2-tick poller stream
    // instead (the semantics the task specified); mgmt/oor stay immediate either way,
    // because that is what the shipped code does.
    let fire;
    if (e.kind === "mgmt" || e.kind === "oor" || (e.kind === "bin" && confirm === "hybrid")) {
      fire = true;
    } else {
      if (st.pendingExit === signal) st.pendingCount++;
      else { st.pendingExit = signal; st.pendingCount = 1; }
      fire = st.pendingCount >= RULES.confirmTicks;
      if (fire) { st.pendingExit = null; st.pendingCount = 0; }
    }
    if (!fire) continue;

    // Execution lag: take the modeled pnl at the post-lag bin, so we never credit
    // an instantaneous fill.
    const exitT = e.t + lagSec * 1000;
    let exitBin = e.bin;
    for (const s of p.socket) { if (s.t <= exitT) exitBin = s.bin; else break; }
    const em = model(exitT, exitBin);
    return {
      fired: true, rule: signal, deterministic,
      atMs: e.t, atBin: e.bin, kind: e.kind, evalMethod: e.method,
      decisionPnl: e.pnl,
      exitBin, exitPnl: em.pnl != null ? em.pnl : e.pnl, exitMethod: em.method,
      nForced, nExtrap, nEvals: evals.length,
    };
  }
  return { fired: false, nForced, nExtrap, nEvals: evals.length };
}

// ══════════════════════════════════════════════════════════════════════════
//  MAIN
// ══════════════════════════════════════════════════════════════════════════
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.ticks || !args.meta || !args.closes) {
    console.error("usage: bin_trigger_study.js --ticks ticks.csv --meta position_meta.csv --closes closes.json [--verbose]");
    process.exit(2);
  }
  const ratchetEnabled = args.ratchet === "on" ? true : args.ratchet === "seeded" ? "seeded" : false;
  console.log("═".repeat(112));
  console.log("BIN-MOVEMENT EXIT-TRIGGER STUDY — offline counterfactual (read-only)");
  console.log(`confirm=${args.confirm}  ratchet=${args.ratchet}  young=${args.young}  ` +
              `rules: SL${RULES.stopLossPct} trail ${RULES.trailingTriggerPct}/${RULES.trailingDropPct} ` +
              `young ${RULES.youngStopPct}@<${RULES.youngStopMaxAgeHours}h`);
  console.log("═".repeat(112));

  const { positions } = build(args);
  const all = [...positions.values()];
  const usable = all.filter((p) => !p.excluded);

  console.log(`\nCOVERAGE: ${all.length} positions in meta, ${usable.length} usable.`);
  for (const p of all.filter((x) => x.excluded)) {
    console.log(`  excluded  ${pad(p.name, 16)} ${p.addr.slice(0, 8)}  ${p.excluded}`);
  }

  // ── STEP 1: blind spot ────────────────────────────────────────────────
  console.log("\n" + "─".repeat(112));
  console.log("STEP 1 — THE BLIND SPOT: active-bin movement between consecutive POLLER samples");
  console.log("─".repeat(112));
  console.log(pad("pool", 16) + pad("gaps", 6) + pad("medGap", 8) + pad("p95Gap", 8) +
              pad("medDown", 9) + pad("p90Down", 9) + pad("maxDown", 9) + pad("maxHidden", 11) +
              pad(">=4 / >=8 / >=12 bins down", 28));
  for (const p of usable) {
    p.bs = blindSpot(p);
    const b = p.bs;
    console.log(pad(p.name, 16) + pad(b.nGaps, 6) + pad(f1(b.medianGapSec, 5) + "s", 8) +
      pad(f1(b.p95GapSec, 5) + "s", 8) + pad(f1(b.medianDown, 6), 9) + pad(f1(b.p90Down, 6), 9) +
      pad(b.maxDown, 9) + pad(b.maxHidden, 11) +
      pad(`${b.nGapsDown4} / ${b.nGapsDown8} / ${b.nGapsDown12}`, 28) +
      (DISASTERS.has(p.name) ? "  ← disaster" : ""));
  }
  const allGaps = usable.flatMap((p) => p.bs.gaps);
  const allDown = allGaps.map((g) => g.trueDown).sort((a, b) => a - b);
  console.log(`\n  pooled: ${allGaps.length} inter-sample gaps; median gap ` +
    `${f1(quantile(allGaps.map((g) => g.sec).sort((a, b) => a - b), 0.5), 4)}s, ` +
    `p99 gap ${f1(quantile(allGaps.map((g) => g.sec).sort((a, b) => a - b), 0.99), 4)}s`);
  console.log(`  pooled downward movement inside one gap: median ${f1(quantile(allDown, 0.5), 4)}, ` +
    `p90 ${f1(quantile(allDown, 0.9), 4)}, p99 ${f1(quantile(allDown, 0.99), 4)}, max ${allDown[allDown.length - 1]} bins`);
  console.log(`  gaps hiding >=8 bins of downward movement: ` +
    `${allGaps.filter((g) => g.trueDown >= 8).length}/${allGaps.length} ` +
    `(${(100 * allGaps.filter((g) => g.trueDown >= 8).length / allGaps.length).toFixed(1)}%)`);

  // ── STEP 1b: is the threshold even REACHABLE before the OOR trigger? ──
  // The decisive structural question. socket-monitor ALREADY force-syncs on the OOR
  // crossing, so a denser IN-RANGE evaluation clock can only help for a threshold the
  // position actually crosses WHILE STILL IN RANGE. For a single-sided SOL ladder the
  // whole in-range excursion is bounded by the geometry: at the bottom of a 119-bin
  // range the position is only ~a/b − 1 down, which for these bin steps is nowhere
  // near −15%.
  console.log("\n" + "─".repeat(112));
  console.log("STEP 1b — IN-RANGE HEADROOM: can each threshold even be crossed BEFORE the existing OOR trigger?");
  console.log("─".repeat(112));
  console.log(pad("pool", 16) + pad("bins", 6) + pad("step", 6) + pad("minPnL in-range", 16) +
              pad("minPnL any", 12) + pad("SL−15?", 8) + pad("young−10?", 11) + pad("ratchet−2?", 12) + "actual rule");
  for (const p of usable) {
    const inR = p.poller.filter((r) => r.bin >= p.lower && r.bin <= p.upper).map((r) => r.pnl);
    const minIn = inR.length ? Math.min(...inR) : null;
    const minAny = p.poller.length ? Math.min(...p.poller.map((r) => r.pnl)) : null;
    p.minInRangePnl = minIn;
    const reach = (thr) => (minIn == null ? "?" : minIn <= thr ? "YES" : "no");
    console.log(pad(p.name, 16) + pad(p.upper - p.lower, 6) + pad(p.binStep, 6) +
      pad(f2(minIn, 8), 16) + pad(f2(minAny, 8), 12) + pad(reach(RULES.stopLossPct), 8) +
      pad(reach(RULES.youngStopPct), 11) + pad(reach(RULES.profitRatchetStopPct), 12) + p.actualFamily +
      (DISASTERS.has(p.name) ? "   ← disaster" : ""));
  }
  const nSlReach = usable.filter((p) => p.minInRangePnl != null && p.minInRangePnl <= RULES.stopLossPct).length;
  const nYoungReach = usable.filter((p) => p.minInRangePnl != null && p.minInRangePnl <= RULES.youngStopPct).length;
  const nRatReach = usable.filter((p) => p.minInRangePnl != null && p.minInRangePnl <= RULES.profitRatchetStopPct).length;
  console.log(`\n  the −15% stop is reachable while in range on ${nSlReach}/${usable.length} positions;`);
  console.log(`  the −10% young stop on ${nYoungReach}/${usable.length}; the −2% ratchet stop on ${nRatReach}/${usable.length}.`);
  console.log("  → Wherever the stop is NOT reachable in range, the shipped OOR force-sync is already the");
  console.log("    first evaluation that can possibly fire it, and NO in-range trigger density can help.");

  // ── STEP 2: model + validation ────────────────────────────────────────
  console.log("\n" + "─".repeat(112));
  console.log("STEP 2 — bin→pnl MODEL VALIDATION (leave-one-out over every observed poller (bin,pnl) pair)");
  console.log("─".repeat(112));
  console.log(pad("pool", 16) + pad("obs", 6) + pad("k(cf scale)", 12) + pad("LOO n", 7) +
              pad("MAE pp", 9) + pad("p90 pp", 9) + pad("max pp", 9) + pad("cf-only MAE", 13) + "method mix");
  for (const p of usable) {
    p.cal = calibrate(p);
    p.model = makeModel(p, p.cal);
    p.val = validate(p, p.cal);
    const v = p.val;
    console.log(pad(p.name, 16) + pad(p.obs.length, 6) +
      pad(f2(p.cal.k, 5) + (p.cal.clamped ? "*" : ""), 12) + pad(v.hybrid.n, 7) +
      pad(f2(v.hybrid.mae, 6), 9) + pad(f2(v.hybrid.p90, 6), 9) + pad(f2(v.hybrid.max, 6), 9) +
      pad(f2(v.closedForm.mae, 6), 13) +
      `interp ${v.interp.n} / time ${v.time.n} / extrap ${v.extrap.n}`);
  }
  const pooled = (sel) => {
    const xs = usable.flatMap((p) => {
      const s = sel(p.val);
      return s.n ? [{ mae: s.mae, n: s.n, max: s.max }] : [];
    });
    const tot = xs.reduce((s, x) => s + x.n, 0);
    return { n: tot, mae: tot ? xs.reduce((s, x) => s + x.mae * x.n, 0) / tot : null, max: Math.max(...xs.map((x) => x.max)) };
  };
  const ph = pooled((v) => v.hybrid), pc = pooled((v) => v.closedForm);
  const pi = pooled((v) => v.interp), pe = pooled((v) => v.extrap);
  console.log(`\n  POOLED  hybrid model : n=${ph.n}  MAE ${f2(ph.mae, 5)} pp  max ${f2(ph.max, 5)} pp`);
  console.log(`  POOLED  interp only  : n=${pi.n}  MAE ${f2(pi.mae, 5)} pp  max ${f2(pi.max, 5)} pp   ← the path the replay mostly uses`);
  console.log(`  POOLED  extrap only  : n=${pe.n}  MAE ${f2(pe.mae, 5)} pp  max ${f2(pe.max, 5)} pp   ← fallback, weakest`);
  console.log(`  POOLED  uncalibrated closed form (pnl-curve.js geometry, k=1): n=${pc.n}  MAE ${f2(pc.mae, 5)} pp  max ${f2(pc.max, 5)} pp`);
  console.log("\n  STRATIFIED by how far the bin actually moved across the hidden gap (the pooled MAE above is");
  console.log("  flattered by the ~half of gaps where the bin never moved — those need no model at all):");
  for (const [label, sel] of [["bin moved 0", (v) => v.d0], ["1–3 bins", (v) => v.d1_3],
                              ["4–7 bins", (v) => v.d4_7], [">=8 bins", (v) => v.d8p]]) {
    const s = pooled(sel);
    console.log(`    ${pad(label, 14)} n=${String(s.n).padStart(5)}  MAE ${f2(s.mae, 5)} pp  max ${f2(s.max, 5)} pp`);
  }
  console.log("  → >=8-bin gaps are the regime the trigger exists for, and they are also where the model is");
  console.log("    weakest. Read every counterfactual pnl below with that error bar attached.");
  console.log("  → the closed form alone is NOT usable at this scale; the replay uses the empirical");
  console.log("    bracket interpolation, with the k-calibrated closed form only for extrapolation.");
  console.log("  → fee accrual is NOT in the model: fees only ever ADD to pnl over time, so a modeled");
  console.log("    counterfactual pnl is biased LOW (pessimistic about the counterfactual) — the bias");
  console.log("    direction FAVOURS the null hypothesis, i.e. it cannot manufacture a fake saving.");

  // ── STEP 3/4: fidelity check + grid ───────────────────────────────────
  console.log("\n" + "─".repeat(112));
  console.log("STEP 3a — ENGINE FIDELITY: baseline replay (poller evaluations only, NO bin trigger)");
  console.log("           must reproduce what actually happened, or nothing downstream is trustworthy.");
  console.log("─".repeat(112));
  console.log(pad("pool", 16) + pad("actual rule", 13) + pad("act.dec", 9) + pad("act.real", 10) +
              pad("replay rule", 14) + pad("replay dec", 11) + pad("match?", 8));
  // One baseline PER LAG value: the execution lag applies identically to the shipped
  // code and to the counterfactual, so comparing a lag-0 baseline against a lag-15
  // counterfactual would fabricate a delta out of nothing (an earlier version of this
  // script did exactly that).
  const baselineFor = (p, lagSec) =>
    replay(p, p.cal, p.model, { N: null, intervalSec: 0, lagSec, confirm: args.confirm, ratchetEnabled, youngPolicy: args.young });
  const famOf = (rule) => !rule ? "none"
    : rule === "YOUNG_STOP" ? "young_stop"
    : rule === "PROFIT_RATCHET" ? "ratchet"
    : rule === "TRAILING_TP" ? "trailing_tp"
    : rule === "RULE_3_ABOVE" ? "oor_above"
    : rule.includes("STOP") ? "stop_loss" : "other";
  let fidOk = 0, fidTot = 0;
  for (const p of usable) {
    p.baseByLag = new Map(GRID_LAG_SEC.map((l) => [l, baselineFor(p, l)]));
    p.base = baselineFor(p, GRID_LAG_SEC[GRID_LAG_SEC.length - 1]); // reference baseline for display
    const rr = p.base.fired ? p.base.rule : "—";
    const fam = famOf(p.base.fired ? p.base.rule : null);
    // A no-fire baseline is CORRECT for the time/fee rules this engine omits.
    const omitted = p.actualFamily === "low_yield";
    const match = omitted ? (fam === "none" ? "n/a-ok" : "EXTRA") : (fam === p.actualFamily ? "yes" : "NO");
    if (!omitted) { fidTot++; if (match === "yes") fidOk++; }
    p.fidelity = match;
    console.log(pad(p.name, 16) + pad(p.actualFamily, 13) + pad(f2(p.actualDecisionPnl, 7), 9) +
      pad(f2(p.actualRealizedPnl, 8), 10) + pad(rr, 14) + pad(f2(p.base.decisionPnl, 9), 11) + pad(match, 8));
  }
  console.log(`\n  fidelity on bin/pnl-driven closes: ${fidOk}/${fidTot} rule families reproduced.`);
  console.log("  (low_yield closes are 'n/a-ok': that rule is fee-driven and deliberately not modelled.)");
  console.log("  Every 'NO' row above has ONE shared cause: the tick series ENDS at the close, so the");
  console.log("  evaluation that actually fired — the read immediately after the last recorded tick — is");
  console.log("  not in the data, and a 2-tick confirmation cannot complete inside the window. Check: each");
  console.log("  'NO' row's act.dec equals the LAST recorded poller pnl or lies just past it. Consequence:");
  console.log("  the baseline is systematically a touch LATE (or silent) on trailing-TP, which biases this");
  console.log("  study TOWARD finding the trigger helpful. Non-firing baselines fall back to the recorded");
  console.log("  decision pnl in the grid below, which removes most of that bias.");

  // ── the grid ──────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(112));
  console.log("STEP 4 — GRID: net effect of the bin trigger, measured against the SAME-RULES baseline");
  console.log("─".repeat(112));
  console.log("  Δ is decision-time modeled pnl: cf_exit_pnl − baseline_exit_pnl (pp), then × amount_sol/100 → SOL.");
  console.log("  Measuring against the baseline replay (not the recorded outcome) isolates the TRIGGER from");
  console.log("  rule-set drift and from the decision→realized execution gap. Recorded-outcome deltas follow.\n");
  console.log(pad("N", 4) + pad("int", 6) + pad("lag", 6) + pad("changed", 9) + pad("helped", 8) +
              pad("hurt", 7) + pad("ΣSOL Δ", 10) + pad("disasters ΣSOL", 16) + pad("others ΣSOL", 14) +
              pad("forced evals", 14) + pad("%extrap", 9));
  const cells = [];
  for (const N of GRID_N) {
    for (const intervalSec of GRID_INTERVAL_SEC) {
      for (const lagSec of GRID_LAG_SEC) {
        const cell = { N, intervalSec, lagSec, rows: [], solDelta: 0, disasterSol: 0, otherSol: 0, helped: 0, hurt: 0, changed: 0, forced: 0, extrap: 0 };
        for (const p of usable) {
          const base = p.baseByLag.get(lagSec);
          const cf = replay(p, p.cal, p.model, { N, intervalSec, lagSec, confirm: args.confirm, ratchetEnabled, youngPolicy: args.young });
          cell.forced += cf.nForced; cell.extrap += cf.nExtrap;
          // When a replay does not fire (see the fidelity note: the deciding read is
          // often the one AFTER the last recorded tick), fall back to the RECORDED
          // DECISION pnl, not the realized one — the counterfactual number is itself a
          // decision-time number, so this keeps the comparison like-for-like.
          const fallback = p.actualDecisionPnl != null ? p.actualDecisionPnl : p.actualRealizedPnl;
          const basePnl = base.fired ? base.exitPnl : fallback;
          const cfPnl = cf.fired ? cf.exitPnl : fallback;
          const dPct = (cfPnl != null && basePnl != null) ? cfPnl - basePnl : 0;
          const changed = cf.fired && base.fired && Math.abs(cf.atMs - base.atMs) > 1000;
          const dSol = (dPct / 100) * p.amountSol;
          if (changed && Math.abs(dPct) > 0.05) {
            cell.changed++;
            if (dPct > 0) cell.helped++; else cell.hurt++;
          }
          cell.solDelta += dSol;
          if (DISASTERS.has(p.name)) cell.disasterSol += dSol; else cell.otherSol += dSol;
          cell.rows.push({ p, cf, base, dPct, dSol, changed });
        }
        cells.push(cell);
        console.log(pad(N, 4) + pad(intervalSec + "s", 6) + pad(lagSec + "s", 6) + pad(cell.changed, 9) +
          pad(cell.helped, 8) + pad(cell.hurt, 7) + pad(f2(cell.solDelta, 8), 10) +
          pad(f2(cell.disasterSol, 8), 16) + pad(f2(cell.otherSol, 8), 14) +
          pad(cell.forced, 14) + pad(cell.forced ? (100 * cell.extrap / cell.forced).toFixed(0) + "%" : "—", 9));
      }
    }
  }

  // best cell by net SOL
  const best = cells.slice().sort((a, b) => b.solDelta - a.solDelta)[0];
  console.log(`\n  best cell by net SOL: N=${best.N} interval=${best.intervalSec}s lag=${best.lagSec}s  → ${f2(best.solDelta, 6)} SOL`);
  const positiveCells = cells.filter((c) => c.solDelta > 0).length;
  console.log(`  robustness: ${positiveCells}/${cells.length} grid cells net-positive; ` +
    `range ${f2(Math.min(...cells.map((c) => c.solDelta)), 6)} … ${f2(Math.max(...cells.map((c) => c.solDelta)), 6)} SOL`);

  // ── per-position ledger for the best cell ─────────────────────────────
  console.log("\n" + "─".repeat(112));
  console.log(`STEP 4b — PER-POSITION LEDGER  (cell N=${best.N}, interval=${best.intervalSec}s, lag=${best.lagSec}s)`);
  console.log("─".repeat(112));
  console.log(pad("pool", 16) + pad("SOL", 6) + pad("actual rule", 12) + pad("act.real", 9) +
              pad("base rule", 12) + pad("base pnl", 9) + pad("cf rule", 12) + pad("cf pnl", 8) +
              pad("Δpp", 8) + pad("ΔSOL", 8) + pad("earlier", 9) + "method");
  const ledger = best.rows.slice().sort((a, b) => a.dSol - b.dSol);
  for (const r of ledger) {
    const { p, cf, base } = r;
    const earlier = (cf.fired && base.fired) ? ((base.atMs - cf.atMs) / 1000).toFixed(0) + "s" : "—";
    console.log(pad(p.name, 16) + pad(p.amountSol, 6) + pad(p.actualFamily, 12) +
      pad(f2(p.actualRealizedPnl, 7), 9) + pad(base.fired ? base.rule : "—", 12) +
      pad(f2(base.exitPnl, 7), 9) + pad(cf.fired ? cf.rule : "—", 12) +
      pad(f2(cf.exitPnl, 6), 8) + pad(f2(r.dPct, 6), 8) + pad(f2(r.dSol, 6), 8) +
      pad(earlier, 9) + (cf.fired ? `${cf.kind}/${cf.exitMethod}` : ""));
  }

  // ── harm cases, named ─────────────────────────────────────────────────
  // ── TRUNCATION TEST (the bank's repeatedly-confirmed failure mode) ─────
  // An earlier exit is only a gain if the position never traded higher afterwards.
  // This is DIRECTLY OBSERVABLE: take the max recorded poller pnl strictly after the
  // counterfactual exit time and compare it to the counterfactual exit pnl. Positive
  // "regret" = the denser clock closed a position that went on to do better. This is
  // the honest test of "does firing sooner truncate the right tail".
  console.log("\n  TRUNCATION TEST — max recorded pnl AFTER the counterfactual exit (regret):");
  console.log("    " + pad("pool", 16) + pad("cf exit", 9) + pad("max pnl after", 15) +
              pad("regret pp", 11) + pad("base exit", 11) + pad("base regret", 12) + "verdict");
  let cfRegretSum = 0, baseRegretSum = 0;
  for (const r of ledger) {
    const { p, cf, base } = r;
    if (!cf.fired) continue;
    const after = p.poller.filter((x) => x.t > cf.atMs).map((x) => x.pnl);
    const maxAfter = after.length ? Math.max(...after) : null;
    const regret = maxAfter != null ? maxAfter - cf.exitPnl : null;
    const afterB = base.fired ? p.poller.filter((x) => x.t > base.atMs).map((x) => x.pnl) : [];
    const maxAfterB = afterB.length ? Math.max(...afterB) : null;
    const regretB = (maxAfterB != null && base.fired) ? maxAfterB - base.exitPnl : null;
    if (regret != null && regret > 0) cfRegretSum += (regret / 100) * p.amountSol;
    if (regretB != null && regretB > 0) baseRegretSum += (regretB / 100) * p.amountSol;
    const verdict = regret == null ? "no data after exit"
      : regret > 0.5 ? "TRUNCATED — later traded higher"
      : regret > 0 ? "marginal" : "clean (never recovered)";
    console.log("    " + pad(p.name, 16) + pad(f2(cf.exitPnl, 7), 9) + pad(f2(maxAfter, 8), 15) +
      pad(f2(regret, 8), 11) + pad(f2(base.fired ? base.exitPnl : null, 8), 11) +
      pad(f2(regretB, 8), 12) + verdict);
  }
  console.log(`\n    Σ counterfactual regret ${f2(cfRegretSum, 6)} SOL   vs   Σ baseline regret ${f2(baseRegretSum, 6)} SOL`);
  console.log("    (regret is an UPPER bound on truncation cost — it credits perfect foresight of the later");
  console.log("     high, and the later high is only observable because the real position stayed open.)");

  console.log("\n  HARM CASES (counterfactual exits earlier AND worse):");
  const harmed = ledger.filter((r) => r.changed && r.dPct < -0.05);
  if (!harmed.length) console.log("    none in this cell.");
  for (const r of harmed) {
    console.log(`    ${pad(r.p.name, 16)} Δ${f2(r.dPct, 6)}pp (${f2(r.dSol, 6)} SOL)  ` +
      `base ${r.base.rule}@${f2(r.base.exitPnl, 6)}% → cf ${r.cf.rule}@${f2(r.cf.exitPnl, 6)}% ` +
      `${((r.base.atMs - r.cf.atMs) / 1000).toFixed(0)}s earlier, exit bin ${r.base.exitBin}→${r.cf.exitBin}`);
  }
  console.log("\n  HELP CASES:");
  const helped = ledger.filter((r) => r.changed && r.dPct > 0.05);
  if (!helped.length) console.log("    none in this cell.");
  for (const r of helped) {
    console.log(`    ${pad(r.p.name, 16)} Δ+${f2(r.dPct, 5)}pp (+${f2(r.dSol, 5)} SOL)  ` +
      `base ${r.base.rule}@${f2(r.base.exitPnl, 6)}% → cf ${r.cf.rule}@${f2(r.cf.exitPnl, 6)}% ` +
      `${((r.base.atMs - r.cf.atMs) / 1000).toFixed(0)}s earlier, exit bin ${r.base.exitBin}→${r.cf.exitBin}`);
  }

  // ── vs the RECORDED outcome (the number an operator will ask for) ─────
  console.log("\n" + "─".repeat(112));
  console.log("STEP 4c — vs the RECORDED outcome (decision-time comparison, and the realized gap)");
  console.log("─".repeat(112));
  console.log("  actual decision pnl = the pnl in the recorded close_reason; actual realized = perf.pnl_pct.");
  console.log("  The gap between them is execution (further decline + withdrawal at a lower bin). Our modeled");
  console.log("  counterfactual pnl is a DECISION-time number, so decision-vs-decision is the like-for-like row.\n");
  console.log(pad("pool", 16) + pad("act.dec", 9) + pad("act.real", 10) + pad("exec gap", 10) +
              pad("cf dec", 9) + pad("Δ vs act.dec", 14) + pad("Δ vs act.real", 14));
  let sumVsDec = 0, sumVsReal = 0;
  for (const r of ledger) {
    const { p, cf } = r;
    if (!cf.fired) continue;
    const gap = (p.actualRealizedPnl != null && p.actualDecisionPnl != null) ? p.actualRealizedPnl - p.actualDecisionPnl : null;
    const dDec = p.actualDecisionPnl != null ? cf.exitPnl - p.actualDecisionPnl : null;
    const dReal = p.actualRealizedPnl != null ? cf.exitPnl - p.actualRealizedPnl : null;
    if (dDec != null) sumVsDec += (dDec / 100) * p.amountSol;
    if (dReal != null) sumVsReal += (dReal / 100) * p.amountSol;
    console.log(pad(p.name, 16) + pad(f2(p.actualDecisionPnl, 7), 9) + pad(f2(p.actualRealizedPnl, 8), 10) +
      pad(f2(gap, 8), 10) + pad(f2(cf.exitPnl, 7), 9) + pad(f2(dDec, 12), 14) + pad(f2(dReal, 12), 14));
  }
  console.log(`\n  Σ vs recorded decision pnl: ${f2(sumVsDec, 6)} SOL      Σ vs recorded realized pnl: ${f2(sumVsReal, 6)} SOL`);
  console.log("  (the second number silently credits the trigger with avoiding execution slippage it was");
  console.log("   never modelled to avoid — treat the first as the honest one.)");

  // ── post-close corroboration for the disasters ────────────────────────
  console.log("\n" + "─".repeat(112));
  console.log("STEP 4d — post-close probe cross-check (did the pool keep collapsing after our real exit?)");
  console.log("─".repeat(112));
  console.log("  " + pad("pool", 16) + pad("verdict", 12) + pad("+30m", 9) + pad("+60m", 9) + pad("+180m", 9) + "reading");
  for (const p of usable) {
    if (!p.postClose) continue;
    const pc = p.postClose;
    const g = (k) => (pc[k] && pc[k].pct != null ? (pc[k].pct > 0 ? "+" : "") + Number(pc[k].pct).toFixed(1) + "%" : (pc[k]?.status || "—"));
    const verdict = pc.exit_quality?.verdict ?? "?";
    const m30 = pc.m30?.pct, m180 = pc.m180?.pct;
    const reading = m30 == null ? ""
      : m30 > 5 ? "pool ROSE after our exit → we sold a local bottom"
      : m180 != null && m180 > -5 && m30 < -20 ? "collapsed then RECOVERED → exit good vs +30m, wrong vs +180m"
      : m30 < -20 ? "kept collapsing → earlier exit corroborated as better" : "roughly flat";
    console.log("  " + pad(p.name, 16) + pad(verdict, 12) + pad(g("m30"), 9) + pad(g("m60"), 9) +
      pad(g("m180"), 9) + reading + (DISASTERS.has(p.name) ? "   ← disaster" : ""));
  }

  // ── STEP 4e — the cost this whole study does NOT measure ───────────────
  console.log("\n" + "─".repeat(112));
  console.log("STEP 4e — RECORDED EXIT-SWAP SLIPPAGE (the cost pnl_pct excludes — for scale)");
  console.log("─".repeat(112));
  console.log("  " + pad("pool", 16) + pad("market_usd", 12) + pad("received", 10) + pad("slippage_usd", 14) +
              pad("slip %", 9) + pad("deployed SOL", 13) + "vs the pp this study moves");
  let slipTotal = 0;
  for (const p of usable) {
    const es = p.close?.exit_swap;
    if (!es || es.market_usd == null) continue;
    const slipPct = es.market_usd > 0 ? (100 * es.slippage_usd) / es.market_usd : null;
    slipTotal += Number(es.slippage_usd) || 0;
    console.log("  " + pad(p.name, 16) + pad(f2(num(es.market_usd), 9), 12) + pad(f2(num(es.value_usd), 8), 10) +
      pad(f2(num(es.slippage_usd), 9), 14) + pad(f1(slipPct, 6) + "%", 9) + pad(p.amountSol, 13) +
      (DISASTERS.has(p.name) ? "  ← disaster" : ""));
  }
  console.log(`\n  Σ recorded exit-swap slippage over the usable set: $${slipTotal.toFixed(2)}.`);
  console.log("  This is a SEPARATELY RECORDED cost that pnl_pct (a pre-swap market-value measure) omits");
  console.log("  entirely, and on the two big disasters it is ~47% of the base-token remainder's market");
  console.log("  value — one to two orders of magnitude larger than anything the evaluation clock moves.");

  if (args.verbose) {
    console.log("\n" + "─".repeat(112));
    console.log("VERBOSE — worst inter-sample gaps across the dataset");
    console.log("─".repeat(112));
    const worst = usable.flatMap((p) => p.bs.gaps.map((g) => ({ ...g, name: p.name }))).sort((a, b) => b.trueDown - a.trueDown).slice(0, 15);
    for (const g of worst) {
      console.log(`  ${pad(g.name, 16)} gap ${f1(g.sec, 5)}s  poller saw ${String(g.sampledDown).padStart(4)} bins down, ` +
        `actual excursion ${String(g.trueDown).padStart(4)} bins  (hidden ${g.hidden})`);
    }
  }

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({
      generated_at: new Date().toISOString(),
      rules: RULES, opts: { confirm: args.confirm, ratchet: args.ratchet, young: args.young },
      coverage: { total: all.length, usable: usable.length, excluded: all.filter((p) => p.excluded).map((p) => ({ name: p.name, reason: p.excluded })) },
      model: { pooled_hybrid: ph, pooled_interp: pi, pooled_extrap: pe, pooled_closed_form: pc },
      grid: cells.map((c) => ({ N: c.N, intervalSec: c.intervalSec, lagSec: c.lagSec, solDelta: c.solDelta, disasterSol: c.disasterSol, otherSol: c.otherSol, helped: c.helped, hurt: c.hurt, changed: c.changed })),
      best: { N: best.N, intervalSec: best.intervalSec, lagSec: best.lagSec, solDelta: best.solDelta },
      ledger: ledger.map((r) => ({
        name: r.p.name, amount_sol: r.p.amountSol, actual_family: r.p.actualFamily,
        actual_decision_pnl: r.p.actualDecisionPnl, actual_realized_pnl: r.p.actualRealizedPnl,
        base_rule: r.base.rule ?? null, base_pnl: r.base.exitPnl ?? null,
        cf_rule: r.cf.rule ?? null, cf_pnl: r.cf.exitPnl ?? null,
        delta_pp: r.dPct, delta_sol: r.dSol, changed: r.changed,
      })),
    }, null, 2));
    console.log(`\nwrote ${args.json}`);
  }
  console.log("");
}

main();
