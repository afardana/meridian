process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// 2026-11-24: no lessons from operator positions (lesson-owner.js). The screener never chose an
// operator position's pool and its exit was the operator's, so (a) recordPerformance derives no
// lesson from such a record (the record is stored as before), and (b) lessons already stored
// that can be tied to operator records only are left out of every prompt (never deleted).

if (!process.env.MERIDIAN_DATA_DIR) process.env.MERIDIAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-owner-"));
const DIR = process.env.MERIDIAN_DATA_DIR;
const LO = await import("../lesson-owner.js");

let seq = 0;
const rec = (over = {}) => ({
  position: `POS_${++seq}`,
  pool: `POOL_${seq}`,
  pool_name: `T${seq}-SOL`,
  strategy: "spot",
  bin_step: 100,
  volatility: 4,
  fee_tvl_ratio: 0.3,
  organic_score: 80,
  amount_sol: 1,
  initial_value_usd: 1,
  fees_earned_usd: 0.03,
  final_value_usd: 0.99,
  minutes_in_range: 90,
  minutes_held: 100,
  close_reason: "Trailing TP: peak 4% → 2.5%",
  entry_tvl: 11_000,
  ...over,
});

// ── pure helpers ─────────────────────────────────────────────────────────────────────
test("recordOwner: adopted = manual, recovered bot deploy stays the bot's (record or registry)", () => {
  assert.equal(LO.recordOwner({ adopted: undefined }), "bot");
  assert.equal(LO.recordOwner({ adopted: false }), "bot");
  assert.equal(LO.recordOwner({ adopted: true }), "manual");
  assert.equal(LO.recordOwner({ adopted: true, strategy_source: "bot_recovery" }), "bot");
  const reg = { P1: { strategy_source: "bot_deploy_recovered" }, P2: { strategy_source: "manual_adoption" } };
  const resolve = (p) => reg[p] ?? null;
  assert.equal(LO.recordOwner({ adopted: true, position: "P1" }, resolve), "bot");
  assert.equal(LO.recordOwner({ adopted: true, position: "P2" }, resolve), "manual");
  assert.equal(LO.recordOwner({ adopted: true, position: "P3" }, resolve), "manual");
  assert.equal(LO.recordOwner({ adopted: true, position: "P1" }, () => { throw new Error("x"); }), "manual", "a failing registry falls back to the record");
});

test("operatorDerivedLessonIds: conservative match on re-derived rules", () => {
  const deriveRule = (r) => r.rule ?? null;
  const perf = [
    { position: "a", adopted: true, rule: "FAILED: snowball-SOL, strategy=spot …" },
    { position: "b", adopted: true, rule: "PREFER: OpenIndex-SOL-type pools …" },
    { position: "c", adopted: true, rule: "PREFER: OpenIndex-SOL-type pools …" },
    { position: "d", adopted: true, rule: "WORKED: MIX-SOL, strategy=spot …" },
    { position: "e", rule: "WORKED: MIX-SOL, strategy=spot …" },                // a bot record with the same key
    { position: "f", adopted: true, rule: "FAILED: SHORT-SOL, strategy=spot …" },
  ];
  const L = [
    { id: 1, sourceType: "performance", rule: "FAILED: snowball-SOL, strategy=spot …" },                 // 1 operator source → hidden
    { id: 2, sourceType: "performance", rule: "PREFER: OpenIndex-SOL-type pools …", seen_count: 2 },     // 2 operator sources → hidden
    { id: 3, sourceType: "performance", rule: "WORKED: MIX-SOL, strategy=spot …", seen_count: 2 },       // one source is the bot's → kept
    { id: 4, sourceType: "performance", rule: "FAILED: SHORT-SOL, strategy=spot …", seen_count: 3 },     // only 1 of 3 sources re-derives → kept
    { id: 5, sourceType: "performance", rule: "FAILED: snowball-SOL, strategy=spot …", pinned: true },   // pinned → never
    { id: 6, sourceType: "manual", rule: "FAILED: snowball-SOL, strategy=spot …" },                      // manual → never
    { id: 7, sourceType: "performance", rule: "FAILED: NOREC-SOL …" },                                    // no record re-derives → kept
    { id: 8, sourceType: "performance", rule: "anything", owner: "manual" },                             // new-style stamp → hidden
    { id: 9, sourceType: "performance", rule: "FAILED: snowball-SOL, strategy=spot …", owner: "bot" },    // new-style stamp → kept
  ];
  assert.deepEqual([...LO.operatorDerivedLessonIds(L, perf, { deriveRule })].sort(), [1, 2, 8]);
  assert.deepEqual([...LO.operatorDerivedLessonIds(L, perf, {})], [8], "without a deriver only stamped lessons are judged");
  // a recovered bot deploy (registry) is the bot's → its lesson stays
  const resolve = (p) => (p === "a" ? { strategy_source: "bot_recovery" } : null);
  assert.ok(!LO.operatorDerivedLessonIds(L, perf, { deriveRule, resolveTracked: resolve }).has(1));
});

