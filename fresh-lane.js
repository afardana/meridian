// fresh-lane.js — the fresh top-performer lane definition (plan 16, Phase 1: CAPTURE ONLY).
//
// Pure leaf module (imports rule-mode.js only): no network, no DB, no clock reads (the caller
// passes `now`). It defines WHICH pools the paper lane would have entered and WHAT is stored about
// them; fresh-lane-paper.js does the polling, storage and quotes. Nothing here can send a
// transaction, call an LLM or change a live rule.
//
// The definition is registered in docs/experiments/fresh-top-lane.md (2026-11-27) BEFORE capture
// started. Its thresholds are constants on purpose: changing one restarts the count, so they are
// not config keys. Only the mode, the poll cadence and the tracking window are tunable.
import { modeFor } from "./rule-mode.js";

export const LANE_ID = "fresh-top-lane";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// The exact list the Meteora UI's "Top Performers · DLMM · 2h" tab requests (its own floors, no
// token-age floor). The UI sends the `&&` joins inside ONE filter_by value; sent unencoded the
// API answers 400, so the value is URL-encoded as one parameter (verified 2026-11-27, read-only).
export const LANE_LIST_TIMEFRAME = "2h";
export const LANE_LIST_PAGE_SIZE = 50;
export const LANE_LIST_FILTER = "pool_type=dlmm&&dlmm_collect_fee_mode=both&&base_token_market_cap>=70000&&base_token_holders>=15&&volume>=1000&&fee>=5&&active_tvl>=10000";
export function laneListUrl(base) {
  return `${base}/pools?page_size=${LANE_LIST_PAGE_SIZE}&timeframe=${LANE_LIST_TIMEFRAME}&category=top&filter_by=${encodeURIComponent(LANE_LIST_FILTER)}`;
}
// Tracking: one batched request for every open paper trade (`pool_address=[a,b,…]`, verified
// 2026-11-27) at the 5-minute timeframe. ⚠️ At timeframe=5m the API's `fee` / `volume` are NOT a
// rolling last-5-minutes figure: they are the fees / volume so far in the CURRENT clock-aligned
// 5-minute bucket — they only rise inside a bucket and drop to ≈ 0 when the next bucket starts
// (sampled live 2026-11-27; the reset shows in the answer 12–27 s after the clock boundary).
// The tick stores the raw reading and the bucket it belongs to; fresh_lane_sim.js rebuilds the
// cumulative fee from them (reconstructFees). Once per bucket a second batch at timeframe=1h gives
// `fee_1h_usd`, the fallback for a bucket the ticks skipped entirely.
export const TRACK_TIMEFRAME = "5m";
export const TRACK_FEE_WINDOW_MIN = 5;
export const FEE_BUCKET_MS = 5 * 60_000;
export const TRACK_BATCH_MAX = 50;
export function laneTrackUrl(base, pools, timeframe = TRACK_TIMEFRAME) {
  return `${base}/pools?page_size=${Math.min(TRACK_BATCH_MAX, pools.length)}&timeframe=${timeframe}&filter_by=${encodeURIComponent(`pool_address=[${pools.join(",")}]`)}`;
}
// The answer shows a new bucket some seconds AFTER the clock boundary (live 2026-11-27: at 16:20:15
// server time the 16:15 bucket was still growing, at 16:20:45 the 16:20 bucket had started; at
// 16:25:12 still old, at 16:25:27 new — a 12–27 s lag). The bucket a reading belongs to is
// therefore taken from the server time minus this lag, so an old-bucket reading is never filed
// under the next bucket.
export const FEE_BUCKET_LAG_MS = 30_000;
/** Start (ms) of the clock-aligned 5-minute bucket the API's 5m figures refer to at server time `ms`. */
export function feeBucketStart(ms, lagMs = FEE_BUCKET_LAG_MS) {
  return Number.isFinite(ms) ? Math.floor((ms - lagMs) / FEE_BUCKET_MS) * FEE_BUCKET_MS : null;
}
/** Server time of a response from its Date header (ms), or null. */
export function serverTimeOf(headers) {
  let d = null;
  try { d = typeof headers?.get === "function" ? headers.get("date") : headers?.date; } catch { d = null; }
  const t = d ? Date.parse(d) : NaN;
  return Number.isFinite(t) ? t : null;
}

