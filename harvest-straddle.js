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
  const count = Number(tracked.rebalance_count ?? 0) + Number(tracked.straddle_count ?? 0);
  if (count >= maxCount) return { ...base, reason: `chain depth ${count} >= rebalanceMaxCount ${maxCount}` };
  const minProceeds = Number(cfg.harvestStraddleMinProceedsSol ?? 0.3);
  const amt = Number(tracked.amount_sol ?? 0);
  if (!(amt >= minProceeds)) return { ...base, reason: `position ◎${amt.toFixed(3)} below harvestStraddleMinProceedsSol ◎${minProceeds}` };
  if (!trend?.confirmed) return { ...base, reason: trend?.reason ? `trend not up (${trend.reason})` : "trend not confirmed" };
  // Net-gain ceiling (2026-10-03, log-only by default): of 27 harvests the passes that had
  // already run >= +15 % over the gate's candles did worst afterwards (price-only straddle
  // −8.8 % an hour later, 2 of 7 positive, vs −2.9 % for the weaker passes) — a spike that
  // big tends to revert. n = 7, so it only logs until live closes grade it.
  const ceiling = evaluateTrendCeiling(trend, cfg);
  if (ceiling.wouldSkip && ceiling.mode === "enforce") {
    return { ...base, reason: `trend ceiling (${ceiling.reason})`, ceiling };
  }
  const bins = Math.round(clamp(Number(cfg.harvestStraddleBins ?? 34), 10, 34));
  const params = {
    shape: String(cfg.harvestStraddleShape ?? "spot").toLowerCase() === "curve" ? "curve" : "spot",
    bins,
    ratio: clamp(Number(cfg.harvestStraddleRatio ?? 0.5), 0.2, 0.8),
    maxImpactPct: Math.max(0.1, Number(cfg.harvestStraddleMaxImpactPct ?? 3)),
    inPlace: cfg.harvestStraddleInPlace !== false,
  };
  return { mode, eligible: true, enforce: mode === "enforce", reason: trend.reason, params, ceiling };
}

/**
 * Net-gain ceiling on the trend gate. harvestStraddleTrendCeilingMode: off | shadow (default) |
 * enforce; harvestStraddleMaxTrendNetPct (15). Pure.
 */
export function evaluateTrendCeiling(trend, cfg = {}) {
  const mode = String(cfg.harvestStraddleTrendCeilingMode ?? "shadow").toLowerCase();
  const max = Number(cfg.harvestStraddleMaxTrendNetPct ?? 15);
  const net = Number(trend?.netGainPct);
  const wouldSkip = mode !== "off" && max > 0 && Number.isFinite(net) && net >= max;
  return { mode, max, wouldSkip, reason: wouldSkip ? `net +${net.toFixed(1)}% over the gate candles >= +${max}%` : null };
}

/**
 * What the gate saw at one harvest, kept on the position and carried into its closed record
 * so both the gate and the ceiling can be graded on live outcomes. Pure.
 */
export function buildStraddleGateRecord({ p, decision, trend, now = Date.now() }) {
  const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const candles = Array.isArray(trend?.candles) ? trend.candles : [];
  return {
    at: new Date(now).toISOString(),
    harvest_pnl_pct: n(p?.pnl_pct),
    trend_confirmed: trend ? trend.confirmed === true : null,
    trend_net_pct: n(trend?.netGainPct) != null ? Math.round(n(trend.netGainPct) * 100) / 100 : null,
    trend_green: n(trend?.greenCount),
    trend_candles: candles.length || null,
    candle_moves_pct: candles.map((c) => (c?.open > 0 ? Math.round((c.close / c.open - 1) * 1000) / 10 : null)),
    ceiling_would_skip: decision?.ceiling ? decision.ceiling.wouldSkip === true : null,
    eligible: decision?.eligible === true,
    enforce: decision?.enforce === true,
    reason: decision?.eligible ? null : String(decision?.reason || "").slice(0, 160),
  };
}

/**
 * Async decision used by the poller and the management cycle at a confirmed
 * ROUND_TRIP_HARVEST. Fetches the short trend (GeckoTerminal 5m candles) only when
 * the cheap checks pass. Never throws.
 */
