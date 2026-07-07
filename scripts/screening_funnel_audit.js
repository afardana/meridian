#!/usr/bin/env node
/**
 * screening_funnel_audit.js — READ-ONLY screening funnel diagnostic.
 *
 * Purpose
 * -------
 * Production screening has been starved (zero deploys). This standalone script
 * answers: "of ALL pools currently available on the Meteora Pool Discovery API,
 * where exactly does each die in our metric filter funnel, and what would pass
 * if we relaxed which thresholds?"
 *
 * It faithfully replicates the METRIC portion of the real funnel in
 * tools/screening.js (getRawPoolScreeningRejectReason + the getTopCandidates
 * secondary metric filter), in the same order and with the same comparison
 * semantics and API field names. Stages that require API keys / heavy per-pool
 * enrichment (Jupiter token holders / bundler checks, narratives, LPAgent study,
 * smart-wallet lookups, GMGN dev-info, TVL-drain history, cooldowns, indicator
 * confirmation) are SKIPPED and listed in the closing NOTE — mass attrition
 * happens in the metric filters, which is where this focuses.
 *
 * It opens NO database, reads NO .env, imports NO project modules (state.js /
 * db / config.js all carry env/Postgres side effects). Everything needed is
 * inlined here with source references. `fetch` is a Node 22 global.
 *
 * Usage
 * -----
 *   node scripts/screening_funnel_audit.js
 *   node scripts/screening_funnel_audit.js --config '{"minFeeActiveTvlRatio":0.2,"minTvl":20000}'
 *
 * The default CONFIG (DEFAULT_LIVE_CONFIG below) hardcodes the LIVE PRODUCTION
 * values as of the starvation report (1h / trending, tvl 50k-250k, feeRatio
 * >= 0.49, organic >= 81, etc.). --config merges a JSON override on top.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

// Live production screening values (as reported for the starvation incident).
// These mirror config.screening keys; see config.js for the shipped defaults.
const DEFAULT_LIVE_CONFIG = {
  timeframe: "1h",
  category: "trending",
  minTvl: 50_000,
  maxTvl: 250_000,
  minVolume: 1_000,
  minOrganic: 81, // base_token_organic_score floor
  minQuoteOrganic: 70, // quote_token_organic_score floor
  minHolders: 500,
  minLps: 5, // total_lps floor (minLps > 0 activates the total-LP gate)
  minMcap: 500_000,
  maxMcap: 10_000_000,
  minBinStep: 80,
  maxBinStep: 125,
  minFeeActiveTvlRatio: 0.49, // RAW ratio, not percent (see note below)
  minTokenAgeHours: 2,
  maxTokenAgeHours: 720,
  minIntelScore: 52, // computed on the condensed pool (client-side)
  // The keys below are in the LIVE config but are NOT metric filters on the
  // Meteora path — carried here only so the audit can flag them as inert:
  minTokenFeesSol: 30, // enforced downstream via token/GMGN enrichment, not screening.js metrics
  maxTop10Pct: 60, // Jupiter-audit gate, not in the metric chain
  athFilterPct: 30, // GMGN-only (config.gmgn.athFilterPct); no Meteora effect
  excludeHighSupplyConcentration: true,
};

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MAX_REQUESTS = 30; // hard cap on total HTTP requests (task constraint)
const PAGE_SIZE = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers (faithful copies of tools/screening.js semantics)
// ─────────────────────────────────────────────────────────────────────────────

// tools/screening.js:92 numeric()
function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// tools/screening.js:98 isUsableVolatility()
function isUsableVolatility(value) {
  const n = numeric(value);
  return n != null && n > 0;
}

// tools/screening.js:109 getPoolLaunchpad()
function getPoolLaunchpad(pool) {
  const base = pool?.token_x || {};
  return (
    base?.launchpad ||
    base?.launchpad_platform ||
    pool?.base_token_launchpad ||
    pool?.launchpad ||
    pool?.launchpad_platform ||
    null
  );
}

function short(addr) {
  return typeof addr === "string" && addr.length > 12
    ? addr.slice(0, 6) + "…" + addr.slice(-4)
    : addr || "?";
}

function fmt(n, d = 0) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(d + 1) + "M";
  if (Math.abs(v) >= 1_000) return (v / 1_000).toFixed(d) + "k";
  return v.toFixed(d);
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}
function padL(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : " ".repeat(n - s.length) + s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inlined intel score (faithful copy of intel-score.js computeIntelScore).
// Inlined rather than imported because intel-score.js → config.js pulls in
// user-config.json / env side effects we must avoid in this standalone tool.
// On the Meteora discovery payload the GMGN/audit sub-fields are absent, so
// those components fall back to their neutral midpoints exactly as the real
// engine does — the score is deterministic from the condensed pool.
// Source: intel-score.js:42-518 (weights default 0.30/0.35/0.20/0.15).
// ─────────────────────────────────────────────────────────────────────────────

const INTEL_WEIGHTS = { safety: 0.3, yield: 0.35, momentum: 0.2, trust: 0.15 };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (v, inLo, inHi, outLo, outHi) => {
  const t = clamp((v - inLo) / (inHi - inLo || 1), 0, 1);
  return outLo + t * (outHi - outLo);
};
const inum = (val, fb = 0) => {
  const n = Number(val);
  return Number.isFinite(n) ? n : fb;
};

function scoreSafety(c) {
  let mint = c.audit?.mint_disabled;
  mint = mint != null ? (mint ? 25 : 0) : 12.5;
  let freeze = c.audit?.freeze_disabled;
  freeze = freeze != null ? (freeze ? 15 : 0) : 7.5;
  const top10 = inum(c.gmgn_top10_holder_pct ?? c.audit?.top_holders_pct, null);
  const top10s = top10 !== null ? lerp(top10, 60, 20, 0, 20) : 10;
  const bundler = inum(c.gmgn_bundler_pct, null);
  const bundlers = bundler !== null ? lerp(bundler, 50, 0, 0, 15) : 7.5;
  const bot = inum(c.gmgn_bot_degen_pct ?? c.audit?.bot_holders_pct, null);
  const bots = bot !== null ? lerp(bot, 50, 0, 0, 10) : 5;
  const dev = inum(c.gmgn_dev_team_hold_pct, null);
  const devs = dev !== null ? lerp(dev, 5, 1, 0, 15) : 7.5;
  return clamp(mint + freeze + top10s + bundlers + bots + devs, 0, 100);
}

function scoreYield(c) {
  const feeRatio = inum(c.fee_active_tvl_ratio, null);
  const fr = feeRatio !== null ? clamp(feeRatio / 2.0, 0, 1) * 40 : 20;
  const volume = inum(c.volume_window, 0);
  const tvl = inum(c.tvl, 0);
  const vt = tvl > 0 && volume > 0 ? clamp(volume / tvl / 5.0, 0, 1) * 25 : 12.5;
  const activeTvl = inum(c.active_tvl, 0);
  const at =
    tvl > 0 && activeTvl > 0 ? clamp(activeTvl / tvl / 0.5, 0, 1) * 15 : 7.5;
  const feeChange = inum(c.fee_change_pct, null);
  const ft = feeChange !== null ? clamp((feeChange + 50) / 100, 0, 1) * 20 : 10;
  return clamp(fr + vt + at + ft, 0, 100);
}

function priceTrendScore(pct) {
  if (pct <= -50) return 0;
  if (pct <= 0) return lerp(pct, -50, 0, 0, 12);
  if (pct <= 20) return lerp(pct, 0, 20, 12, 25);
  if (pct <= 100) return lerp(pct, 20, 100, 25, 15);
  return Math.max(5, lerp(pct, 100, 300, 15, 5));
}

function scoreMomentum(c) {
  const pc = inum(c.price_change_pct, null);
  const pt = pc !== null ? priceTrendScore(pc) : 12.5;
  const tr = inum(c.unique_traders, null);
  const trs = tr !== null ? clamp(tr / 200, 0, 1) * 25 : 12.5;
  const buyVol = inum(c.stats_1h?.buy_vol, 0);
  const sellVol = inum(c.stats_1h?.sell_vol, 0);
  const tot = buyVol + sellVol;
  const bs = tot > 0 ? clamp((buyVol / tot - 0.3) / 0.4, 0, 1) * 25 : 12.5;
  const ic = c.indicator_confirmation;
  let ics = 12.5;
  if (ic != null) {
    if (typeof ic === "object") ics = ic.bullish ? 25 : ic.bearish ? 0 : 12.5;
    else if (typeof ic === "boolean") ics = ic ? 25 : 0;
    else if (typeof ic === "string") {
      const l = ic.toLowerCase();
      ics =
        l.includes("bull") || l.includes("confirm")
          ? 25
          : l.includes("bear") || l.includes("reject")
            ? 0
            : 12.5;
    }
  }
  return clamp(pt + trs + bs + ics, 0, 100);
}

function ageMaturScore(hours) {
  if (hours <= 0) return 0;
  if (hours <= 2) return lerp(hours, 0, 2, 0, 3);
  if (hours <= 12) return lerp(hours, 2, 12, 3, 8);
  if (hours <= 48) return lerp(hours, 12, 48, 8, 15);
  return 15;
}

function scoreTrust(c) {
  const organic = inum(c.organic_score, null);
  const os = organic !== null ? clamp(organic / 100, 0, 1) * 25 : 12.5;
  const sw = inum(c.gmgn_smart_wallets, null);
  const sws = sw !== null ? clamp(sw / 3, 0, 1) * 20 : 10;
  const kol = inum(c.gmgn_kol_wallets, null);
  const pref = inum(c.gmgn_preferred_kol_matches, 0);
  const kols =
    kol !== null ? clamp(kol / 2, 0, 1) * 10 + (pref > 0 ? 5 : 0) : 7.5;
  const age = inum(c.token_age_hours, null);
  const ms = age !== null ? ageMaturScore(age) * (10 / 15) : 5;
  const dev = inum(c._devScore?.total ?? c._devScore, null);
  const devs = dev !== null ? clamp(dev / 100, 0, 1) * 20 : 10;
  const narr = 5;
  return clamp(os + sws + kols + ms + devs + narr, 0, 100);
}

function computeIntelScore(c) {
  if (!c) return 0;
  const w = INTEL_WEIGHTS;
  const total =
    Math.round(
      (w.safety * scoreSafety(c) +
        w.yield * scoreYield(c) +
        w.momentum * scoreMomentum(c) +
        w.trust * scoreTrust(c)) *
        10,
    ) / 10;
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// condensePool — faithful subset of tools/screening.js:933 condensePool().
// Only the fields the metric chain + intel score read.
// ─────────────────────────────────────────────────────────────────────────────

function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
    },
    quote: { symbol: p.token_y?.symbol },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step ?? null,
    tvl: numeric(p.tvl),
    active_tvl: numeric(p.active_tvl),
    volume_window: numeric(p.volume),
    fee_active_tvl_ratio: numeric(p.fee_active_tvl_ratio),
    volatility: numeric(p.volatility),
    fee_change_pct: numeric(p.fee_change_pct),
    holders: numeric(p.base_token_holders),
    mcap: numeric(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    quote_organic_score: numeric(p.token_y?.organic_score),
    token_age_hours: p.token_x?.created_at
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    launchpad: getPoolLaunchpad(p),
    total_lps: p.total_lps || 0,
    unique_traders: numeric(p.unique_traders),
    price_change_pct: numeric(p.pool_price_change_pct),
    // raw refs the metric chain reads directly off the raw pool
    _raw: p,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The metric funnel, as an ORDERED list of stages. Each stage returns true if
// the pool PASSES. Order mirrors getRawPoolScreeningRejectReason (screening.js
// :134-199) followed by the getTopCandidates secondary metric filter
// (screening.js:609-664). API field names are used exactly as in the real code.
// ─────────────────────────────────────────────────────────────────────────────

function buildStages(cfg) {
  // Each entry: { key, label, test(rawPool, cfg) -> boolean }
  // rawPool is the raw discovery-API object (same as `pool` in
  // getRawPoolScreeningRejectReason).
  return [
    {
      key: "excludeHighSupply",
      label: "high supply concentration flag",
      test: (p) =>
        !(cfg.excludeHighSupplyConcentration && p.base_token_has_high_supply_concentration === true),
    },
    {
      key: "criticalWarnings",
      label: "base/quote critical warnings",
      test: (p) =>
        p.base_token_has_critical_warnings !== true &&
        p.quote_token_has_critical_warnings !== true,
    },
    {
      key: "singleOwnership",
      label: "base high single ownership",
      test: (p) => p.base_token_has_high_single_ownership !== true,
    },
    {
      key: "poolTypeDlmm",
      label: "pool_type == dlmm",
      test: (p) => !(p.pool_type && p.pool_type !== "dlmm"),
    },
    {
      key: "minMcap",
      label: `mcap >= ${fmt(cfg.minMcap)}`,
      test: (p) => {
        const m = numeric(p.token_x?.market_cap);
        return m != null && m >= cfg.minMcap;
      },
    },
    {
      key: "maxMcap",
      label: `mcap <= ${fmt(cfg.maxMcap)}`,
      test: (p) => {
        const m = numeric(p.token_x?.market_cap);
        return m != null && m <= cfg.maxMcap;
      },
    },
    {
      key: "minHolders",
      label: `holders >= ${cfg.minHolders}`,
      test: (p) => {
        const h = numeric(p.base_token_holders);
        return h != null && h >= cfg.minHolders;
      },
    },
    {
      key: "minLps",
      label: `total_lps >= ${cfg.minLps}`,
      test: (p) => {
        if (!(cfg.minLps != null && cfg.minLps > 0)) return true;
        const l = numeric(p.total_lps);
        return l != null && l >= cfg.minLps;
      },
    },
    {
      key: "minVolume",
      label: `volume >= ${fmt(cfg.minVolume)}`,
      test: (p) => {
        const v = numeric(p.volume);
        return v != null && v >= cfg.minVolume;
      },
    },
    {
      key: "minTvl",
      label: `tvl >= ${fmt(cfg.minTvl)}`,
      test: (p) => {
        const t = numeric(p.tvl ?? p.active_tvl);
        return t != null && t >= cfg.minTvl;
      },
    },
    {
      key: "maxTvl",
      label: `tvl <= ${fmt(cfg.maxTvl)}`,
      test: (p) => {
        if (cfg.maxTvl == null) return true;
        const t = numeric(p.tvl ?? p.active_tvl);
        return t != null && t <= cfg.maxTvl;
      },
    },
    {
      key: "minBinStep",
      label: `bin_step >= ${cfg.minBinStep}`,
      test: (p) => {
        const b = numeric(p.dlmm_params?.bin_step);
        return b != null && b >= cfg.minBinStep;
      },
    },
    {
      key: "maxBinStep",
      label: `bin_step <= ${cfg.maxBinStep}`,
      test: (p) => {
        const b = numeric(p.dlmm_params?.bin_step);
        return b != null && b <= cfg.maxBinStep;
      },
    },
    {
      key: "volatility",
      label: "volatility usable (>0)",
      test: (p) => isUsableVolatility(p.volatility),
    },
    {
      key: "minFeeActiveTvlRatio",
      label: `fee/active-TVL >= ${cfg.minFeeActiveTvlRatio}`,
      test: (p) => {
        const r = numeric(p.fee_active_tvl_ratio);
        return r != null && r >= cfg.minFeeActiveTvlRatio;
      },
    },
    {
      key: "minOrganic",
      label: `base organic >= ${cfg.minOrganic}`,
      test: (p) => {
        const o = numeric(p.token_x?.organic_score);
        return o != null && o >= cfg.minOrganic;
      },
    },
    {
      key: "minQuoteOrganic",
      label: `quote organic >= ${cfg.minQuoteOrganic}`,
      test: (p) => {
        const o = numeric(p.token_y?.organic_score);
        return o != null && o >= cfg.minQuoteOrganic;
      },
    },
    {
      key: "minTokenAge",
      label: `token age >= ${cfg.minTokenAgeHours}h`,
      test: (p) => {
        if (cfg.minTokenAgeHours == null) return true;
        const createdAt = numeric(p.token_x?.created_at);
        const maxCreatedAt = Date.now() - cfg.minTokenAgeHours * 3_600_000;
        return createdAt != null && createdAt <= maxCreatedAt;
      },
    },
    {
      key: "maxTokenAge",
      label: `token age <= ${cfg.maxTokenAgeHours}h`,
      test: (p) => {
        if (cfg.maxTokenAgeHours == null) return true;
        const createdAt = numeric(p.token_x?.created_at);
        const minCreatedAt = Date.now() - cfg.maxTokenAgeHours * 3_600_000;
        return createdAt != null && createdAt >= minCreatedAt;
      },
    },
    {
      // getTopCandidates secondary gate (screening.js:641) — re-checks volatility
      // AND minIntelScore (screening.js:733). Intel score computed on condensed pool.
      key: "minIntelScore",
      label: `intel score >= ${cfg.minIntelScore}`,
      test: (p) => {
        if (!(cfg.minIntelScore > 0)) return true;
        const c = condensePool(p);
        return computeIntelScore(c) >= cfg.minIntelScore;
      },
    },
  ];
}

// Return { passed:boolean, failedKeys:[...] } — evaluate ALL stages so we can
// find single-filter near-misses (not just the first failure).
function evaluateAllStages(rawPool, stages) {
  const failedKeys = [];
  for (const st of stages) {
    let ok = false;
    try {
      ok = st.test(rawPool, {});
    } catch {
      ok = false;
    }
    if (!ok) failedKeys.push(st.key);
  }
  return { passed: failedKeys.length === 0, failedKeys };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch a broad universe. Because the LIVE filter set returns ~0 server-side,
// we fetch with a MINIMAL server filter (pool_type=dlmm only) across a few
// categories, paging via after_key, then apply the full chain client-side.
// ─────────────────────────────────────────────────────────────────────────────

async function fetchPage({ filters, timeframe, category, afterKey }) {
  let url =
    `${POOL_DISCOVERY_BASE}/pools?page_size=${PAGE_SIZE}` +
    `&filter_by=${encodeURIComponent(filters)}` +
    `&timeframe=${timeframe}` +
    `&category=${category}`;
  if (afterKey) url += `&after_key=${encodeURIComponent(afterKey)}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`discovery ${res.status} ${res.statusText}`);
    return res.json();
  }
  throw new Error("rate-limited after retries");
}

async function fetchUniverse(cfg, budget) {
  // Minimal server filter — just DLMM pools — so the client-side funnel is the
  // authoritative filter. Iterate the configured category first, then alternates.
  const minimalFilter = "pool_type=dlmm";
  const categories = [cfg.category];
  for (const alt of ["new", "top"]) {
    if (!categories.includes(alt)) categories.push(alt);
  }

  const byAddr = new Map();
  const queryLog = [];
  let reqCount = 0;

  for (const category of categories) {
    if (reqCount >= budget.max) break;
    let afterKey = null;
    let pages = 0;
    let fetchedThisCat = 0;
    // Cap pages per category so no single category eats the whole budget.
    const maxPagesPerCat = Math.max(2, Math.floor(budget.max / categories.length));
    while (pages < maxPagesPerCat && reqCount < budget.max) {
      let data;
      try {
        data = await fetchPage({
          filters: minimalFilter,
          timeframe: cfg.timeframe,
          category,
          afterKey,
        });
      } catch (err) {
        queryLog.push(`  category=${category} page ${pages + 1}: ERROR ${err.message}`);
        break;
      }
      reqCount++;
      pages++;
      const rows = Array.isArray(data.data) ? data.data : [];
      for (const p of rows) {
        if (p?.pool_address && !byAddr.has(p.pool_address)) byAddr.set(p.pool_address, p);
      }
      fetchedThisCat += rows.length;
      afterKey = data.after_key;
      if (!data.has_more || !afterKey || rows.length === 0) break;
    }
    queryLog.push(
      `  category=${category} timeframe=${cfg.timeframe}: ${pages} page(s), ${fetchedThisCat} rows`,
    );
  }

  return { pools: [...byAddr.values()], queryLog, reqCount };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output builders
// ─────────────────────────────────────────────────────────────────────────────

function printAttrition(pools, stages) {
  console.log("\n(a) ATTRITION TABLE — sequential metric funnel (live config)");
  console.log("    " + "─".repeat(72));
  console.log(
    "    " + pad("stage", 34) + padL("remaining", 11) + padL("killed", 10),
  );
  console.log("    " + "─".repeat(72));

  let remaining = pools.slice();
  console.log("    " + pad("universe (dlmm pools fetched)", 34) + padL(remaining.length, 11) + padL("killed", 10) + padL("kill%", 8));

  const killCounts = [];
  for (const st of stages) {
    const survivors = [];
    let killed = 0;
    const before = remaining.length;
    for (const p of remaining) {
      let ok = false;
      try {
        ok = st.test(p, {});
      } catch {
        ok = false;
      }
      if (ok) survivors.push(p);
      else killed++;
    }
    const killPct = before > 0 ? (killed / before) * 100 : 0;
    killCounts.push({ label: st.label, key: st.key, killed, before, killPct });
    console.log(
      "    " +
        pad(st.label, 34) +
        padL(survivors.length, 11) +
        padL(killed > 0 ? "-" + killed : "0", 10) +
        padL(killed > 0 ? killPct.toFixed(0) + "%" : "—", 8),
    );
    remaining = survivors;
  }
  console.log("    " + "─".repeat(72));
  console.log("    " + pad("FINAL survivors", 34) + padL(remaining.length, 11));

  // Two rankings: (1) absolute kills (dominated by broad early pre-filters),
  // (2) TERMINAL killers — highest kill FRACTION among late stages that act on
  // an already-small population (<= 5% of the universe). The terminal set is the
  // real starvation diagnosis: filters that take a near-qualified set to zero.
  const top3Abs = [...killCounts].sort((a, b) => b.killed - a.killed).slice(0, 3);
  console.log("\n    TOP 3 KILLER STAGES (absolute kills):");
  top3Abs.forEach((k, i) => {
    if (k.killed > 0)
      console.log(`      ${i + 1}. ${k.label}  →  killed ${k.killed} (${k.killPct.toFixed(0)}% of stage input)`);
  });

  const smallPop = Math.max(5, Math.floor(pools.length * 0.05));
  const terminal = killCounts
    .filter((k) => k.before <= smallPop && k.killed > 0)
    .sort((a, b) => b.killPct - a.killPct)
    .slice(0, 3);
  if (terminal.length) {
    console.log("\n    TOP TERMINAL KILLERS (highest kill% on the already-narrowed set — the true starvers):");
    terminal.forEach((k, i) => {
      console.log(`      ${i + 1}. ${k.label}  →  ${k.before} → ${k.before - k.killed}  (killed ${k.killPct.toFixed(0)}%)`);
    });
  }

  return remaining;
}

function printNearMisses(pools, stages) {
  console.log("\n(b) NEAR-MISSES — pools that fail EXACTLY ONE metric filter");
  console.log("    " + "─".repeat(100));

  const byFilter = new Map();
  for (const p of pools) {
    const { failedKeys } = evaluateAllStages(p, stages);
    if (failedKeys.length !== 1) continue;
    const key = failedKeys[0];
    if (!byFilter.has(key)) byFilter.set(key, []);
    byFilter.get(key).push(p);
  }

  if (byFilter.size === 0) {
    console.log("    (none — every fetched pool fails 0 or 2+ filters)");
    return;
  }

  const labelByKey = new Map(stages.map((s) => [s.key, s.label]));
  // Sort filter groups by how many pools are "one relaxation away".
  const groups = [...byFilter.entries()].sort((a, b) => b[1].length - a[1].length);

  for (const [key, list] of groups) {
    console.log(`\n    ✗ only-failing: ${labelByKey.get(key)}   (${list.length} pool${list.length === 1 ? "" : "s"} one filter away)`);
    console.log(
      "      " +
        pad("symbol", 12) +
        pad("pool", 14) +
        pad("tvl", 9) +
        pad("vol", 9) +
        pad("org", 6) +
        pad("qorg", 6) +
        pad("fee/tvl", 10) +
        pad("mcap", 9) +
        pad("bin", 5),
    );
    for (const p of list.slice(0, 12)) {
      console.log(
        "      " +
          pad(p.token_x?.symbol || "?", 12) +
          pad(short(p.pool_address), 14) +
          pad(fmt(p.tvl), 9) +
          pad(fmt(p.volume), 9) +
          pad(Math.round(p.token_x?.organic_score ?? 0), 6) +
          pad(Math.round(p.token_y?.organic_score ?? 0), 6) +
          pad((numeric(p.fee_active_tvl_ratio) ?? 0).toFixed(3), 10) +
          pad(fmt(p.token_x?.market_cap), 9) +
          pad(p.dlmm_params?.bin_step ?? "?", 5),
      );
    }
    if (list.length > 12) console.log(`      … and ${list.length - 12} more`);
  }
}

function survivorQuality(p) {
  // Rank key: fee_active_tvl_ratio × normalized organic quality.
  const feeR = numeric(p.fee_active_tvl_ratio) ?? 0;
  const org = (numeric(p.token_x?.organic_score) ?? 0) / 100;
  return feeR * Math.max(0.01, org);
}

function printScenarios(pools, baseCfg) {
  console.log("\n(c) RELAXATION SCENARIOS — survivors of the FULL metric chain under relaxed thresholds");
  console.log("    " + "─".repeat(100));

  const scenarios = {
    "live (baseline)": {},
    mild: { minOrganic: 75, minQuoteOrganic: 60, minFeeActiveTvlRatio: 0.3, minTvl: 30_000, maxTvl: 400_000, minMcap: 300_000 },
    medium: { minOrganic: 70, minQuoteOrganic: 55, minFeeActiveTvlRatio: 0.2, minTvl: 20_000, maxTvl: 500_000, minMcap: 200_000 },
    "claude.md defaults": { minOrganic: 60, minQuoteOrganic: 60, minFeeActiveTvlRatio: 0.05, minTvl: 10_000, maxTvl: 150_000, minMcap: 150_000, minLps: 0, minIntelScore: 45 },
  };

  for (const [name, override] of Object.entries(scenarios)) {
    const cfg = { ...baseCfg, ...override };
    const stages = buildStages(cfg);
    const survivors = pools.filter((p) => evaluateAllStages(p, stages).passed);
    const overrideStr = Object.keys(override).length
      ? Object.entries(override)
          .map(([k, v]) => `${k}=${typeof v === "number" ? fmt(v) : v}`)
          .join(" ")
      : "(unchanged)";
    console.log(`\n    ── ${name.toUpperCase()} → ${survivors.length} survivor(s)`);
    console.log(`       ${overrideStr}`);
    if (survivors.length === 0) continue;

    const ranked = survivors.sort((a, b) => survivorQuality(b) - survivorQuality(a)).slice(0, 10);
    console.log(
      "       " +
        pad("symbol", 12) +
        pad("pool", 14) +
        pad("tvl", 9) +
        pad("vol", 9) +
        pad("org", 6) +
        pad("fee/tvl", 10) +
        pad("mcap", 9) +
        pad("bin", 5) +
        pad("age(h)", 8),
    );
    for (const p of ranked) {
      const age = p.token_x?.created_at
        ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
        : "?";
      console.log(
        "       " +
          pad(p.token_x?.symbol || "?", 12) +
          pad(short(p.pool_address), 14) +
          pad(fmt(p.tvl), 9) +
          pad(fmt(p.volume), 9) +
          pad(Math.round(p.token_x?.organic_score ?? 0), 6) +
          pad((numeric(p.fee_active_tvl_ratio) ?? 0).toFixed(3), 10) +
          pad(fmt(p.token_x?.market_cap), 9) +
          pad(p.dlmm_params?.bin_step ?? "?", 5) +
          pad(age, 8),
      );
    }
  }
}

function printNotes() {
  console.log("\n(d) STAGES NOT EVALUATED (survivors above still face these gates)");
  console.log("    " + "─".repeat(72));
  const notes = [
    "Token blacklist / dev blocklist (needs local state + Jupiter dev lookup)",
    "TVL-drain guard (needs recorded TVL snapshot history)",
    "Exit-signals guard (GMGN-only fields; inert on Meteora payload anyway)",
    "Pool / base-mint cooldowns (needs pool-memory state)",
    "Occupied-pool / occupied-mint (needs live wallet positions)",
    "Developer reputation score, minDevScore (needs GMGN dev-info API)",
    "Dump-play guard (dev score >= 70 gate on price change <= -20%)",
    "PVP same-symbol rival hard-filter (needs Jupiter asset search)",
    "Indicator confirmation (needs Jupiter OHLCV; config.indicators.enabled)",
    "minTokenFeesSol (30) — NOT a Meteora metric filter; token/GMGN enrichment gate",
    "maxTop10Pct (60) — NOT in metric chain; Jupiter-audit / intel-score input only",
    "athFilterPct (30) — GMGN-path only (config.gmgn.athFilterPct); no Meteora effect",
    "Bear-case debate + LLM final deploy decision (the agent still chooses)",
    "NOTE: intel score here uses neutral midpoints for absent GMGN/audit fields,",
    "      exactly as the real engine does pre-recon — real recon can move it.",
  ];
  notes.forEach((n) => console.log("    • " + n));
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") {
      try {
        Object.assign(out, JSON.parse(argv[++i] || "{}"));
      } catch (e) {
        console.error("Bad --config JSON:", e.message);
        process.exit(1);
      }
    }
  }
  return out;
}

async function main() {
  const override = parseArgs(process.argv.slice(2));
  const cfg = { ...DEFAULT_LIVE_CONFIG, ...override };

  console.log("═".repeat(80));
  console.log("  MERIDIAN SCREENING FUNNEL AUDIT (read-only)");
  console.log("═".repeat(80));
  console.log("  Live config:", JSON.stringify(cfg));
  console.log(`  API: ${POOL_DISCOVERY_BASE}  (public, no auth)   req budget: ${MAX_REQUESTS}`);

  const { pools, queryLog, reqCount } = await fetchUniverse(cfg, { max: MAX_REQUESTS });

  console.log(`\n  Fetched ${pools.length} unique DLMM pools in ${reqCount} request(s):`);
  queryLog.forEach((l) => console.log(l));

  if (pools.length === 0) {
    console.log("\n  No pools fetched — the discovery API returned nothing. Aborting.");
    return;
  }

  const stages = buildStages(cfg);
  printAttrition(pools, stages);
  printNearMisses(pools, stages);
  printScenarios(pools, cfg);
  printNotes();

  console.log("\n" + "═".repeat(80));
}

main().catch((err) => {
  console.error("FATAL:", err.stack || err.message);
  process.exit(1);
});