/** The registered lane definition (docs/experiments/fresh-top-lane.md). Not tunable. */
export const LANE_DEFINITION = Object.freeze({
  maxRank: 5,
  maxTokenAgeHours: 24,
  minActiveTvlUsd: 10_000,
  minMcapUsd: 100_000,
  minHolders: 500,
  minTokenFeesSol: 30,
});
/** After a paper entry's tracking window ends, the same pool cannot open another for this long. */
export const LANE_REENTRY_GAP_HOURS = 6;

const FRESH_LANE_POLL_DEFAULT_SEC = 45;
const FRESH_LANE_POLL_MIN_SEC = 30;
const FRESH_LANE_TRACK_DEFAULT_H = 6;
const FRESH_LANE_TRACK_MIN_H = 1;
const FRESH_LANE_TRACK_MAX_H = 24;

const num = (v) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** freshLaneMode / freshLanePollSec / freshLaneTrackHours from config.screening (or user-config). */
export function freshLaneConfig(s = {}) {
  const mode = modeFor("freshLaneMode", s?.freshLaneMode);
  const p = num(s?.freshLanePollSec);
  const pollSec = p == null ? FRESH_LANE_POLL_DEFAULT_SEC : Math.max(FRESH_LANE_POLL_MIN_SEC, p);
  const t = num(s?.freshLaneTrackHours);
  const trackHours = t == null || t <= 0 ? FRESH_LANE_TRACK_DEFAULT_H : Math.min(FRESH_LANE_TRACK_MAX_H, Math.max(FRESH_LANE_TRACK_MIN_H, t));
  return { mode, pollSec, trackHours };
}
export const FRESH_LANE_MODES = Object.freeze(["off", "shadow"]);
export const isValidFreshLanePollSec = (v) => Number.isFinite(Number(v)) && Number(v) >= FRESH_LANE_POLL_MIN_SEC;
export const isValidFreshLaneTrackHours = (v) => Number.isFinite(Number(v)) && Number(v) >= FRESH_LANE_TRACK_MIN_H && Number(v) <= FRESH_LANE_TRACK_MAX_H;

const pairOf = (row) => row?.name || `${row?.token_x?.symbol || "?"}-${row?.token_y?.symbol || "?"}`;
const usd = (v) => `$${Math.round(v).toLocaleString("en-US")}`;

/**
 * The cheap checks that need nothing but the API row (and the local blacklists).
 * ctx = { now (ms), rank (1-based place on the 2h list, null = not on it), isBlacklisted(mint),
 * isDevBlocked(dev), ignoreRank }. Returns every failing check (empty = pass).
 */
export function laneRowChecks(row, ctx = {}) {
  const D = LANE_DEFINITION;
  const reasons = [];
  if (!row || typeof row !== "object") return ["no pool row"];
  if (row.pool_type !== "dlmm") reasons.push(`not a DLMM pool (${row.pool_type ?? "unknown"})`);
  const xMint = row.token_x?.address ?? null;
  const yMint = row.token_y?.address ?? null;
  if (!yMint) reasons.push("quote token mint unknown");
  else if (yMint !== SOL_MINT) reasons.push(`quote token is not SOL (${row.token_y?.symbol ?? yMint.slice(0, 4)})`);
  if (xMint === SOL_MINT) reasons.push("SOL is the base token");
  if (!ctx.ignoreRank) {
    const r = num(ctx.rank);
    if (r == null) reasons.push("not on the 2h top list");
    else if (r > D.maxRank) reasons.push(`rank #${r} > ${D.maxRank} on the 2h list`);
  }
  const created = num(row.token_x?.created_at);
  const now = num(ctx.now);
  if (created == null || now == null) reasons.push("token creation time unknown");
  else if ((now - created) / 3_600_000 > D.maxTokenAgeHours) reasons.push(`token age ${((now - created) / 3_600_000).toFixed(1)} h > ${D.maxTokenAgeHours} h`);
  const atvl = num(row.active_tvl);
  if (atvl == null || atvl < D.minActiveTvlUsd) reasons.push(`active TVL ${atvl == null ? "unknown" : usd(atvl)} < ${usd(D.minActiveTvlUsd)}`);
  const mcap = num(row.token_x?.market_cap ?? row.base_token_market_cap);
  if (mcap == null || mcap < D.minMcapUsd) reasons.push(`market cap ${mcap == null ? "unknown" : usd(mcap)} < ${usd(D.minMcapUsd)}`);
  const holders = num(row.base_token_holders ?? row.token_x?.holders);
  if (holders == null || holders < D.minHolders) reasons.push(`holders ${holders ?? "unknown"} < ${D.minHolders}`);
  // The API's authority flags are a free pre-filter; the on-chain mint read decides (laneSafetyChecks).
  if (row.token_x?.has_mint_authority === true) reasons.push("mint authority enabled");
  if (row.token_x?.has_freeze_authority === true) reasons.push("freeze authority enabled");
  try { if (xMint && typeof ctx.isBlacklisted === "function" && ctx.isBlacklisted(xMint)) reasons.push("token blacklisted"); } catch { reasons.push("token blacklist unreadable"); }
  const dev = row.token_x?.dev ?? null;
  try { if (dev && typeof ctx.isDevBlocked === "function" && ctx.isDevBlocked(dev)) reasons.push("dev blocklisted"); } catch { reasons.push("dev blocklist unreadable"); }
  return reasons;
}

