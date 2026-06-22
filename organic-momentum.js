/**
 * Organic Momentum / Decay Signal
 *
 * A pool's current fee/TVL is a *rear-view mirror*: it says the pool WAS hot,
 * not that the crowd is staying. Our dominant failure mode is deploying into
 * pools that look hot but go dead within ~1h while still in range — the trading
 * (and so the fees) evaporates. By the time fee/TVL looks juicy, the rush is
 * often already ending.
 *
 * This signal reads the *trend* fields the discovery API already returns (and
 * that condensePool now keeps) to ask "is the crowd growing or leaving?" rather
 * than only "how hot is it right now?":
 *
 *   unique_traders_change_pct  (T) — trader breadth trend   [primary]
 *   volume_change_pct          (V) — volume acceleration     [primary]
 *   base_token_holders_change_pct (H) — holder growth        [secondary]
 *   swap_count_change_pct      (S) — trade-count trend       [secondary]
 *   net_deposits_change_pct    (D) — LP inflow (dilutes fee/TVL) [context]
 *   unique_traders             (N) — absolute breadth floor
 *
 * Grounding: trader-breadth / volume trend out-rank temporal fee-consistency as
 * persistence predictors (MELT, arXiv 2602.13480: point-in-time aggregates beat
 * time-series). On the live candidate population the fee-rate trend is
 * near-uniformly positive (non-discriminating), while trader/volume trend spans
 * a wide range and ~half of high-fee pools already show them declining — the
 * leading tell of the death we observed. Thresholds below are that population's
 * quartiles; they are config-driven and meant to be tuned by validation, not
 * trusted blind. Deliberately a transparent classifier, not a fitted model — we
 * have no training data yet.
 */

function numeric(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ─── Deploy-time capture cache (mirrors fee-efficiency.js) ──────
const _byPool = new Map();
const _CACHE_CAP = 300;

function poolAddress(pool) {
  return pool?.pool || pool?.pool_address || pool?.address || null;
}

/**
 * Resolve the momentum config with grounded defaults. Reads from a screening
 * config object; every threshold is overridable.
 */
export function getOrganicMomentumConfig(screeningConfig = {}) {
  return {
    enabled: screeningConfig.organicMomentumEnabled ?? true,
    decayTraderPct: screeningConfig.organicMomentumDecayTraderPct ?? -22, // p25 of population
    decayVolumePct: screeningConfig.organicMomentumDecayVolumePct ?? -42, // p25 of population
    growTraderPct: screeningConfig.organicMomentumGrowTraderPct ?? 38,    // p75 of population
    minUniqueTraders: screeningConfig.organicMomentumMinUniqueTraders ?? 30,
    hardFilter: screeningConfig.organicMomentumHardFilter ?? false,       // promote only after validation
  };
}

/**
 * Compute the organic-momentum read for a single pool.
 * @returns {object} always returns an object; classification 'unknown' when the
 *          trend fields are absent (GMGN pools, brand-new pools).
 */
export function computeOrganicMomentum(pool, cfg = getOrganicMomentumConfig()) {
  const T = numeric(pool?.unique_traders_change_pct);
  const V = numeric(pool?.volume_change_pct);
  const H = numeric(pool?.base_token_holders_change_pct);
  const S = numeric(pool?.swap_count_change_pct);
  const D = numeric(pool?.net_deposits_change_pct);
  const N = numeric(pool?.unique_traders);

  // Need at least one primary trend to say anything.
  if (T == null && V == null) {
    return { classification: "unknown", decay_risk: false, thin: false, score: null,
      trader_change_pct: T, volume_change_pct: V, holder_change_pct: H, swap_change_pct: S,
      net_deposit_change_pct: D, unique_traders: N };
  }

  const thin = N != null && N < cfg.minUniqueTraders;
  const decaying = (T != null && T <= cfg.decayTraderPct) || (V != null && V <= cfg.decayVolumePct);
  const growing = (T != null && T >= cfg.growTraderPct) && (V != null && V >= 0);

  let classification = "steady";
  if (decaying) classification = "decaying";
  else if (growing) classification = "growing";

  // Interpretable score: signed contribution of each trend, -3..+3.
  const bucket = (x, dn, up) => x == null ? 0 : (x <= dn ? -1 : (x >= up ? 1 : 0));
  const score = bucket(T, cfg.decayTraderPct, cfg.growTraderPct)
              + bucket(V, cfg.decayVolumePct, 50)
              + bucket(H, -10, 20);

  return {
    classification,
    decay_risk: decaying,
    thin,
    score,
    trader_change_pct: T,
    volume_change_pct: V,
    holder_change_pct: H,
    swap_change_pct: S,
    net_deposit_change_pct: D,
    unique_traders: N,
  };
}

/**
 * Annotate each candidate with `pool._organicMomentum` and snapshot it into the
 * deploy-capture cache (mirrors rankByFeeEfficiency).
 * @returns {object[]} the same array, annotated in place
 */
export function annotateOrganicMomentum(pools, cfg = getOrganicMomentumConfig()) {
  if (!Array.isArray(pools) || pools.length === 0) return pools;
  for (const pool of pools) {
    const m = computeOrganicMomentum(pool, cfg);
    pool._organicMomentum = m;
    const addr = poolAddress(pool);
    if (!addr) continue;
    if (_byPool.has(addr)) _byPool.delete(addr); // refresh insertion order
    _byPool.set(addr, { ...m });
    if (_byPool.size > _CACHE_CAP) _byPool.delete(_byPool.keys().next().value);
  }
  return pools;
}

/** Deploy-path lookup of the latest momentum snapshot for a pool address. */
export function getOrganicMomentumForPool(address) {
  if (!address) return null;
  return _byPool.get(address) || null;
}

/**
 * Compact one-line render for the candidate block.
 * @returns {string|null} null when nothing usable (keeps the block clean)
 */
export function formatOrganicMomentum(pool) {
  const m = pool?._organicMomentum;
  if (!m || m.classification === "unknown") return null;
  const pct = (v) => (v == null ? "?" : `${v >= 0 ? "+" : ""}${Math.round(v)}%`);
  const tag = m.classification === "decaying" ? "DECAYING ⚠️"
            : m.classification === "growing" ? "GROWING"
            : "steady";
  const thin = m.thin ? ", THIN" : "";
  return `momentum: ${tag} (traders ${pct(m.trader_change_pct)}, vol ${pct(m.volume_change_pct)}, holders ${pct(m.holder_change_pct)}, n=${m.unique_traders ?? "?"}${thin})`;
}

// ─── Validation (does momentum-at-deploy predict survival?) ─────

function mean(xs) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}
function round2(v) {
  return v == null ? null : Math.round(v * 100) / 100;
}