export async function decideHarvestStraddle({ p, tracked, cfg = {}, log = defaultLog, fetchTrend = null, recordGate = null }) {
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
  if (d.ceiling?.wouldSkip && d.eligible) {
    log("straddle", `[STRADDLE_CEILING_SHADOW] would-skip ${pair}: ${d.ceiling.reason} (harvestStraddleTrendCeilingMode=${d.ceiling.mode})`);
  }
  try { recordGate?.(p?.position, buildStraddleGateRecord({ p, decision: d, trend })); } catch { /* capture only */ }
  if (!d.eligible) {
    log("straddle", `[STRADDLE] ${pair}: harvest closes to cash — ${d.reason}`);
  } else if (d.enforce) {
    log("straddle", `[STRADDLE] ${pair}: trend up (${d.reason}) → converting the harvest into a ${Math.round(d.params.ratio * 100)}/${Math.round((1 - d.params.ratio) * 100)} ${d.params.shape} range ±${d.params.bins} bins instead of cashing out`);
  } else {
    log("straddle", `[STRADDLE_SHADOW] would straddle ${pair} after the harvest: trend up (${d.reason}); ${d.params.shape} ±${d.params.bins} bins, ${Math.round(d.params.ratio * 100)}% to base — harvestStraddleMode=shadow, closing to cash`);
  }
  return d;
}

// ── Stage C funding headroom (2026-09-30) ────────────────────────────────────
// Stage C re-deposited 100 % of the bought base and 100 % of the position's SOL. The
// program's per-bin rounding and any trade between simulate and send then needed a hair
// more than exists: GO-SOL was 0.686 base short (0.03 %), ELON-SOL 64,238 lamports of
// wSOL short (the wallet holds no wSOL), and tOpenAI (Token-2022, 0.2 % transfer fee)
// can never top up its full balance. 3 of 6 in-place straddles failed at C this way.

/** Transfer fee (bps) of a jsonParsed mint account; the larger of the older/newer config. */
export function transferFeeBpsFromParsedMint(parsedInfo) {
  const ext = (parsedInfo?.extensions || []).find((e) => e?.extension === "transferFeeConfig");
  if (!ext) return 0;
  const s = ext.state || {};
  const bps = [s.newerTransferFee?.transferFeeBasisPoints, s.olderTransferFee?.transferFeeBasisPoints]
    .map(Number).filter(Number.isFinite);
  return bps.length ? Math.max(0, ...bps) : 0;
}

/** Raw base top-up that leaves `headroomBps` of the bought balance plus the transfer fee unspent. */
export function straddleTopUpRaw(boughtHuman, decimals, headroomBps, feeBps = 0) {
  const keepBps = Math.max(0, 10000 - Math.max(0, headroomBps) - Math.max(0, feeBps));
  const raw = Math.floor(Number(boughtHuman) * Math.pow(10, decimals));
  return Number.isFinite(raw) && raw > 0 ? Math.floor((raw * keepBps) / 10000) : 0;
}

/** A stage-C send refused for funding (retry once with more headroom), not anything else. */
export function isStraddleFundingError(message) {
  // Landed failures surface only as "Transaction … resulted in an error" (GO/ELON), preflight
  // ones as "Simulation failed" (tOpenAI); one retry with more headroom is cheap either way.
  return /insufficient (funds|lamports)|custom program error: 0x1\b|"Custom":1\b|Simulation failed|resulted in an error/i.test(String(message || ""));
}
// A harvest that is CLOSED sells nothing (the position is all SOL), so the exit pays no
// slippage. That is only true of a cash-out: a harvest routed into a straddle buys the base
// side, so the phrase is added here, at the close, and not to the harvest reason itself.
export function cashHarvestReason(reason, family) {
  const text = reason ? String(reason) : "";
  if (!text) return text;
  const isHarvest = family === "harvest" || /^Round-trip complete/.test(text);
  if (!isHarvest || /exit pays no slippage/.test(text)) return text;
  return `${text} — cash exit pays no slippage`;
}

// What to do with a position after an in-place straddle did not complete:
//   close_untouched — refused by the pre-check, nothing was sent → the harvest cashes out
//   close_reranged  — stage A landed (half the SOL is out, the rest re-centred) → cash out
//   keep            — a transaction failed before anything landed → leave it, the harvest re-fires
export function straddleFailureNextStep(res) {
  if (res?.pre_check === true) return "close_untouched";
  if (res?.changed === true) return "close_reranged";
  return "keep";
}

