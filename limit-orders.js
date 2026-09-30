/**
 * limit-orders.js — the operator's manually placed Meteora limit orders, as seen by
 * the bot's accounting (read-only; the bot never places or cancels orders).
 *
 * An open order escrows SOL or tokens in a Meteora account the bot's AUM does not
 * count (balance_history.totalSol excludes it by contract — the dashboard adds open
 * orders on top). Without this module the wallet reconciliation read every placement
 * as a loss and every withdrawal as a gain: the JEANPHIL-SOL order (0.917 SOL in on
 * 2026-09-21, 1.306 SOL out on 09-22) showed as +1.19 SOL of unexplained drift.
 *
 *   getOpenLimitOrderValue()  — current value of open orders (sampler, 1 request)
 *   getLimitOrderFlows()      — every order's placement/withdrawal (ledger-truth)
 *   orderFlowsBetween()       — pure: SOL out/in and realized P&L inside a window
 *
 * Source: Meteora data API (dlmm.datapi.meteora.ag), the same feed the dashboard uses.
 * Never throws into callers that ask for the value; the flows call throws so the
 * reconciliation can say "unavailable" instead of silently reporting drift.
 */
import { log } from "./logger.js";

const API = "https://dlmm.datapi.meteora.ag";
const VALUE_TTL_MS = 60_000;
const FLOWS_TTL_MS = 10 * 60_000;
const VALUE_STALE_MAX_MS = 15 * 60_000;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const poolAddressOf = (s) => s?.pool?.pool_address || s?.pool_address || null;

async function getJson(url, fetchImpl, timeoutMs = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body || !Array.isArray(body.data)) throw new Error("invalid response");
    return body;
  } finally {
    clearTimeout(t);
  }
}

/** All pages of a paginated `{ data, pages }` endpoint. */
async function getAllPages(url, fetchImpl) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const body = await getJson(`${url}${url.includes("?") ? "&" : "?"}page=${page}&page_size=100`, fetchImpl);
    out.push(...body.data);
    if (!(Number(body.pages) > page)) break;
  }
  return out;
}

let _value = null; // { wallet, at, sol, usd, count }
/**
 * Current value of the wallet's open limit orders (unfilled escrow + claimable fills),
 * from the open-pools summary. On an API failure the last good value is reused for up
 * to 15 min (flagged stale) so a feed blip never shows as an AUM drop; older → null.
 */
export async function getOpenLimitOrderValue(wallet, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!wallet) return null;
  if (_value?.wallet === wallet && now - _value.at < VALUE_TTL_MS) return _value;
  try {
    const pools = await getAllPages(`${API}/wallets/${encodeURIComponent(wallet)}/limit_orders/open/pools`, fetchImpl);
    _value = {
      wallet, at: now, stale: false,
      sol: pools.reduce((s, p) => s + num(p.total_current_value_sol), 0),
      usd: pools.reduce((s, p) => s + num(p.total_current_value_usd), 0),
      count: pools.reduce((s, p) => s + (num(p.total_orders) || 1), 0),
    };
    return _value;
  } catch (e) {
    log("limit_orders_warn", `Open limit-order value unavailable: ${e.message}`);
    if (_value?.wallet === wallet && now - _value.at < VALUE_STALE_MAX_MS) return { ..._value, stale: true };
    return null;
  }
}

let _flows = null; // { wallet, at, orders }
/**
 * Every open and closed order with its placement (opened_at, deposit value in SOL at
 * placement) and, when closed, its withdrawal (last_closed_at, SOL value withdrawn).
 * Throws on API failure (after one cached-copy fallback) so callers can report it.
 */
export async function getLimitOrderFlows(wallet, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (!wallet) return [];
  if (_flows?.wallet === wallet && now - _flows.at < FLOWS_TTL_MS) return _flows.orders;
  const base = `${API}/wallets/${encodeURIComponent(wallet)}/limit_orders`;
  try {
    const orders = [];
    for (const status of ["open", "closed"]) {
      const pools = await getAllPages(`${base}/${status}/pools`, fetchImpl);
      for (const summary of pools) {
        const pool = poolAddressOf(summary);
        if (!pool) continue;
        const rows = await getAllPages(`${base}/${status}/pools/${encodeURIComponent(pool)}`, fetchImpl);
        for (const o of rows) {
          const opened = num(o.opened_at);
          if (!(opened > 0)) continue;
          const closed = status === "closed" ? num(o.last_closed_at) : 0;
          orders.push({
            address: o.limit_order_address || null,
            pool,
            status,
            opened_ms: opened * 1000,
            deposit_sol: num(o.total_deposit_sol ?? o.input_amount_sol),
            closed_ms: closed > 0 ? closed * 1000 : null,
            withdrawal_sol: status === "closed" ? num(o.total_withdrawal_sol) : 0,
          });
        }
      }
    }
    _flows = { wallet, at: now, orders };
    return orders;
  } catch (e) {
    if (_flows?.wallet === wallet) {
      log("limit_orders_warn", `Limit-order history unavailable (${e.message}) — using the copy from ${new Date(_flows.at).toISOString()}`);
      return _flows.orders;
    }
    throw e;
  }
}

/**
 * Pure. SOL leaving the wallet's book into orders placed in (start, end], SOL coming
 * back from orders withdrawn in (start, end], and the realized P&L of those withdrawn
 * orders (withdrawal − deposit, whenever they were placed).
 */
export function orderFlowsBetween(orders, startMs, endMs) {
  const inWin = (ms) => ms != null && ms > startMs && ms <= endMs;
  let outSol = 0, inSol = 0, realized = 0, placed = 0, closed = 0;
  for (const o of orders || []) {
    if (inWin(o.opened_ms)) { outSol += num(o.deposit_sol); placed++; }
    if (inWin(o.closed_ms)) { inSol += num(o.withdrawal_sol); realized += num(o.withdrawal_sol) - num(o.deposit_sol); closed++; }
  }
  return { out_sol: outSol, in_sol: inSol, realized_sol: realized, placed, closed };
}
