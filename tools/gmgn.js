import { randomUUID } from "crypto";
import { setDefaultResultOrder } from "dns";
import { config } from "../config.js";
import { log } from "../logger.js";

// Force IPv4 — GMGN OpenAPI does not support IPv6
setDefaultResultOrder("ipv4first");

let lastGmgnRequestAt = 0;

// Ban-cooldown circuit breaker: once GMGN reports an IP ban (or 429s persist past
// the in-call retries), stop calling the API entirely for a while — re-hitting a
// banned IP every screening cycle extends the ban and floods the logs. Callers
// already fail open on any error, so a cooldown just means Jupiter-audit fallback.
let gmgnCooldownUntil = 0;
const GMGN_COOLDOWN_ERROR = "GMGN cooldown active";

export function isGmgnCoolingDown() {
  return Date.now() < gmgnCooldownUntil;
}

function enterGmgnCooldown(minutes, reason) {
  const until = Date.now() + minutes * 60000;
  // Racing in-flight calls that all see the same ban would each "extend" the
  // cooldown by seconds and re-log — only extend/log for a meaningful jump.
  if (until <= gmgnCooldownUntil + 60_000) return;
  gmgnCooldownUntil = until;
  log("gmgn", `entering ${minutes}m cooldown (${reason}) — GMGN lookups skipped until ${new Date(until).toISOString()}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// GMGN endpoint weights (community-documented rate-limit weights, 2026-08-19 sweep —
// docs/research/telegram/meridian-telegram-2026-08-19.txt): heavier endpoints consume
// more of the per-IP budget, so pacing scales with weight. All our LIVE calls are
// weight-1 (/v1/token/info); the heavier rows exist so a future holders/traders or
// discovery consumer can't accidentally ban the IP with weight-1 pacing.
const ENDPOINT_WEIGHTS = [
  [/token_top_holders|token_top_traders/, 5],
  [/trenches|market\/rank/, 3],
  [/kline|chart/, 2],
];
const WEIGHT_DELAY_MULT = { 1: 1, 2: 1.5, 3: 2.2, 5: 3.5 };

function weightForPath(pathname) {
  for (const [re, w] of ENDPOINT_WEIGHTS) if (re.test(String(pathname))) return w;
  return 1;
}

async function paceGmgnRequest(weight = 1) {
  const base = Math.max(0, Number(config.gmgn?.requestDelayMs ?? 2500));
  const delayMs = Math.round(base * (WEIGHT_DELAY_MULT[weight] ?? 1));
  if (!delayMs) return;
  const elapsed = Date.now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = Date.now();
}

function getApiKey() {
  const key = config.gmgn?.apiKey || process.env.GMGN_API_KEY;
  if (!key) throw new Error("GMGN_API_KEY is not configured.");
  return key;
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter((item) => item != null && item !== "")) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(pathname, { method = "GET", params = {}, body = null } = {}) {
  const baseUrl = String(config.gmgn?.baseUrl || "https://openapi.gmgn.ai").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${pathname}`);
  appendParams(url, {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  });

  if (isGmgnCoolingDown()) throw new Error(GMGN_COOLDOWN_ERROR);

  const weight = weightForPath(pathname);
  const maxRetries = Math.max(0, Number(config.gmgn?.maxRetries ?? 2));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceGmgnRequest(weight);
    const res = await fetch(url, {
      method,
      headers: {
        "X-APIKEY": getApiKey(),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : null,
    });
    const text = await res.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    const message = payload?.message || payload?.error || payload?.raw || `GMGN ${pathname} ${res.status}`;
    const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
    if (res.ok) return payload;
    if (/temporarily banned/i.test(String(message))) {
      // IP ban: in-call retries only extend it — back off hard instead.
      enterGmgnCooldown(Math.max(1, Number(config.gmgn?.banCooldownMinutes ?? 180)), "IP ban response");
      throw new Error(message);
    }
    if (rateLimited && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : Math.min(30000, 3000 * Math.pow(2, attempt));
      await sleep(backoffMs);
      continue;
    }
    if (rateLimited) {
      enterGmgnCooldown(Math.max(1, Number(config.gmgn?.rateLimitCooldownMinutes ?? 15)), "persistent 429");
    }
    throw new Error(message);
  }
  throw new Error(`GMGN ${pathname} failed`);
}

function unwrapList(payload, keys = ["list", "rank", "data"]) {
  if (Array.isArray(payload)) return payload;
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.data?.[key])) return payload.data[key];
    if (Array.isArray(payload?.data?.data?.[key])) return payload.data.data[key];
  }
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  return [];
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ratioPct(value) {
  const n = optionalNum(value);
  if (n == null) return null;
  return Number((n * 100).toFixed(2));
}

function hasTag(entry, tag) {
  const tags = []
    .concat(entry?.tags || [])
    .concat(entry?.maker_token_tags || [])
    .map((value) => String(value || "").toLowerCase());
  return tags.includes(tag);
}

// Smart-money read of GMGN top holders/traders. Only checkGmgnSmartExodus consumes
// this now — the GMGN discovery source (KOL/bundler/sniper analysis, candidate
// condensing) was removed 2026-09-25 (audit 01 §3).
function analyzeHoldersAndTraders(holders = [], traders = []) {
  const combined = [...holders, ...traders];
  const smartHolding = holders.filter((entry) => hasTag(entry, "smart_degen") && !entry.end_holding_at).length;
  const smartTraders = traders.filter((entry) => hasTag(entry, "smart_degen"));
  const smartAccumulating = smartTraders.filter((entry) => num(entry.buy_volume_cur) > num(entry.sell_volume_cur)).length;
  const smartExiting = smartTraders.filter((entry) => num(entry.sell_volume_cur) > num(entry.buy_volume_cur)).length;
  const mostlyExited = combined.filter((entry) =>
    (hasTag(entry, "kol") || hasTag(entry, "smart_degen")) &&
    num(entry.sell_amount_percentage) >= 0.8
  ).length;
  return { smartHolding, smartAccumulating, smartExiting, mostlyExited };
}