/**
 * Mint safety from a jsonParsed getAccountInfo `value` (owner + data.parsed.info). An SPL Token
 * mint cannot carry extensions; a Token-2022 mint is checked for transferFeeConfig (the larger
 * of the older / newer bps) and transferHook (a program id). Unreadable → { read: false }.
 */
export function parseMintSafety(value) {
  const info = value?.data?.parsed?.info;
  if (!value || !info || typeof info !== "object") return { read: false };
  const program = value.owner ?? null;
  const exts = Array.isArray(info.extensions) ? info.extensions : [];
  let feeBps = 0;
  const fee = exts.find((e) => e?.extension === "transferFeeConfig");
  if (fee) {
    const s = fee.state || {};
    const bps = [s.newerTransferFee?.transferFeeBasisPoints, s.olderTransferFee?.transferFeeBasisPoints].map(Number).filter(Number.isFinite);
    feeBps = bps.length ? Math.max(0, ...bps) : 0;
  }
  const hook = exts.find((e) => e?.extension === "transferHook");
  const hookProgram = hook?.state?.programId ?? null;
  // Recorded, NOT gated (the registered gate is transfer fee + hook only): other Token-2022
  // extensions that can hurt a holder.
  const ext = (name) => exts.find((e) => e?.extension === name) || null;
  const pd = ext("permanentDelegate");
  const das = ext("defaultAccountState");
  const risky = {
    permanent_delegate: pd ? (pd.state?.delegate ?? null) || "present" : null,
    default_account_state_frozen: das ? das.state?.accountState === "frozen" : null,
    pausable: !!(ext("pausableConfig") || ext("pausable")),
    confidential_transfer: !!(ext("confidentialTransferMint") || ext("confidentialTransferFeeConfig")),
  };
  return {
    read: true,
    program,
    decimals: num(info.decimals),
    mint_authority: info.mintAuthority ?? null,
    freeze_authority: info.freezeAuthority ?? null,
    transfer_fee_bps: feeBps,
    transfer_hook_program: hookProgram || null,
    extensions: exts.map((e) => e?.extension).filter(Boolean),
    risky_extensions: risky,
  };
}

/**
 * Checks on the token safety reads. safety = { mint: parseMintSafety(…), fees_sol, jupiter_audit }
 * (null = the reads failed). Returns every failing check.
 */
export function laneSafetyChecks(safety) {
  if (!safety || typeof safety !== "object") return ["token safety reads unavailable"];
  const reasons = [];
  const m = safety.mint;
  if (!m || m.read !== true) reasons.push("mint account unreadable");
  else {
    if (m.mint_authority) reasons.push("mint authority enabled (on chain)");
    if (m.freeze_authority) reasons.push("freeze authority enabled (on chain)");
    if (Number(m.transfer_fee_bps) > 0) reasons.push(`transfer fee ${m.transfer_fee_bps} bps`);
    if (m.transfer_hook_program) reasons.push("transfer hook");
  }
  const fees = num(safety.fees_sol);
  if (fees == null) reasons.push("token fees unknown");
  else if (fees < LANE_DEFINITION.minTokenFeesSol) reasons.push(`token fees ${fees.toFixed(2)} SOL < ${LANE_DEFINITION.minTokenFeesSol} SOL`);
  return reasons;
}

