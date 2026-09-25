// Harvest → straddle (operator technique, 2026-09-25).
//
// When the round-trip harvest fires the position is 100% SOL above its range. The
// operator's practice on a pool that is still trending up is not to cash out but to
// "rebalance" on Meteora: convert half to base and open a symmetric range around the
// current price (spot or curve), which keeps earning fees both ways for hours.
// This module decides whether to do that instead of closing. Shadow-first:
// harvestStraddleMode "off" | "shadow" (log `[STRADDLE_SHADOW]`, close as usual) |
// "enforce" (rebalance_position with straddle=true → SOL→base swap of the chosen ratio
// + two-sided deposit, proceeds-only, chain depth capped by rebalanceMaxCount).
// Different from the removed roll-up engine, which re-opened a single-sided SOL
// ladder below the new price (buying nothing, earning nothing on the way down).
import { log as defaultLog } from "./logger.js";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function evaluateHarvestStraddle({ tracked, cfg = {}, trend = null }) {
  const mode = String(cfg.harvestStraddleMode ?? "shadow").toLowerCase();
  const base = { mode, enforce: false, eligible: false, params: null };
  if (mode === "off") return { ...base, reason: "harvestStraddleMode=off" };
  if (!tracked) return { ...base, reason: "untracked position" };
  if (tracked.hold_mode === true) return { ...base, reason: "operator HOLD" };
  const maxCount = Math.max(0, Number(cfg.rebalanceMaxCount ?? 2));
  const count = Number(tracked.rebalance_count ?? 0);
  if (count >= maxCount) return { ...base, reason: `chain depth ${count} >= rebalanceMaxCount ${maxCount}` };
  const minProceeds = Number(cfg.harvestStraddleMinProceedsSol ?? 0.3);
  const amt = Number(tracked.amount_sol ?? 0);
  if (!(amt >= minProceeds)) return { ...base, reason: `position ◎${amt.toFixed(3)} below harvestStraddleMinProceedsSol ◎${minProceeds}` };
  if (!trend?.confirmed) return { ...base, reason: trend?.reason ? `trend not up (${trend.reason})` : "trend not confirmed" };
  const bins = Math.round(clamp(Number(cfg.harvestStraddleBins ?? 34), 10, 34));
  const params = {
    shape: String(cfg.harvestStraddleShape ?? "spot").toLowerCase() === "curve" ? "curve" : "spot",
    bins,
    ratio: clamp(Number(cfg.harvestStraddleRatio ?? 0.5), 0.2, 0.8),
    maxImpactPct: Math.max(0.1, Number(cfg.harvestStraddleMaxImpactPct ?? 3)),
  };
  return { mode, eligible: true, enforce: mode === "enforce", reason: trend.reason, params };
}

/**
 * Async decision used by the poller and the management cycle at a confirmed
 * ROUND_TRIP_HARVEST. Fetches the short trend (GeckoTerminal 5m candles) only when
 * the cheap checks pass. Never throws.
 */
export async function decideHarvestStraddle({ p, tracked, cfg = {}, log = defaultLog, fetchTrend = null }) {
  const pair = p?.pair || tracked?.pool_name || p?.position;
  const mode = String(cfg.harvestStraddleMode ?? "shadow").toLowerCase();
  if (mode === "off") return { mode, enforce: false, eligible: false, reason: "off" };
  // Cheap gates first (no network).
  const pre = evaluateHarvestStraddle({ tracked, cfg, trend: { confirmed: true, reason: "pending" } });
  if (!pre.eligible) {
    log("straddle", `[STRADDLE] ${pair}: harvest closes to cash — ${pre.reason}`);
    return pre;
  }
  let trend;
  try {
    const fn = fetchTrend || (await import("./tools/rebalance-trend.js")).isRebalanceTrendIncreasing;
    trend = await fn(p.pool || tracked?.pool, {
      timeframe: cfg.harvestStraddleTrendTimeframe || "5m",
      candleCount: Number(cfg.harvestStraddleTrendCandles ?? 3),
    });
  } catch (e) {
    trend = { confirmed: false, reason: `trend fetch failed: ${e.message}` };
  }
  const d = evaluateHarvestStraddle({ tracked, cfg, trend });
  if (!d.eligible) {
    log("straddle", `[STRADDLE] ${pair}: harvest closes to cash — ${d.reason}`);
  } else if (d.enforce) {
    log("straddle", `[STRADDLE] ${pair}: trend up (${d.reason}) → converting the harvest into a ${Math.round(d.params.ratio * 100)}/${Math.round((1 - d.params.ratio) * 100)} ${d.params.shape} range ±${d.params.bins} bins instead of cashing out`);
  } else {
    log("straddle", `[STRADDLE_SHADOW] would straddle ${pair} after the harvest: trend up (${d.reason}); ${d.params.shape} ±${d.params.bins} bins, ${Math.round(d.params.ratio * 100)}% to base — harvestStraddleMode=shadow, closing to cash`);
  }
  return d;
}
