/**
 * Developer Wallet Reputation Scoring — Tier 1
 *
 * Scores a token developer's wallet reputation using fields already
 * present in the GMGN token-info API response. No additional API calls.
 *
 * Five scoring components (0-100 total):
 *   launch_history  (25) — graduated token count (focused > serial)
 *   ath_record      (30) — best-ever ATH market cap
 *   alignment       (20) — creator hold vs sell status
 *   cto             (10) — community-takeover flag
 *   freshness       (15) — fresh wallet bonus (low count = no rug history)
 *
 * Missing data falls back to neutral midpoints — never penalize for
 * absent information (same pattern as intel-score.js).
 */

import { log } from "./logger.js";

// ─── Cache ───────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** @type {Map<string, { ts: number, result: object }>} */
const cache = new Map();

/** Flush the entire dev-score cache (useful for tests). */
export function clearDevScoreCache() {
  cache.clear();
}

// ─── Grade Helper ────────────────────────────────────────────────

const GRADE_THRESHOLDS = [
  { min: 80, grade: "A" },
  { min: 65, grade: "B" },
  { min: 50, grade: "C" },
  { min: 35, grade: "D" },
];

/**
 * Map a numeric score to a letter grade.
 * @param {number} score  0-100
 * @returns {string}
 */
export function getDevScoreGrade(score) {
  for (const { min, grade } of GRADE_THRESHOLDS) {
    if (score >= min) return grade;
  }
  return "F";
}

// ─── Scoring Internals ──────────────────────────────────────────

/**
 * Safe numeric parse with fallback.
 * @param {*} val
 * @param {number|null} fallback
 * @returns {number|null}
 */
function num(val, fallback = null) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Pure scoring function — computes a 0-100 dev reputation score from
 * a GMGN dev/creator data object.
 *
 * @param {object} devData - The `dev` object from GMGN token info
 * @returns {{ total: number, components: object }}
 */
export function computeDevScoreFromTokenInfo(devData) {
  const components = {};

  // ── Launch History (max 25) ──
  // Focused devs (1-3 graduated tokens) score highest.
  const openCount = num(devData.creator_open_count);
  if (openCount === null || openCount === 0) {
    components.launch_history = 15; // neutral — first-time dev
  } else if (openCount <= 3) {
    components.launch_history = 25; // focused
  } else if (openCount <= 10) {
    components.launch_history = 15;
  } else if (openCount <= 30) {
    components.launch_history = 8;
  } else {
    components.launch_history = 0; // serial deployer
  }

  // ── ATH Track Record (max 30) ──
  const athMc = num(devData.ath_token_info?.ath_mc);
  if (athMc === null || athMc === 0) {
    components.ath_record = 12; // neutral
  } else if (athMc > 1_000_000) {
    components.ath_record = 30;
  } else if (athMc > 500_000) {
    components.ath_record = 25;
  } else if (athMc > 100_000) {
    components.ath_record = 18;
  } else if (athMc > 10_000) {
    components.ath_record = 10;
  } else {
    components.ath_record = 5; // >0 but ≤10K
  }

  // ── Creator Alignment (max 20) ──
  const status = (devData.creator_token_status ?? "").toLowerCase();
  if (!status) {
    components.alignment = 10; // neutral
  } else if (status.includes("hold")) {
    components.alignment = 20;
  } else if (status.includes("sell") || status.includes("close")) {
    components.alignment = 5;
  } else {
    components.alignment = 10; // unknown status → neutral
  }

  // ── CTO Flag (max 10) ──
  // Community-takeover means original dev left — higher risk.
  components.cto = devData.cto_flag ? 5 : 10;

  // ── Fresh Wallet Bonus (max 15) ──
  const cnt = num(devData.creator_open_count);
  if (cnt === null || cnt <= 1) {
    components.freshness = 15; // no rug history
  } else if (cnt <= 5) {
    components.freshness = 12;
  } else if (cnt <= 15) {
    components.freshness = 8;
  } else {
    components.freshness = 3;
  }

  const total = Math.round(
    (components.launch_history +
      components.ath_record +
      components.alignment +
      components.cto +
      components.freshness) * 10,
  ) / 10;

  return { total, components };
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * Compute a developer wallet reputation score for a pool candidate.
 *
 * Handles two shapes of `candidate.dev`:
 *   - string (just the creator address) → return neutral 50
 *   - object with GMGN sub-fields      → full scoring via computeDevScoreFromTokenInfo
 *
 * Results are cached in-memory by creator_address with a 1-hour TTL.
 *
 * @param {object} candidate - Screening candidate with a `.dev` field
 * @returns {{ total: number, components: object }}
 */
export function computeDevScore(candidate) {
  const dev = candidate?.dev;
  if (!dev) {
    log("dev_score", "No dev data on candidate — returning neutral 50");
    return {
      total: 50,
      components: {
        launch_history: 15, ath_record: 12, alignment: 10, cto: 5, freshness: 15,
      },
    };
  }

  // Plain address string — no metadata available for scoring.
  if (typeof dev === "string") {
    return {
      total: 50,
      components: {
        launch_history: 15, ath_record: 12, alignment: 10, cto: 5, freshness: 15,
      },
    };
  }

  // Object with GMGN dev fields — check cache first.
  const addr = dev.creator_address ?? "unknown";
  const cached = cache.get(addr);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  const result = computeDevScoreFromTokenInfo(dev);
  cache.set(addr, { ts: Date.now(), result });

  log("dev_score", `${addr.slice(0, 8)}… → ${result.total}/100 (${getDevScoreGrade(result.total)})`);
  return result;
}