/** The full definition: { ok, reasons[] } (row checks first, then the safety reads). */
export function laneQualifies(row, audit, ctx = {}) {
  const reasons = [...laneRowChecks(row, ctx), ...laneSafetyChecks(audit)];
  return { ok: reasons.length === 0, reasons };
}

/**
 * Active bin from the API's pool_price (SOL per whole token): price × 10^(decY − decX) is the
 * raw-unit price the DLMM program stores as (1 + binStep/1e4)^bin. null when not computable.
 */
export function priceToBin(price, binStep, decX, decY = 9) {
  const p = num(price), s = num(binStep), dx = num(decX), dy = num(decY);
  if (p == null || p <= 0 || s == null || s <= 0 || dx == null || dy == null) return null;
  const raw = p * Math.pow(10, dy - dx);
  const b = Math.log(raw) / Math.log(1 + s / 1e4);
  return Number.isFinite(b) ? Math.round(b) : null;
}

const toIso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** What a paper entry stores about the pool at entry (the whole row is kept as well). */
export function laneSnapshot(row, audit, ctx = {}) {
  const now = num(ctx.now);
  const binStep = num(row?.dlmm_params?.bin_step);
  const decX = num(row?.token_x?.decimals);
  const decY = num(row?.token_y?.decimals) ?? 9;
  const price = num(row?.pool_price);
  const tokenCreated = num(row?.token_x?.created_at);
  const poolCreated = num(row?.pool_created_at);
  const ja = audit?.jupiter_audit || null;
  return {
    definition: { ...LANE_DEFINITION, reentry_gap_hours: LANE_REENTRY_GAP_HOURS, list_filter: LANE_LIST_FILTER, list_timeframe: LANE_LIST_TIMEFRAME },
    at: toIso(now),
    rank: num(ctx.rank),
    pair: pairOf(row),
    pool: row?.pool_address ?? null,
    base_mint: row?.token_x?.address ?? null,
    token_created_at: toIso(tokenCreated),
    pool_created_at: toIso(poolCreated),
    token_age_min: tokenCreated != null && now != null ? Math.round((now - tokenCreated) / 60000) : null,
    pool_age_min: poolCreated != null && now != null ? Math.round((now - poolCreated) / 60000) : null,
    bin_step: binStep,
    dec_x: decX,
    dec_y: decY,
    price,
    active_bin: priceToBin(price, binStep, decX, decY),
    sol_price_usd: num(row?.token_y?.price),
    tvl: num(row?.tvl),
    active_tvl: num(row?.active_tvl),
    market_cap: num(row?.token_x?.market_cap),
    holders: num(row?.base_token_holders ?? row?.token_x?.holders),
    // recorded, NOT gated (the grading looks at them)
    recorded: {
      bot_holders_pct: num(ja?.bot_holders_pct),
      bundler_pct: num(ja?.bundler_pct),
      top10_pct_row: num(row?.token_x?.top_holders_pct),
      top10_pct_audit: num(ja?.top_holders_pct),
      dev_migrations: num(ja?.dev_migrations),
      dev_mints: num(ja?.dev_mints),
      dev_balance_pct: num(row?.token_x?.dev_balance_pct),
      dev: row?.token_x?.dev ?? null,
      fee_pct: num(row?.fee_pct),
      dynamic_fee_pct: num(row?.dynamic_fee_pct),
      organic_score: num(row?.token_x?.organic_score),
      is_blacklisted_meteora: row?.is_blacklisted ?? null,
      risky_extensions: audit?.mint?.risky_extensions ?? null,
    },
    safety: audit ?? null,
    row: row ?? null,
  };
}

/**
 * One tracking tick from a discovery row (5-minute timeframe). serverMs = the response's Date
 * header (else the local clock: feeTimeSource "local"); fee1h = the pool's timeframe=1h fee when
 * it was read this poll (once per bucket), else null.
 */
