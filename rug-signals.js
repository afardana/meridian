/**
 * rug-signals.js — Rug-screening signals lifted from the Jupiter token audit.
 *
 * Origin: a survey of two experienced Meteora DLMM practitioners surfaced four rug
 * red flags we never checked — insider holdings > 0%, unburnt initial liquidity, a
 * pump.fun "offchain coin" signature (creator wallet != minter wallet), and a much
 * stricter top-10 concentration bar (>30%) than ours (60%). Their claimed rug shape
 * ("slow rug, no meaningful bounce, until -90%+") matches our worst loss (TrumpCoin
 * 2026-07-14: -64% mcap entirely inside a 117-bin range).
 *
 * ⚠️ These are OTHER PEOPLE'S heuristics, tuned for day-scale holds; we hold minutes
 * to hours. None of them is validated against our own closes, and this codebase has
 * twice been starved to literally zero candidates by over-tightened AND-ed filters
 * (see CLAUDE.md "Known Issues"). So the shape here is DETECT + CAPTURE now, GATE
 * later: extraction always runs and always lands in the deploy signal snapshot, and
 * the gate is flag-gated OFF by default until our own outcome data justifies it.
 *
 * Cost: ZERO extra API calls. runScreeningCycle's recon loop already fetches
 * getTokenInfo() (datapi.jup.ag /assets/search) per candidate — the same response
 * that carries `audit`. We only stopped projecting these fields out of it.
 *
 * ── Field availability (measured 2026-07-16 over an 84-mint live Meteora DLMM
 *    candidate universe; scripts are throwaway, numbers reproduced in the plan) ──
 *   topHoldersPercentage  100%   p50 23.8  p90 73.7  max 92.3
 *   devMints              100%   p50  2    p90 290   max 182549
 *   bundlerStats.*         67%
 *   devMigrations          57%
 *   devBalancePercentage   30%
 *   insiderPct             12%   p50  0.26 p90 35.0  max 50.0
 *   sniperPct               7%
 *   permanentControlEnabled 6%
 *
 * ⚠️ SPARSITY IS AMBIGUOUS. insiderPct is present on only ~12% of tokens, and the
 * smallest present value is 0.004 — consistent with Jupiter OMITTING the field when
 * it is exactly zero (i.e. absent = clean) rather than when it is unknown. We cannot
 * tell the two apart from the outside, so every check here FAILS OPEN: a null value
 * never rejects. That is correct under both readings — but it does mean an enforced
 * insider bar only ever fires on the minority of tokens that report the field, which
 * is a real selection artifact to keep in mind when reading the log_only output.
 */

import { config } from "./config.js";