// ── through lessons.js (json store in a temp data dir) ──────────────────────────────
// Seed the store before lessons.js first reads it: legacy lessons (no owner) derived from
// operator records, one from a bot record, a pinned and a manual one.
const L = await import("../lessons.js");
const opRec = rec({ adopted: true, pool_name: "OpenIndex-SOL", pnl_pct: 2.0, range_efficiency: 90 });
const opFail = rec({ adopted: true, pool_name: "snowball-SOL", pnl_pct: -7.5, range_efficiency: 60, close_reason: "External close detected during discovery reconciliation" });
const botRec = rec({ pool_name: "BOTWIN-SOL", pnl_pct: 2.0, range_efficiency: 90 });
const lessonFrom = (r, id, extra = {}) => ({ ...L.derivLesson(r), id, ...extra });
const seeded = {
  lessons: [
    lessonFrom(opRec, 101),
    lessonFrom(opFail, 102),
    lessonFrom(botRec, 103),
    lessonFrom(opFail, 104, { pinned: true }),
    { id: 105, rule: "Operator note: never deploy into snowball-SOL again", tags: [], outcome: "manual", sourceType: "manual", created_at: new Date().toISOString() },
  ],
  performance: [
    { ...opRec, recorded_at: new Date().toISOString() },
    { ...opFail, recorded_at: new Date().toISOString() },
    { ...botRec, recorded_at: new Date().toISOString() },
  ],
};
assert.ok(seeded.lessons.slice(0, 4).every((l) => l.rule), "fixtures derive real lessons");
fs.writeFileSync(path.join(DIR, "lessons.json"), JSON.stringify(seeded, null, 2));

test("stored operator-derived lessons are kept in the store, left out of the prompt, marked in the listing", () => {
  const prompt = L.getLessonsForPrompt({ agentType: "GENERAL" });
  assert.doesNotMatch(prompt, /OpenIndex-SOL-type/, "operator PREFER hidden");
  assert.match(prompt, /BOTWIN-SOL/, "bot lesson kept");
  assert.match(prompt, /📌 .*snowball-SOL/, "pinned lesson never filtered");
  assert.match(prompt, /Operator note: never deploy into snowball-SOL again/, "manual lesson never filtered");
  const unpinnedSnowball = prompt.split("\n").filter((l) => l.includes("snowball-SOL") && !l.includes("📌") && !l.includes("Operator note"));
  assert.equal(unpinnedSnowball.length, 0, "operator FAILED hidden");
  // the store is untouched
  const listed = L.listLessons({ limit: 50, full: true });
  assert.equal(listed.total, 5);
  const byId = Object.fromEntries(listed.lessons.map((l) => [l.id, l]));
  assert.equal(byId[101].operator_derived, true);
  assert.equal(byId[102].operator_derived, true);
  assert.equal(byId[103].operator_derived, undefined);
  assert.equal(byId[104].operator_derived, undefined, "pinned is never marked");
  assert.equal(byId[105].operator_derived, undefined);
  assert.deepEqual([...L.getOperatorDerivedLessonIds()].sort(), [101, 102]);
});

test("recordPerformance: an operator record is stored as before but derives no lesson", async () => {
  const before = L.listLessons({ limit: 500 }).total;
  const perfBefore = L.getAllPerformance().length;
  const op = rec({ adopted: true, pool_name: "MANUALWIN-SOL" });
  await L.recordPerformance(op);
  assert.equal(L.getAllPerformance().length, perfBefore + 1, "the record is stored");
  const stored = L.getAllPerformance().at(-1);
  assert.equal(stored.position, op.position);
  assert.equal(stored.adopted, true);
  assert.equal(stored.pnl_pct, 2, "same derived figures as before");
  assert.equal(stored.range_efficiency, 90);
  assert.equal(L.listLessons({ limit: 500 }).total, before, "no lesson from the operator position");
});

test("recordPerformance: a bot record derives its lesson as before, now with its source", async () => {
  const before = L.listLessons({ limit: 500 }).total;
  const bot = rec({ pool_name: "BOTNEW-SOL" });
  await L.recordPerformance(bot);
  const after = L.listLessons({ limit: 500, full: true });
  assert.equal(after.total, before + 1);
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, "lessons.json"), "utf8")).lessons.at(-1);
  assert.match(raw.rule, /^PREFER: BOTNEW-SOL-type pools/);
  assert.equal(raw.position, bot.position);
  assert.equal(raw.adopted, false);
  assert.equal(raw.owner, "bot");
  assert.equal(typeof raw.source_recorded_at, "string");
  const expected = L.derivLesson({ ...bot, pnl_pct: 2, range_efficiency: 90 });
  assert.equal(raw.rule, expected.rule, "rule text unchanged");
  assert.equal(raw.confidence, expected.confidence);
});

test("recordPerformance: a recovered bot deploy (registry says bot_recovery) still derives a lesson", async () => {
  L.setLessonOwnerResolver((p) => (p === "RECOVERED_1" ? { strategy_source: "bot_recovery" } : null));
  try {
    const before = L.listLessons({ limit: 500 }).total;
    await L.recordPerformance(rec({ position: "RECOVERED_1", adopted: true, pool_name: "RECOV-SOL" }));
    assert.equal(L.listLessons({ limit: 500 }).total, before + 1);
    const raw = JSON.parse(fs.readFileSync(path.join(DIR, "lessons.json"), "utf8")).lessons.at(-1);
    assert.equal(raw.owner, "bot");
    assert.equal(raw.position, "RECOVERED_1");
  } finally {
    L.setLessonOwnerResolver(null);
  }
});

test("briefing marks an operator-derived lesson; other lines unchanged", async () => {
  const { lessonLines } = await import("../briefing.js");
  assert.deepEqual(lessonLines([{ rule: "PREFER: A-SOL-type" }, { rule: "FAILED: B-SOL", operator_derived: true }]), [
    "• PREFER: A-SOL-type",
    "• 🧑 FAILED: B-SOL <i>(operator position — not in prompts)</i>",
  ]);
});