/**
 * Validate the signal against realized outcomes: did pools classified
 * `decaying` at deploy fee-die / lose more than `steady`/`growing` ones?
 *
 * Pure — pass closed-position performance records (each may carry the
 * `organic_momentum` snapshot captured at deploy).
 */
export function analyzeOrganicMomentumOutcomes(performance) {
  const rows = (Array.isArray(performance) ? performance : []).filter(
    (r) => r?.organic_momentum && r.organic_momentum.classification &&
      r.organic_momentum.classification !== "unknown" && Number.isFinite(r.pnl_pct)
  );
  if (rows.length < 3) {
    return { ready: false, count: rows.length, note: "need ≥3 closed positions with an organic-momentum snapshot" };
  }

  const isFeeDeath = (r) => String(r.close_reason || "").toLowerCase().includes("low yield") ||
    String(r.close_reason || "").toLowerCase().includes("yield");

  const byClass = (cls) => {
    const arr = rows.filter((r) => r.organic_momentum.classification === cls);
    return {
      n: arr.length,
      avg_pnl_pct: arr.length ? round2(mean(arr.map((r) => r.pnl_pct))) : null,
      win_rate_pct: arr.length ? Math.round((arr.filter((r) => r.pnl_pct > 0).length / arr.length) * 100) : null,
      fee_death_rate_pct: arr.length ? Math.round((arr.filter(isFeeDeath).length / arr.length) * 100) : null,
    };
  };

  const decaying = byClass("decaying");
  const steady = byClass("steady");
  const growing = byClass("growing");

  let verdict = "inconclusive";
  if (decaying.n >= 2 && (steady.n + growing.n) >= 2 && decaying.avg_pnl_pct != null) {
    const nonDecayPnl = mean(rows.filter((r) => r.organic_momentum.classification !== "decaying").map((r) => r.pnl_pct));
    if (decaying.avg_pnl_pct < nonDecayPnl - 1) verdict = "decaying-at-deploy tracked worse PnL (signal works)";
    else if (decaying.avg_pnl_pct > nonDecayPnl + 1) verdict = "INVERTED — decaying pools did better (re-check)";
    else verdict = "weak/no separation so far";
  }

  return {
    ready: true,
    count: rows.length,
    classes: { decaying, steady, growing },
    verdict,
    note: rows.length < 12 ? "small sample — directional, not conclusive" : null,
  };
}
