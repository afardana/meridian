/**
 * PVP (Player-vs-Player) symbol conflict detection.
 *
 * Detects when multiple mints share the same symbol and both have active
 * DLMM pools with meaningful TVL/holders/fees — a sign of a symbol war
 * where one or both tokens may be rugs or attention-splitters.
 *
 * Used by:
 *   - screening.js  → enrichPvpRisk() filters candidates pre-deploy
 *   - index.js      → management cycle checks open positions for emerging rivals
 */

import { log } from "./logger.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const PVP_RIVAL_LIMIT = 2;
const PVP_MIN_ACTIVE_TVL = 5_000;
const PVP_MIN_HOLDERS = 500;
const PVP_MIN_GLOBAL_FEES_SOL = 30;

export function normalizeSymbol(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

export async function searchAssetsBySymbol(symbol) {
  const res = await fetch(`${DATAPI_JUP}/assets/search?query=${encodeURIComponent(symbol)}`);
  if (!res.ok) throw new Error(`assets/search ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [data];
}

export async function findRivalPool(mint) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(mint)}&sort_by=${encodeURIComponent("tvl:desc")}&filter_by=${encodeURIComponent(`tvl>${PVP_MIN_ACTIVE_TVL}`)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rival pool search ${res.status}`);
  const data = await res.json();
  const pools = Array.isArray(data?.data) ? data.data : [];
  return pools.find((pool) => pool?.token_x?.address === mint || pool?.token_y?.address === mint) || null;
}

/**
 * Check a single token for PVP rival conflicts.
 *
 * @param {string} symbol   - token symbol (e.g. "BONK")
 * @param {string} ownMint  - the mint address we hold
 * @returns {object|null}   - rival info or null if no conflict
 */
export async function detectPvpRival(symbol, ownMint) {
  const norm = normalizeSymbol(symbol);
  if (!norm || !ownMint) return null;

  let assets;
  try {
    assets = await searchAssetsBySymbol(norm);
  } catch { return null; }

  const rivals = assets
    .filter((a) => normalizeSymbol(a?.symbol) === norm && a?.id && a.id !== ownMint)
    .sort((a, b) => Number(b?.liquidity || 0) - Number(a?.liquidity || 0))
    .slice(0, PVP_RIVAL_LIMIT);

  for (const rival of rivals) {
    const holders = Number(rival?.holderCount || 0);
    const fees = Number(rival?.fees || 0);
    if (holders < PVP_MIN_HOLDERS || fees < PVP_MIN_GLOBAL_FEES_SOL) continue;

    const rivalPool = await findRivalPool(rival.id).catch(() => null);
    if (!rivalPool) continue;

    return {
      rival_name: rival?.name || norm,
      rival_mint: rival.id,
      rival_pool: rivalPool.address,
      rival_tvl: Math.round(Number(rivalPool.tvl || 0)),
      rival_holders: holders,
      rival_fees: Number(fees.toFixed(2)),
    };
  }
  return null;
}

/**
 * Check open positions for PVP symbol conflicts.
 * Each position needs { pool_name (pair string), base_mint }.
 *
 * @param {Array<{pool_name: string, base_mint: string, position: string, pool: string}>} positions
 * @returns {Map<string, object>} positionAddress → pvp rival info
 */
export async function checkPositionsPvp(positions) {
  const results = new Map();
  if (!positions?.length) return results;

  const symbolCache = new Map();
  const unique = [];

  for (const p of positions) {
    const mint = p.base_mint;
    if (!mint) continue;
    const symbol = extractSymbolFromPair(p.pool_name || p.pair || "");
    if (!symbol) continue;
    unique.push({ position: p.position, symbol, mint });
  }

  await Promise.all(unique.map(async ({ position, symbol, mint }) => {
    let rival = symbolCache.get(mint);
    if (rival === undefined) {
      rival = await detectPvpRival(symbol, mint).catch(() => null);
      symbolCache.set(mint, rival);
    }
    if (rival) {
      results.set(position, { symbol, ...rival });
      log("pvp", `Position ${position.slice(0, 8)} (${symbol}): rival ${rival.rival_name} (${rival.rival_mint.slice(0, 8)}), tvl=$${rival.rival_tvl}`);
    }
  }));

  return results;
}

function extractSymbolFromPair(pairName) {
  if (!pairName) return null;
  const slash = pairName.indexOf("/");
  if (slash > 0) return pairName.slice(0, slash).trim();
  const dash = pairName.indexOf("-");
  if (dash > 0) return pairName.slice(0, dash).trim();
  return pairName.trim() || null;
}

export function formatPvpAlert(pvpInfo) {
  if (!pvpInfo) return null;
  return `⚔️ <b>PVP</b> rival <b>${pvpInfo.rival_name}</b> (${pvpInfo.rival_mint.slice(0, 8)}…) tvl=$${pvpInfo.rival_tvl} holders=${pvpInfo.rival_holders} fees=${pvpInfo.rival_fees}SOL`;
}