// ─── Fee source for the minTokenFeesSol gate ────────────────────
export function hasGmgnApiKey() {
  return !!(config.gmgn?.apiKey || process.env.GMGN_API_KEY);
}

// Shared /v1/token/info payload cache: the fee, safety, and dev wrappers below all
// read the SAME endpoint with the SAME params — without this, enriching one candidate
// burned three identical HTTP calls (the main driver of our GMGN 429/IP bans; bans
// recurred 2026-08-20 even at 1.2s flat pacing). Caches the IN-FLIGHT promise so
// concurrent wrappers share one request; a rejected fetch evicts itself so the next
// call retries. 5-min TTL — safety/dev/fee stats move slowly at that scale.
const _tokenInfoCache = new Map(); // mint -> { at, promise }
const TOKEN_INFO_CACHE_MS = 5 * 60_000;
const TOKEN_INFO_CACHE_MAX = 200;

function fetchTokenInfoCached(mint) {
  const now = Date.now();
  const hit = _tokenInfoCache.get(mint);
  if (hit && now - hit.at < TOKEN_INFO_CACHE_MS) return hit.promise;
  if (_tokenInfoCache.size >= TOKEN_INFO_CACHE_MAX) {
    const oldest = [..._tokenInfoCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) _tokenInfoCache.delete(oldest[0]);
  }
  const promise = gmgnFetch("/v1/token/info", { params: { chain: "sol", address: mint } });
  promise.catch(() => {
    const cur = _tokenInfoCache.get(mint);
    if (cur && cur.promise === promise) _tokenInfoCache.delete(mint);
  });
  _tokenInfoCache.set(mint, { at: now, promise });
  return promise;
}

// Returns { total_fee, trade_fee } in SOL, or null on missing key / error so
// callers can fall back to Jupiter's fee figure.
export async function getGmgnTokenFees(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  try {
    const payload = await fetchTokenInfoCached(mint);
    const info = payload?.data?.data || payload?.data || payload;
    if (!info || typeof info !== "object") return null;
    const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    return { total_fee: toNum(info.total_fee), trade_fee: toNum(info.trade_fee) };
  } catch (error) {
    if (error.message !== GMGN_COOLDOWN_ERROR)
      log("gmgn", `token fees lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}

// Fetch the on-chain safety stat block (holder concentration / bundler / bot /
// dev-team hold rates) for a mint from GMGN /v1/token/info. Values come back as
// GMGN fractional rates and are converted to 0-100 percentages via ratioPct — the
// same units intel-score.js scoreSafety expects. Returns null on missing key /
// error so callers fall back to the Jupiter audit (or the neutral Safety fallback).
export async function getGmgnSafetyInfo(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  try {
    const payload = await fetchTokenInfoCached(mint);
    const info = payload?.data?.data || payload?.data || payload;
    const stat = info?.stat;
    if (!stat || typeof stat !== "object") return null;
    return {
      top10_holder_pct: ratioPct(stat.top_10_holder_rate),
      bundler_pct: ratioPct(stat.top_bundler_trader_percentage),
      bot_pct: ratioPct(stat.bot_degen_rate),
      dev_team_hold_pct: ratioPct(stat.dev_team_hold_rate),
    };
  } catch (error) {
    if (error.message !== GMGN_COOLDOWN_ERROR)
      log("gmgn", `safety info lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}

// Fetch developer metadata (graduated token counts, creator alignment, ATH, etc.) from GMGN.
export async function getGmgnDevInfo(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  try {
    const payload = await fetchTokenInfoCached(mint);
    const info = payload?.data?.data || payload?.data || payload;
    if (!info || typeof info !== "object") return null;
    return info.dev || null;
  } catch (error) {
    if (error.message !== GMGN_COOLDOWN_ERROR)
      log("gmgn", `developer info lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}

// Fetch smart money wallet counts from token info
export async function getGmgnSmartMoneyInfo(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  try {
    const payload = await fetchTokenInfoCached(mint);
    const info = payload?.data?.data || payload?.data || payload;
    if (!info || typeof info !== "object") return null;
    const tags = info.wallet_tags_stat || {};
    return {
      smart_wallets: num(tags.smart_wallets),
      kol_wallets: num(tags.renowned_wallets),
    };
  } catch (error) {
    return null;
  }
}

// Event-driven check for smart money exodus on active positions.
// Only called on sharp downside moves (>=4% drop or >=8 bins OOR) with a 15m cooldown.
export async function checkGmgnSmartExodus(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  try {
    const [holdersPayload, tradersPayload] = await Promise.all([
      gmgnFetch("/v1/market/token_top_holders", {
        params: { chain: "sol", address: mint, limit: 50, order_by: "amount_percentage", direction: "desc" },
      }),
      gmgnFetch("/v1/market/token_top_traders", {
        params: { chain: "sol", address: mint, limit: 50, order_by: "profit", direction: "desc" },
      }),
    ]);
    const holders = unwrapList(holdersPayload, ["list", "holders", "data"]);
    const traders = unwrapList(tradersPayload, ["list", "traders", "data"]);
    const analysis = analyzeHoldersAndTraders(holders, traders);
    return {
      smart_holding: analysis.smartHolding,
      smart_accumulating: analysis.smartAccumulating,
      smart_exiting: analysis.smartExiting,
      mostly_exited: analysis.mostlyExited,
    };
  } catch (error) {
    if (error.message !== GMGN_COOLDOWN_ERROR)
      log("gmgn", `smart exodus check failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}

