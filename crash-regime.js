// crash-regime.js — pair-adaptive downside detection (2026-09-26, P(DOOM)-SOL review).
//
// The live crash-below / in-range-rug detectors use one fixed velocity (12 bins/min)
// for every pair. Ordinary 60 s dips differ 5–10× across pair types (p95 of the fastest
// ordinary in-range 60 s drop: token >7 d ≈ 1 bin, <24 h ≈ 4, volatility ≥6 ≈ 7, TVL
// <100k ≈ 6–7), so the fixed bar is sluggish on calm pairs and trips on noise for fresh
// volatile ones. The 31-day replay (scripts/replay/crash_path_replay.js, variant H8)
// found that only a SPLIT pays:
//   • calm regime (profile-eligible AND measured noise ≤ gate): a sensitive rule —
//     velocity peak-to-current (a flat stretch no longer dilutes a sudden drop), one
//     streak across the lower edge, thresholds scaled by the pair's own noise,
//     2 distinct valuations to confirm; a move ≥ 2× the threshold ("violent") must also
//     hold on every valuation for crashRegimeViolentPersistSec (30 s; 0 = the old
//     single-valuation shortcut). Replay: +0.47 SOL / 31 d vs live, 8 better / 5 worse.
//   • 2026-09-30 SI-SOL review: the single-valuation shortcut closed a calm pair at the
//     bottom of a 58-bin / 77 b/min wick (−5.05 %) that bounced +11 % inside the same
//     minute. 35-day replay: persisting violent moves for 30 s = +1.12 SOL vs +0.99,
//     9 better / 2 worse vs 8 / 5 (BUTTHOLE, FEELSGOOD wick fires gone, Stamp −0.7 → +5.1),
//     every slow-grind save kept.
//   • noisy regime (fresh / thin / volatile pairs, or noise above the gate): nothing
//     changes — the live detectors keep running. Every faster rule tested on these
//     pairs lost (dips recover; P(DOOM) #2's final plunge was 20 bins in 20 s).
// This module is pure: the caller owns one state object per position and passes one
// observation per poller tick (suspect valuations are not passed).

const W_BELOW_S = 90;       // velocity window below the range (s)
const W_IN_S = 300;         // velocity window inside the range (s)
const MIN_SPAN_S = 9;       // min time from the window peak before a velocity counts
const NOISE_WINDOW_MS = 30 * 60_000;
const NOISE_EXCLUDE_MS = 2 * 60_000;
const NOISE_MIN_SAMPLES = 20;
const IN_RANGE_MIN_DROP = 10; // bins
const IN_RANGE_MAX_PNL = -3;  // %

export function createCrashRegimeState() {
  return { trail: [], noise: [], streak: 0, lastKey: null, lastLogAt: 0, hitSince: null };
}

/** Entry-profile eligibility for the calm regime (unknown values do not disqualify). */
export function isCalmEligible(profile = {}, cfg = {}) {
  const vol = profile.volatility != null ? Number(profile.volatility) : null;
  const tvl = profile.entry_tvl != null ? Number(profile.entry_tvl) : null;
  const age = profile.token_age_hours != null ? Number(profile.token_age_hours) : null;
  const maxVol = Number(cfg.crashRegimeMaxVolatility ?? 6);
  const minTvl = Number(cfg.crashRegimeMinTvl ?? 50_000);
  const minAge = Number(cfg.crashRegimeMinTokenAgeHours ?? 24);
  if (Number.isFinite(vol) && vol >= maxVol) return false;
  if (Number.isFinite(tvl) && tvl < minTvl) return false;
  if (Number.isFinite(age) && age < minAge) return false;
  return true;
}

function p95(values) {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length * 0.95)];
}

/**
 * One poller observation. obs = { t, bin, pnl, lower, fresh }.
 * Returns { regime: "calm"|"noisy", noise, V, D, hit, violent, vel, drop, fire, where }.
 */
