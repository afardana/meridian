import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScreeningFunnel, topFilterReasons } from "../screening-funnel.js";

test("an empty cycle still yields a complete funnel (zero candidates, reasons kept)", () => {
  const f = buildScreeningFunnel({
    totalScanned: 31, candidates: [], passing: [],
    stageCounts: { universe: 31, safety: 19, gates: 0, admitted: 0 },
    allFiltered: [{ name: "A-SOL", reason: "TVL $64531 below minTvl $100000" }, { name: "B-SOL", reason: "TVL drain: -36%" }, { name: "C-SOL", reason: "TVL drain: -92%" }],
    now: Date.parse("2026-10-06T06:51:03Z"),
  });
  assert.equal(f.ts, "2026-10-06T06:51:03.000Z");
  assert.equal(f.total_scanned, 31);
  assert.equal(f.candidates_found, 0);
  assert.equal(f.passing_count, 0);
  assert.equal(f.llm_evaluated, 0);
  assert.equal(f.deployed, 0);
  assert.deepEqual(f.candidate_names, []);
  assert.equal(f.top_reasons[0].reason, "TVL drain");
  assert.equal(f.top_reasons[0].count, 2);
});

test("token names: -SOL suffix dropped, de-duplicated, capped; deployed name set", () => {
  const cands = [{ name: "HIGGS-SOL" }, { pool: { name: "CRAWL-SOL" } }, { name: "HIGGS-SOL" }, "swordcat-SOL"];
  const f = buildScreeningFunnel({ totalScanned: 28, candidates: cands, passing: cands.slice(0, 2), reachedLlm: true, deployedName: "CRAWL-SOL" });
  assert.deepEqual(f.candidate_names, ["HIGGS", "CRAWL", "swordcat"]);
  assert.deepEqual(f.passing_names, ["HIGGS", "CRAWL"]);
  assert.equal(f.llm_evaluated, 2);
  assert.equal(f.deployed, 1);
  assert.equal(f.deployed_name, "CRAWL");
  assert.equal(buildScreeningFunnel({ candidates: Array.from({ length: 9 }, (_, i) => ({ name: `T${i}-SOL` })) }).candidate_names.length, 6);
});

test("reasons are grouped by the text before ':' or '('", () => {
  assert.deepEqual(topFilterReasons([{ reason: "pump gate: 24h +120%" }, { reason: "pump gate: 24h +300%" }, { reason: "pool cooldown active (2h)" }]), [{ reason: "pump gate", count: 2 }, { reason: "pool cooldown active", count: 1 }]);
});
