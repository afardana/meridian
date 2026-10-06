// screening-funnel.js — the per-cycle funnel summary the dashboard's Screening Funnel card
// renders (report.js publishes it as `screening_funnel`). Pure; one builder for every
// screening outcome so an EMPTY cycle publishes too — it used to return before the funnel
// was recorded, leaving the card on the last cycle that had a candidate (over an hour old
// in a drought).

const baseName = (name) => String(name || "").replace(/-SOL$/i, "").trim();
const names = (list, max = 6) => {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const n = baseName(typeof item === "string" ? item : (item?.pool?.name ?? item?.name));
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
};

/** Top filter reasons as [{ reason, count }], grouped by the text before ":" or "(". */
export function topFilterReasons(allFiltered, max = 10) {
  const counts = {};
  for (const f of Array.isArray(allFiltered) ? allFiltered : []) {
    const reason = String(f?.reason || "filtered").split(/[:(]/)[0].trim();
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
}

/**
 * @param {object} o
 * @param {number} o.totalScanned   pools in the universe this cycle
 * @param {Array}  o.candidates     admitted candidates (objects with .name or .pool.name)
 * @param {Array}  o.passing        candidates that passed the per-pool checks
 * @param {boolean} o.reachedLlm    whether the passing set was handed to the model
 * @param {string|null} o.deployedName pool deployed this cycle, if any
 */
export function buildScreeningFunnel({ totalScanned = 0, candidates = [], passing = [], reachedLlm = false, deployedName = null, stageCounts = null, allFiltered = [], skippedReason = null, now = Date.now() } = {}) {
  const passCount = Array.isArray(passing) ? passing.length : 0;
  return {
    ts: new Date(now).toISOString(),
    total_scanned: Number(totalScanned) || 0,
    candidates_found: Array.isArray(candidates) ? candidates.length : 0,
    passing_count: passCount,
    llm_evaluated: reachedLlm ? passCount : 0,
    deployed: deployedName ? 1 : 0,
    skipped_reason: skippedReason || null,
    stage_counts: stageCounts || null,
    top_reasons: topFilterReasons(allFiltered),
    candidate_names: names(candidates),
    passing_names: names(passing),
    deployed_name: deployedName ? baseName(deployedName) : null,
  };
}