function num(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the rug-filter knobs off a screening config section.
 * A null threshold means "check disabled" — never "reject everything".
 */
export function getRugFilterConfig(s = config.screening) {
  return {
    mode: String(s?.rugFilterMode || "off").toLowerCase(), // off | log_only | enforce
    maxInsiderPct: num(s?.rugMaxInsiderPct),
    maxTop10Pct: num(s?.rugMaxTop10Pct),
    maxDevMints: num(s?.rugMaxDevMints),
  };
}

/**
 * Project the rug-relevant fields off an already-fetched getTokenInfo() result.
 *
 * PURE + null-safe. Every field independently degrades to null; a null NEVER means
 * "bad" (see the sparsity note above) — evaluateRugFilter skips null inputs.
 *
 * @param {object|null} ti - getTokenInfo().results[0] for this candidate's base mint
 * @param {object|null} pool - the condensed candidate (fallback for launchpad)
 * @returns {object} flat signal bag, all keys always present (null when unknown)
 */
export function extractRugSignals(ti, pool) {
  const empty = {
    insider_pct: null,
    sniper_pct: null,
    top10_pct: null,
    dev_balance_pct: null,
    bundler_pct: null,
    bundler_pct_ath: null,
    dev_mints: null,
    dev_migrations: null,
    permanent_control: null,
    launchpad: pool?.launchpad ?? null,
    graduated: null,
    liq_burnt: null,
    creator_mint_mismatch: null,
  };
  if (!ti) return empty;

  // getTokenInfo returns the FIRST asset-search hit, which is not guaranteed to be
  // the mint we asked about. Rejecting a candidate on another token's audit would be
  // a silent correctness bug, so a mismatch degrades to "unknown" (all null).
  const wantMint = pool?.base?.mint ?? null;
  if (wantMint && ti.mint && ti.mint !== wantMint) return empty;

  const a = ti.audit || {};
  const launchpad = ti.launchpad ?? pool?.launchpad ?? null;
  const graduated = typeof ti.graduated === "boolean" ? ti.graduated : null;

  return {
    insider_pct: num(a.insider_pct),
    sniper_pct: num(a.sniper_pct),
    top10_pct: num(a.top_holders_pct),
    dev_balance_pct: num(a.dev_balance_pct),
    bundler_pct: num(a.bundler_pct),
    bundler_pct_ath: num(a.bundler_pct_ath),
    // Keyless proxy for the "offchain coin" claim (creator wallet != minter wallet):
    // the `dev` wallet's lifetime mint count. A one-coin creator shows dev_mints=1;
    // the observed max is 182549, which is definitionally a launch-factory/proxy
    // wallet minting on someone else's behalf. NOT the practitioners' actual check —
    // a hypothesis to validate against our own closes. (TrumpCoin: dev_mints=101,
    // dev_migrations=9 — not a one-coin creator.)
    dev_mints: num(a.dev_mints),
    dev_migrations: num(a.dev_migrations),
    permanent_control: typeof a.permanent_control === "boolean" ? a.permanent_control : null,
    launchpad,
    graduated,
    // Initial-liquidity burn: no keyless field exists. Graduation off a bonding
    // curve is the honest proxy — the launchpad migrates/locks the initial LP as
    // part of graduation, so graduated === true implies it. NEVER derive `false`:
    // a non-graduated token (36/84 of the live universe are plain SPL tokens with a
    // manually-created pool) has genuinely UNKNOWN burn status, and returning false
    // there would turn "we didn't look" into "it's a rug".
    liq_burnt: graduated === true ? true : null,
    // NOT OBTAINABLE from any API field we have. Would require an RPC/Helius walk of
    // the mint's first transactions to compare creator vs. minter/first-buyer.
    // Deliberately left null rather than faked — see the module header.
    creator_mint_mismatch: null,
  };
}

/**
 * Evaluate the rug checks against a signal bag.
 *
 * A check fires ONLY when BOTH the observed value and its threshold are non-null and
 * the value exceeds the threshold. Unknown input (null) or disabled knob (null) =>
 * the check is skipped. There is no code path here that rejects on missing data.
 *
 * The verdict is computed regardless of mode — `mode` only decides whether the caller
 * acts on it — so `checks_tripped` is captured into the deploy snapshot even while
 * the filter is off. That is the whole point: it makes the heuristics backtestable
 * against our own closes before we ever gate on them.
 *
 * @param {object} signals - extractRugSignals() output
 * @param {object} cfg - getRugFilterConfig() output
 * @returns {{ tripped: Array<{check,value,limit}>, reject: boolean }}
 */
export function evaluateRugFilter(signals, cfg) {
  const tripped = [];
  if (!signals || !cfg) return { tripped, reject: false };

  const over = (check, value, limit) => {
    if (value == null || limit == null) return; // fail open — unknown is never "bad"
    if (value > limit) tripped.push({ check, value, limit });
  };

  over("insider_pct", signals.insider_pct, cfg.maxInsiderPct);
  over("top10_pct", signals.top10_pct, cfg.maxTop10Pct);
  over("dev_mints", signals.dev_mints, cfg.maxDevMints);

  return { tripped, reject: tripped.length > 0 };
}

/** Compact "check=value>limit" rendering for the [RUG_FILTER] log line. */
export function formatRugTrips(verdict) {
  if (!verdict?.tripped?.length) return "";
  return verdict.tripped
    .map(({ check, value, limit }) => `${check}=${Number(value).toFixed(2)}>${limit}`)
    .join(", ");
}
