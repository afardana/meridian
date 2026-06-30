/**
 * lper-signal.js — LPAgent winning-LPer signal for the screener (advisory, plan #3).
 *
 * Surfaces what the top/winning LPers on a candidate pool are actually doing (range style,
 * width, hold time, win rate) into the SCREENER candidate blocks — the cheap version of
 * yunus's "30k wallet" playstyle dataset, using LPAgent aggregates we already have access to
 * via tools/study.js. Deterministic enrichment (like fee-efficiency / organic-momentum), so
 * no extra LLM tool-call. See docs/plans/03-lpagent-screener-signal.md.
 */

import { studyTopLPers } from "./tools/study.js";
import { log } from "./logger.js";

const _cache = new Map(); // pool_address -> { ts, data }
const TTL_MS = 30 * 60 * 1000; // matches LPAgent's ~30m server-side aggregate cache

/**
 * Fetch (cached) the LPAgent study for a pool. Never throws — 429 / no-data / API error
 * degrades to null so the caller simply omits the line. Cached for TTL_MS per pool.
 */
export async function getCachedLpStudy(poolAddress) {
  if (!poolAddress) return null;
  const cached = _cache.get(poolAddress);
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;
  let data = null;
  try {
    data = await studyTopLPers({ pool_address: poolAddress, limit: 4 });
  } catch (e) {
    log("screening", `LPAgent study skipped for ${poolAddress.slice(0, 8)}: ${e.message}`);
  }
  _cache.set(poolAddress, { ts: Date.now(), data });
  return data;
}

const sanitizeStyle = (s) => String(s == null ? "" : s).replace(/[^a-z0-9_-]/gi, "").slice(0, 20);

/** Consensus range-style across the studied winners → { name, count, total } or null. */
export function lperConsensusStyle(study) {
  const styles = study?.patterns?.preferred_range_styles || {};
  const entries = Object.entries(styles).filter(([k]) => k && k !== "unknown");
  if (!entries.length) return null;
  const total = entries.reduce((s, [, c]) => s + c, 0);
  const [name, count] = entries.sort((a, b) => b[1] - a[1])[0];
  return { name: sanitizeStyle(name), count, total };
}

/**
 * One advisory candidate-block line on what the winning LPers on this pool are doing.
 * Returns null when there's no usable study data (so `.filter(Boolean)` drops it).
 * All interpolated fields are numeric or sanitized-enum — safe to put in the prompt.
 */
export function formatTopLperStyle(study) {
  if (!study || !Array.isArray(study.lpers) || study.lpers.length === 0) return null;
  const p = study.patterns || {};
  const lpers = study.lpers;
  const count = p.top_lper_count || lpers.length;

  const consensus = lperConsensusStyle(study);
  const widths = lpers.flatMap((l) => (l.positions || []).map((pos) => pos.range_width_pct))
    .filter((w) => Number.isFinite(w) && w > 0);
  const avgBins = widths.length ? Math.round(widths.reduce((s, w) => s + w, 0) / widths.length) : null;
  const wins = lpers.map((l) => l.summary?.win_rate).filter((w) => Number.isFinite(w));
  const avgWin = wins.length ? Math.round((wins.reduce((s, w) => s + w, 0) / wins.length) * 100) : null;
  const hold = Number.isFinite(p.avg_hold_hours) ? p.avg_hold_hours : null;
  const openPnl = Number.isFinite(p.avg_open_pnl_pct) ? p.avg_open_pnl_pct : null;
  const suggested = p.suggested_style && p.suggested_style !== "unknown" ? sanitizeStyle(p.suggested_style) : null;

  const parts = [
    `${count} winners`,
    consensus ? `style=${consensus.name} (${consensus.count}/${consensus.total})` : null,
    avgBins != null ? `~${avgBins} bins` : null,
    hold != null ? `hold ${hold}h` : null,
    avgWin != null ? `win ${avgWin}%` : null,
    openPnl != null ? `open_pnl ${openPnl >= 0 ? "+" : ""}${openPnl}%` : null,
  ].filter(Boolean);
  let line = `top_lpers: ${parts.join(", ")}`;
  if (suggested) line += ` [suggested: ${suggested}]`;
  return line;
}
