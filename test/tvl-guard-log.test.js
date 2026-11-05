import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// 2026-11-05: checkTvlDrain called log(message) with the message in the CATEGORY slot, so the
// agent log printed the whole alert upper-cased as the tag with body "undefined"
// ("[🚨 TVL DRAIN DETECTED ON 95DVM15N…: -62.3% FROM PEAK $1505 → $567] undefined").
test("tvl-guard: the drain alert is logged with a category and a message", () => {
  const src = fs.readFileSync(new URL("../tvl-guard.js", import.meta.url), "utf8");
  assert.match(src, /log\("tvl_drain", `🚨 TVL drain detected/);
  assert.doesNotMatch(src, /log\(`🚨 TVL drain/);
});
