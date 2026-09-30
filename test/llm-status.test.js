process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const S = await import("../llm-status.js");
const sent = [];
S.setLlmStatusNotifier((html) => { sent.push(html); });
beforeEach(() => { sent.length = 0; S.resetLlmStatus(); });

const OPUS = "claude-cli/claude-opus-5-5";
const SONNET = "claude-cli/claude-sonnet-5-5";
const FB = "google/gemini-3.7-flash";
const LOGIN = "Failed to authenticate: OAuth session expired and could not be refreshed";

test("model names read like the operator says them", () => {
  assert.equal(S.shortModelName(OPUS), "Claude Opus 5.5");
  assert.equal(S.shortModelName(SONNET), "Claude Sonnet 5.5");
  assert.equal(S.shortModelName("claude-cli/sonnet"), "Claude Sonnet");
  assert.equal(S.shortModelName(FB), "gemini-3.7-flash");
});

test("before any call the line does not claim a success", () => {
  assert.equal(S.formatLlmStatusLine({ roleModel: SONNET }), "🤖 Claude Sonnet 5.5 · no LLM call since restart");
});

test("healthy calls never notify", () => {
  S.recordClaudeSuccess({ role: "SCREENER", model: OPUS });
  S.recordClaudeSuccess({ role: "MANAGER", model: SONNET });
  assert.equal(sent.length, 0);
  assert.match(S.formatLlmStatusLine({ roleModel: SONNET }), /Claude Sonnet 5\.5 ✓ · last answer just now/);
});

test("a rejected login alerts once with the fix, cooldown rejects stay silent, recovery alerts once", () => {
  const until = Date.now() + 15 * 60_000;
  S.recordClaudeFailure({ role: "SCREENER", model: OPUS, error: new Error(LOGIN), fallbackModel: FB, cooldown: { until, reason: "login" } });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Claude unavailable<\/b> — login rejected/);
  assert.match(sent[0], /claude setup-token/);
  S.recordProviderSuccess({ role: "SCREENER", model: FB, viaFallback: true });
  S.recordClaudeFailure({ role: "MANAGER", model: SONNET, error: new Error("Claude CLI unavailable (rate limit or login) — retry in ~14m. Falling back."), fallbackModel: FB, cooldown: { until, reason: "login" } });
  S.recordProviderSuccess({ role: "MANAGER", model: FB, viaFallback: true });
  assert.equal(sent.length, 1, "no alert per call during the outage");
  assert.match(S.formatLlmStatusLine(), /fallback <code>gemini-3\.7-flash<\/code> — Claude login rejected · retry/);
  S.recordClaudeSuccess({ role: "SCREENER", model: OPUS });
  assert.equal(sent.length, 2);
  assert.match(sent[1], /Claude back<\/b> — <code>Claude Opus 5\.5<\/code>/);
  assert.match(sent[1], /2 step\(s\) answered by the fallback/);
});

test("rate limit alerts with the reset time", () => {
  S.recordClaudeFailure({ role: "SCREENER", model: OPUS, error: new Error("You've hit your limit · resets 10pm"), fallbackModel: FB, cooldown: { until: Date.now() + 3_600_000, reason: "rate_limit" } });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Claude rate-limited<\/b> until/);
});

test("single CLI errors are tolerated; the third in a row alerts", () => {
  for (let i = 0; i < 2; i++) S.recordClaudeFailure({ role: "MANAGER", model: SONNET, error: new Error("Claude CLI timed out after 240s"), fallbackModel: FB });
  assert.equal(sent.length, 0);
  S.recordClaudeSuccess({ role: "MANAGER", model: SONNET });
  for (let i = 0; i < 2; i++) S.recordClaudeFailure({ role: "MANAGER", model: SONNET, error: new Error("Claude CLI timed out after 240s"), fallbackModel: FB });
  assert.equal(sent.length, 0, "a success resets the streak");
  S.recordClaudeFailure({ role: "MANAGER", model: SONNET, error: new Error("Claude CLI timed out after 240s"), fallbackModel: FB });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Claude CLI failing<\/b> — 3 errors in a row/);
});

test("fallback failure is 'LLM down' once, and its recovery is reported", () => {
  S.recordClaudeFailure({ role: "SCREENER", model: OPUS, error: new Error(LOGIN), fallbackModel: FB, cooldown: { until: Date.now() + 900_000, reason: "login" } });
  S.recordProviderFailure({ role: "SCREENER", model: FB, error: new Error("402 Insufficient credits") });
  S.recordProviderFailure({ role: "MANAGER", model: FB, error: new Error("402 Insufficient credits") });
  assert.equal(sent.length, 2);
  assert.match(sent[1], /LLM down<\/b> — SCREENER step failed on <code>gemini-3\.7-flash<\/code>/);
  assert.match(sent[1], /mechanical exits/);
  assert.match(S.formatLlmStatusLine(), /LLM down<\/b> since/);
  S.recordProviderSuccess({ role: "SCREENER", model: FB, viaFallback: true });
  assert.equal(sent.length, 3);
  assert.match(sent[2], /LLM answering again<\/b> via <code>gemini-3\.7-flash<\/code>\n• Still on the fallback/);
  assert.equal(S.getLlmStatus().state, "degraded");
});

test("/llm report lists the role models and the last answer", () => {
  S.recordClaudeSuccess({ role: "SCREENER", model: OPUS });
  const r = S.formatLlmStatusReport({ screeningModel: OPUS, managementModel: SONNET, generalModel: SONNET, claudeCliFallbackModel: FB });
  assert.match(r, /LLM: Claude answering/);
  assert.match(r, /Screening: <code>claude-cli\/claude-opus-5-5<\/code>/);
  assert.match(r, /Last answer: SCREENER · <code>Claude Opus 5\.5<\/code>/);
});

test("wiring: agent loop records every outcome; bubbles and /llm render the status", () => {
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8");
  assert.match(agent, /recordClaudeSuccess\(\{ role: agentType, model: usedModel \}\)/);
  assert.match(agent, /recordClaudeFailure\(\{ role: agentType, model: usedModel, error: cliErr, fallbackModel: fb, cooldown: getClaudeCliCooldown\(\) \}\)/);
  assert.match(agent, /recordProviderSuccess\(\{ role: agentType, model: usedModel, viaFallback: usedModel !== activeModel \}\)/);
  assert.match(agent, /recordProviderFailure\(\{ role: agentType, model: usedModel, error \}\);\n\s+throw error;/);
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /formatLlmStatusLine\(\{ roleModel: config\.llm\.managementModel \}\)/);
  assert.match(idx, /formatLlmStatusLine\(\{ roleModel: config\.llm\.screeningModel \}\)/);
  assert.match(idx, /if \(text === "\/llm"\)/);
});