export function tickFromRow(row, { at, rank = null, feeWindowMin = TRACK_FEE_WINDOW_MIN, serverMs = null, fee1h = null } = {}) {
  const tMs = num(serverMs) ?? num(at);
  const binStep = num(row?.dlmm_params?.bin_step);
  const decX = num(row?.token_x?.decimals);
  const decY = num(row?.token_y?.decimals) ?? 9;
  const price = num(row?.pool_price);
  return {
    at: toIso(num(at)),
    seen: true,
    active_bin: priceToBin(price, binStep, decX, decY),
    price,
    tvl: num(row?.tvl),
    active_tvl: num(row?.active_tvl),
    fee_usd: num(row?.fee),
    fee_window_min: feeWindowMin,
    fee_bucket_start: toIso(feeBucketStart(tMs)),
    fee_time_source: num(serverMs) != null ? "server" : "local",
    fee_1h_usd: num(fee1h),
    volume_usd: num(row?.volume),
    market_cap: num(row?.token_x?.market_cap),
    holders: num(row?.base_token_holders ?? row?.token_x?.holders),
    rank: num(rank),
    sol_price_usd: num(row?.token_y?.price),
  };
}
/** A poll at which the tracked pool was not in the batch answer (delisted, API gap). */
export function unseenTick(at) {
  return { at: toIso(num(at)), seen: false, active_bin: null, price: null, tvl: null, active_tvl: null, fee_usd: null, fee_window_min: null, fee_bucket_start: null, fee_time_source: null, fee_1h_usd: null, volume_usd: null, market_cap: null, holders: null, rank: null, sol_price_usd: null };
}

/**
 * One paper entry per pool per qualification episode: a pool may open a paper entry at `now`
 * only when no earlier paper entry of that pool was entered within (its tracking hours +
 * LANE_REENTRY_GAP_HOURS) before `now` — i.e. none is open and the last one's window ended at
 * least 6 h ago. prev = [{ entered_at (ms or ISO), track_hours }].
 */
export function episodeAllows(prev, now, trackHours = FRESH_LANE_TRACK_DEFAULT_H) {
  for (const p of Array.isArray(prev) ? prev : []) {
    const t = typeof p?.entered_at === "number" ? p.entered_at : Date.parse(p?.entered_at);
    if (!Number.isFinite(t)) continue;
    const h = num(p?.track_hours) ?? trackHours;
    const until = t + (h + LANE_REENTRY_GAP_HOURS) * 3_600_000;
    if (now < until) return { ok: false, until, reason: now < t + h * 3_600_000 ? "paper entry still open" : "inside the 6 h gap after the last entry's window" };
  }
  return { ok: true, until: null, reason: null };
}

export function wouldEnterLine(snap, mode = "shadow") {
  const r = snap?.recorded || {};
  const bot = r.bot_holders_pct == null ? "n/a" : `${r.bot_holders_pct.toFixed(1)} %`;
  const fee = r.fee_pct == null ? "n/a" : `${r.fee_pct} %`;
  return `[FRESH_LANE_SHADOW] would-enter ${snap?.pair}: rank #${snap?.rank} on the 2h list, token age ${snap?.token_age_min ?? "?"}m, active TVL ${snap?.active_tvl == null ? "n/a" : usd(snap.active_tvl)}, mcap ${snap?.market_cap == null ? "n/a" : usd(snap.market_cap)}, fee tier ${fee}, bot holders ${bot} (freshLaneMode=${mode})`;
}

/**
 * Rate headers of the discovery API (x-ratelimit-limit / -remaining / -reset; reset is a unix
 * timestamp in seconds, a small value is read as seconds from now). Headers object or Map-like.
 */
export function parseRateHeaders(headers, now) {
  const get = (k) => { try { return typeof headers?.get === "function" ? headers.get(k) : headers?.[k]; } catch { return null; } };
  const limit = num(get("x-ratelimit-limit"));
  const remaining = num(get("x-ratelimit-remaining"));
  const reset = num(get("x-ratelimit-reset"));
  let resetMs = null;
  if (reset != null) resetMs = reset > 1e12 ? reset : reset > 1e9 ? reset * 1000 : now + reset * 1000;
  return { limit, remaining, resetMs };
}
