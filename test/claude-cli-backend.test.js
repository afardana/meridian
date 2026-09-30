process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A stand-in `claude` binary: records its argv and cwd, then answers like the real CLI.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
const record = path.join(dir, "record.json");
const fake = path.join(dir, "claude");
fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
const mode = process.env.FAKE_CLAUDE_MODE;
if (mode === "auth") { console.log(JSON.stringify({ type: "result", is_error: true, result: "Failed to authenticate: OAuth session expired and could not be refreshed" })); process.exit(1); }
console.log(JSON.stringify({ type: "result", is_error: false, result: '{"action":"respond","content":"ok"}' }));
`);
fs.chmodSync(fake, 0o755);
process.env.CLAUDE_CLI_PATH = fake;
process.env.CLAUDE_PATH = fake;

const { runClaudeCli, isClaudeCliRateLimited } = await import("../llm-cli.js");
const { DEFAULT_LLM_MODEL, DEFAULT_LLM_BASE_URL, FALLBACK_LLM_MODEL, normalizeLlmModel } = await import("../config.js");

test("claude -p runs locked down, outside the repo", async () => {
  const out = await runClaudeCli("claude-cli/opus", "hello", { systemPrompt: "SYS", effort: "medium" });
  assert.equal(out, '{"action":"respond","content":"ok"}');
  const { argv, cwd } = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.deepEqual(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2), ["--model", "opus"]);
  assert.deepEqual(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 2), ["--tools", ""], "no built-in tools");
  assert.ok(argv.includes("--strict-mcp-config"), "no MCP servers");
  assert.deepEqual(argv.slice(argv.indexOf("--setting-sources"), argv.indexOf("--setting-sources") + 2), ["--setting-sources", ""]);
  assert.ok(argv.includes("--system-prompt"), "replaces the coding-agent system prompt");
  assert.equal(fs.realpathSync(cwd), fs.realpathSync(path.join(os.tmpdir(), "meridian-claude-cli")), "never the repo (CLAUDE.md auto-discovery)");
});

test("a rejected login backs off instead of spawning on every step", async () => {
  process.env.FAKE_CLAUDE_MODE = "auth";
  await assert.rejects(runClaudeCli("claude-cli/sonnet", "hi"), /Failed to authenticate/);
  assert.equal(isClaudeCliRateLimited(), true);
  fs.rmSync(record);
  await assert.rejects(runClaudeCli("claude-cli/sonnet", "hi"), /unavailable/);
  assert.equal(fs.existsSync(record), false, "no subprocess during the cooldown");
});

test("defaults: Claude CLI primary, OpenRouter fallback, no Ollama", () => {
  assert.equal(DEFAULT_LLM_MODEL, "claude-cli/sonnet");
  assert.equal(DEFAULT_LLM_BASE_URL, "https://openrouter.ai/api/v1");
  assert.equal(FALLBACK_LLM_MODEL, "google/gemini-3.7-flash");
  assert.equal(normalizeLlmModel("glm-5.3-flash"), "claude-cli/sonnet", "retired Ollama id maps to the default");
  const agent = fs.readFileSync(new URL("../agent.js", import.meta.url), "utf8");
  assert.doesNotMatch(agent, /OLLAMA|ollama\.com|reasoning_effort/);
});
