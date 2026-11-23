// lesson-owner.js — keep operator positions out of the screener's lessons (2026-11-24).
//
// recordPerformance derived a lesson from every closed record, the operator's own positions
// included (5 lessons from 11 operator positions in two days — "PREFER: OpenIndex-SOL-type
// pools … tvl=11K", "FAILED: snowball-SOL … Reason: External close"), and getLessonsForPrompt
// injected them into the SCREENER prompt although the screener never chose those pools and
// their exits were the operator's. From this date:
//   (a) no lesson is derived from an operator record (recordPerformance; the record itself is
//       stored exactly as before and every other consumer is untouched);
//   (b) a lesson ALREADY stored is hidden from the prompt (never deleted or mutated) when it
//       can be tied to operator records only — see operatorDerivedLessonIds.
// New lessons carry `position`, `adopted: false`, `owner: "bot"`, `source_recorded_at`.
//
// Leaf module: imports only owner-tag.js (itself a leaf). Prompt text only — no rule, gate,
// sizing or exit reads anything from here.

import { ownerTag } from "./owner-tag.js";

/** The dedup key pushPerformanceLesson collapses near-identical rules on (one definition). */
export function lessonDedupKey(rule) {
  return String(rule || "").slice(0, 60).toLowerCase();
}

/**
 * Whose position does this perf record describe? ownerTag on the record, with the tracked
 * row's `strategy_source` when the record lacks it: the perf record carries `adopted` but not
 * `strategy_source`, so a bot deploy recovered through the adoption path (adopted = true,
 * strategy_source bot_recovery / bot_deploy_recovered) can only be told apart via the
 * position registry. `resolveTracked(position)` → the tracked row or null (optional).
 */
export function recordOwner(rec, resolveTracked = null) {
  if (!rec) return "bot";
  if (rec.adopted !== true) return "bot";
  let strategySource = rec.strategy_source;
  if (strategySource == null && typeof resolveTracked === "function" && rec.position) {
    try { strategySource = resolveTracked(rec.position)?.strategy_source ?? null; } catch { strategySource = null; }
  }
  return ownerTag({ adopted: true, strategy_source: strategySource }).owner;
}

/** Source fields stamped on a lesson derived from a (bot) record. */
export function lessonSourceFields(rec, owner = "bot") {
  return {
    position: rec?.position ?? null,
    adopted: owner === "manual",
    owner,
    source_recorded_at: rec?.recorded_at ?? null,
  };
}

/**
 * Ids of stored lessons that were derived from operator records only. Conservative by design
 * — a lesson is hidden only when ALL of:
 *   - sourceType "performance", not pinned (manual / config / evolution / pinned never filtered);
 *   - it carries `owner` → hidden iff owner is "manual" (lessons written from 2026-11-24 on);
 *   - otherwise (older lessons carry no position address): re-deriving the rule from every
 *     stored perf record (`deriveRule(rec)` → rule string or null, i.e. lessons.derivLesson)
 *     finds records whose rule has this lesson's dedup key, there are at least as many of
 *     them as the lesson's `seen_count` (each derivation created or bumped it once), and every
 *     one is an operator record (recordOwner). A record changed since (correction scripts,
 *     classifyOutcome changes) no longer re-derives the same rule; the count then falls short
 *     and the lesson stays visible.
 */
export function operatorDerivedLessonIds(lessons, performance, { deriveRule, resolveTracked = null } = {}) {
  const hidden = new Set();
  const candidates = (Array.isArray(lessons) ? lessons : []).filter((l) => l && l.sourceType === "performance" && !l.pinned);
  if (candidates.length === 0) return hidden;
  const legacy = [];
  for (const l of candidates) {
    if (l.owner != null) { if (l.owner === "manual") hidden.add(l.id); continue; }
    legacy.push(l);
  }
  if (legacy.length === 0 || typeof deriveRule !== "function") return hidden;
  const wanted = new Set(legacy.map((l) => lessonDedupKey(l.rule)));
  const byKey = new Map(); // key → { total, operator }
  for (const rec of Array.isArray(performance) ? performance : []) {
    let rule = null;
    try { rule = deriveRule(rec); } catch { rule = null; }
    if (!rule) continue;
    const k = lessonDedupKey(rule);
    if (!wanted.has(k)) continue;
    const e = byKey.get(k) || { total: 0, operator: 0 };
    e.total += 1;
    if (recordOwner(rec, resolveTracked) === "manual") e.operator += 1;
    byKey.set(k, e);
  }
  for (const l of legacy) {
    const e = byKey.get(lessonDedupKey(l.rule));
    const seen = Math.max(1, Number(l.seen_count) || 1);
    if (e && e.total >= seen && e.operator === e.total) hidden.add(l.id);
  }
  return hidden;
}
