process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// 2026-11-25: display only. The dashboard card marks an unverified PnL reading (JIMMY-SOL read
// 315 % for four minutes after an operator top-up, true value ~20 %); it only knew from the
// ~3-min report doc, so the mark lagged the number. The 2 s tick now carries the flag.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }), text: async () => "" });
const N = await import("../net-cost.js");

test("an unverified reading carries the flag, quality, reason and Meteora's figure", () => {
  const f = N.tickPnlReadinessFields({
    pnl_management_ready: false, pnl_quality: "extreme_divergence",
    pnl_quality_reason: "reported/derived PnL differs by 294.81pp", pnl_pct_reported: 20.4, pnl_pct: 315.2,
  });
  assert.deepEqual(f, { pnl_management_ready: false, pnl_quality: "extreme_divergence", pnl_quality_reason: "reported/derived PnL differs by 294.81pp", pnl_pct_reported: 20.4 });
});

test("a verified reading carries only the boolean; an unknown one carries nothing", () => {
  assert.deepEqual(N.tickPnlReadinessFields({ pnl_management_ready: true, pnl_quality: "valid" }), { pnl_management_ready: true });
  assert.deepEqual(N.tickPnlReadinessFields({}), {});
  assert.deepEqual(N.tickPnlReadinessFields(null), {});
  assert.deepEqual(N.tickPnlReadinessFields({ pnl_management_ready: null }), {});
});

test("missing detail fields become null, long reasons are capped", () => {
  const f = N.tickPnlReadinessFields({ pnl_management_ready: false, pnl_quality_reason: "x".repeat(500) });
  assert.equal(f.pnl_management_ready, false);
  assert.equal(f.pnl_quality, null);
  assert.equal(f.pnl_pct_reported, null);
  assert.equal(f.pnl_quality_reason.length, 120);
});

test("the tick spreads it, and the smallest tier keeps the boolean", () => {
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /\.\.\.tickPnlReadinessFields\(p\),/);
  assert.match(idx, /positions\.map\(\(p\) => \(\{ position: p\.position, pnl_pct: p\.pnl_pct, active_bin: p\.active_bin, pnl_management_ready: p\.pnl_management_ready \}\)\)/);
});