export function evaluateCrashRegime(state, obs, profile, cfg = {}) {
  const { t, bin, pnl, lower, fresh } = obs;
  const out = { regime: "noisy", noise: null, V: null, D: null, hit: false, violent: false, vel: 0, drop: 0, fire: false, where: null };
  if (!Number.isFinite(t) || !Number.isFinite(bin) || !Number.isFinite(lower)) return out;

  state.trail.push({ t, bin });
  while (state.trail.length && state.trail[0].t < t - W_IN_S * 1000) state.trail.shift();

  // Ordinary-dip log: fastest drop from the 60 s high, while healthy and in range.
  let max60 = -Infinity;
  for (let i = state.trail.length - 1; i >= 0 && state.trail[i].t >= t - 60_000; i--) max60 = Math.max(max60, state.trail[i].bin);
  const inRange = bin >= lower;
  if (inRange && (pnl == null || pnl > IN_RANGE_MAX_PNL)) state.noise.push([t, max60 - bin]);
  while (state.noise.length && state.noise[0][0] < t - NOISE_WINDOW_MS) state.noise.shift();

  let noise = Number(cfg.crashRegimeNoisePrior ?? 6);
  const samples = state.noise.filter(([ts]) => ts <= t - NOISE_EXCLUDE_MS).map(([, d]) => d);
  if (samples.length >= NOISE_MIN_SAMPLES) noise = Math.max(1, p95(samples));
  out.noise = noise;

  const gate = Number(cfg.crashRegimeNoiseGate ?? 3);
  const calm = isCalmEligible(profile, cfg) && noise <= gate;
  if (!calm) { state.streak = 0; state.lastKey = null; return out; }
  out.regime = "calm";

  const k = Number(cfg.crashRegimeK ?? 2.5);
  const V = Math.min(Number(cfg.crashRegimeVMax ?? 20), Math.max(Number(cfg.crashRegimeVMin ?? 6), k * noise));
  const D = Math.min(8, Math.max(Number(cfg.crashRegimeDMin ?? 3), Math.round(noise / 2)));
  out.V = V; out.D = D;

  const W = inRange ? W_IN_S : W_BELOW_S;
  let peak = -Infinity, peakT = t;
  for (let i = state.trail.length - 1; i >= 0 && state.trail[i].t >= t - W * 1000; i--) {
    if (state.trail[i].bin > peak) { peak = state.trail[i].bin; peakT = state.trail[i].t; }
  }
  const drop = peak - bin;
  const span = (t - peakT) / 1000;
  const vel = span >= MIN_SPAN_S ? drop / (span / 60) : 0;
  out.drop = drop; out.vel = vel;

  let hit;
  if (!inRange) { hit = lower - bin >= D && drop > 0 && vel >= V; out.where = "below"; }
  else { hit = pnl != null && pnl <= IN_RANGE_MAX_PNL && drop >= IN_RANGE_MIN_DROP && vel >= V; out.where = "in-range"; }
  out.hit = hit;
  out.violent = hit && vel >= 2 * V;

  const key = `${pnl}|${bin}`;
  const isFresh = fresh ?? key !== state.lastKey;
  state.lastKey = key;
  if (!hit) { state.streak = 0; state.hitSince = null; return out; }
  if (state.hitSince == null) state.hitSince = t;
  if (isFresh) state.streak++;
  const confirm = Math.max(1, Number(cfg.crashRegimeConfirm ?? 2));
  const persistS = Math.max(0, Number(cfg.crashRegimeViolentPersistSec ?? 30));
  if (out.violent && persistS > 0 && out.where === "in-range") {
    // A violent in-range move must still be a hit on every valuation for persistS seconds
    // (any valuation without the hit resets hitSince) and on ≥ 2 distinct valuations.
    // The below-range half (log-only by default) keeps the single-valuation shortcut.
    out.persistingFor = (t - state.hitSince) / 1000;
    out.fire = state.streak >= 2 && t - state.hitSince >= persistS * 1000;
    return out;
  }
  out.fire = state.streak >= (out.violent ? 1 : confirm);
  return out;
}

export function formatCrashRegimeReason(r, lower, bin) {
  const where = r.where === "below"
    ? `crash-below (calm regime) ${r.drop} bins at ${r.vel.toFixed(1)} b/min ≥ ${r.V.toFixed(1)}, dist ${lower - bin} ≥ ${r.D}`
    : `in-range rug (calm regime) ${r.drop} bins at ${r.vel.toFixed(1)} b/min ≥ ${r.V.toFixed(1)}`;
  const violent = r.violent ? `, violent (≥2× threshold${r.persistingFor != null ? `, held ${Math.round(r.persistingFor)} s` : ""})` : "";
  return `${where}; pair noise p95 ${r.noise} bins/60s${violent}`;
}
