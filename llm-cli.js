// ─────────────────────────────────────────────────────────────────────────────
//  Claude Code CLI (`claude -p`) backend for Meridian's LLM layer.
//
//  Lets the operator's Claude subscription (OAuth via `claude setup-token`) power
//  reasoning instead of per-token OpenRouter, selected PER ROLE by prefixing the
//  role's model string with `claude-cli/` (e.g. screeningModel: "claude-cli/opus").
//  The suffix after the slash is passed to `claude --model` verbatim (aliases
//  opus/sonnet/haiku or full model ids both work — we do not validate it).
//
//  This module owns only the subprocess + protocol plumbing (spawn, JSON-envelope
//  parsing, rate-limit cooldown, the JSON-action protocol helpers). The agent loop
//  in agent.js composes these into a completion that normalizes to the SAME
//  OpenAI-style message shape the rest of the loop consumes, so tool dispatch, the
//  bear-debate gate, WRITE_TOOLS checks, deployVerdict capture, and noToolFallback
//  handling all work unchanged.
//
//  Pattern reference (adapted, not blind-copied — everything re-verified): the
//  fciaf420/meridian fork's llm-provider.js `runClaudeCli`/`parseRateLimitReset`
//  and fork-agent.js JSON-action transcript builder. Our agent.js diverged heavily
//  (per-role models, bear-debate seam, noToolFallback), so this is implemented
//  against OUR code with the fork only as a template.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, spawnSync } from "child_process";
import { existsSync } from "fs";
import os from "os";
import path from "path";
import { log } from "./logger.js";

const CLI_PREFIX = "claude-cli/";
const DEFAULT_TIMEOUT_MS = 240000;
// Conservative cooldown when we hit a limit but can't parse a reliable reset time.
// Better to over-wait than to under-wait and re-trip the limit.
const RATE_LIMIT_FALLBACK_MS = 3600_000; // 1 hour

// Per-role reasoning effort. Judgment-heavy roles get more; the frequent, cheap
// MANAGER cycle stays low. Bear-debate / one-shot calls are not routed here.
export const CLAUDE_EFFORT_BY_ROLE = {
  SCREENER: "medium",
  MANAGER: "low",
  GENERAL: "medium",
};

// ── Model selection ──────────────────────────────────────────────────────────

export function isClaudeCliModel(model) {
  return typeof model === "string" && model.startsWith(CLI_PREFIX);
}

// The part after `claude-cli/` → passed to `claude --model` verbatim. Idempotent:
// a bare suffix (no prefix) is returned unchanged.
export function claudeCliModelSuffix(model) {
  if (typeof model !== "string") return "";
  return model.startsWith(CLI_PREFIX) ? model.slice(CLI_PREFIX.length).trim() : model.trim();
}

// ── Rate-limit cooldown ──────────────────────────────────────────────────────

let _rateLimitedUntil = 0;

export function isClaudeCliRateLimited() {
  return Date.now() < _rateLimitedUntil;
}

// Given an IANA time zone, return that zone's UTC offset in minutes at instant
// `at` (e.g. America/New_York during EDT → -240). null if the zone is unknown.
function getZoneOffsetMinutes(timeZone, at) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(at).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    // Interpret the wall-clock components the zone reports as if they were UTC,
    // then compare to the real UTC instant to recover the offset.
    const asUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second),
    );
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    return null;
  }
}

// Parse a Claude rate-limit message into an absolute reset timestamp (ms).
// Adapted from the fork's parseRateLimitReset; math re-derived and verified:
//   • relative form ("resets in 45 minutes / 2 hours") — timezone-independent.
//   • absolute+zone ("resets 10pm (America/New_York)") — resolve the zone's
//     offset at `now`, build the target wall-clock in that zone, convert to UTC.
//   • no trustworthy zone → conservative fixed cooldown (never under-wait).
export function parseRateLimitReset(msg, now = Date.now()) {
  const text = typeof msg === "string" ? msg : "";

  // Prefer an explicit relative form — unambiguous, no timezone needed.
  const relMatch = text.match(/resets?\s+in\s+(\d+)\s*(second|minute|hour|day)s?/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unitMs = { second: 1000, minute: 60_000, hour: 3600_000, day: 86_400_000 }[relMatch[2].toLowerCase()];
    return now + amount * unitMs;
  }

  const match = text.match(/resets?\s+(?:at\s+)?(\d{1,2})\s*(am|pm)/i);
  if (!match) return now + RATE_LIMIT_FALLBACK_MS;

  let hour = parseInt(match[1], 10);
  if (match[2].toLowerCase() === "pm" && hour < 12) hour += 12;
  if (match[2].toLowerCase() === "am" && hour === 12) hour = 0;

  // Resolve the zone from the message rather than assuming the host runs in ET.
  const zoneMatch = text.match(/\(([A-Za-z]+\/[A-Za-z_]+)\)/);
  const timeZone = zoneMatch?.[1];
  if (!timeZone) return now + RATE_LIMIT_FALLBACK_MS; // no zone we can trust

  const offsetMin = getZoneOffsetMinutes(timeZone, new Date(now));
  if (offsetMin === null) return now + RATE_LIMIT_FALLBACK_MS;

  // Today's date IN the target zone.
  const zoneNow = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(now)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});

  // The zone wall-clock (today @ hour:00) expressed as a real UTC instant:
  //   realUTC = wallclock-as-UTC − offset.  (EDT offset −240 → +4h → 10pm ET = 2am UTC.)
  let targetUtc = Date.UTC(
    Number(zoneNow.year), Number(zoneNow.month) - 1, Number(zoneNow.day), hour, 0, 0,
  ) - offsetMin * 60_000;

  if (targetUtc <= now) targetUtc += 86_400_000; // already past → tomorrow
  return targetUtc;
}

function looksRateLimited(text) {
  return /hit your limit/i.test(text) || /\bresets?\b/i.test(text);
}

// ── Subprocess launch ────────────────────────────────────────────────────────

function findExecutableOnPath(binName) {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [binName], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || null;
}

// PM2 spawns children with a stripped-down environment (no interactive shell
// PATH), so a bare `spawn("claude", …)` ENOENTs in production even though the
// CLI is installed at ~/.local/bin/claude. Resolve once per process, in order:
//   1. CLAUDE_CLI_PATH env var (explicit override) — if set and the file exists
//   2. bare "claude" if `which claude` finds it (dev shells with a correct PATH)
//   3. ~/.local/bin/claude — the standard Claude Code install location
//   4. ~/.claude/local/claude — alternate install location
//   5. null — caller must reject rather than spawn a binary that will ENOENT
let _resolvedClaudeBinary; // undefined = not yet resolved this process (cache)

function resolveClaudeBinary() {
  if (_resolvedClaudeBinary !== undefined) return _resolvedClaudeBinary;

  const envPath = process.env.CLAUDE_CLI_PATH?.trim();
  if (envPath && existsSync(envPath)) {
    _resolvedClaudeBinary = envPath;
    return _resolvedClaudeBinary;
  }

  if (findExecutableOnPath("claude")) {
    _resolvedClaudeBinary = "claude";
    return _resolvedClaudeBinary;
  }

  const localBin = path.join(os.homedir(), ".local/bin/claude");
  if (existsSync(localBin)) {
    _resolvedClaudeBinary = localBin;
    return _resolvedClaudeBinary;
  }

  const altLocal = path.join(os.homedir(), ".claude/local/claude");
  if (existsSync(altLocal)) {
    _resolvedClaudeBinary = altLocal;
    return _resolvedClaudeBinary;
  }

  _resolvedClaudeBinary = null;
  return _resolvedClaudeBinary;
}

function resolveClaudeLaunch() {
  const configured = process.env.CLAUDE_PATH?.trim();
  if (configured) {
    if (process.platform === "win32") {
      if (/\.exe$/i.test(configured)) return { command: configured, viaCmd: false };
      const siblingExe = configured.replace(/\.(cmd|bat|ps1)$/i, ".exe");
      if (siblingExe !== configured && existsSync(siblingExe)) return { command: siblingExe, viaCmd: false };
      const claudeExe = findExecutableOnPath("claude.exe");
      if (claudeExe) return { command: claudeExe, viaCmd: false };
      if (/\.(cmd|bat)$/i.test(configured)) return { command: configured, viaCmd: true };
    }
    return { command: configured, viaCmd: false };
  }

  if (process.platform === "win32") {
    const claudeExe = findExecutableOnPath("claude.exe");
    if (claudeExe) return { command: claudeExe, viaCmd: false };
    const claudeAny = findExecutableOnPath("claude");
    if (claudeAny && /\.exe$/i.test(claudeAny)) return { command: claudeAny, viaCmd: false };
    const claudeCmd = findExecutableOnPath("claude.cmd");
    if (claudeCmd) {
      const siblingExe = claudeCmd.replace(/\.cmd$/i, ".exe");
      if (siblingExe !== claudeCmd && existsSync(siblingExe)) return { command: siblingExe, viaCmd: false };
      return { command: claudeCmd, viaCmd: true };
    }
  }

  // command may be null here (see resolveClaudeBinary) — runClaudeCli checks
  // for that before spawning rather than letting it ENOENT.
  return { command: resolveClaudeBinary(), viaCmd: false };
}

function killChildProcess(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); return; } catch { /* fall through */ }
  }
  try { child.kill("SIGKILL"); } catch { /* best effort */ }
}

// Cache: some `claude` builds reject `--effort`. Detected once at runtime, then
// omitted for the rest of the process so we don't burn a spawn per call.
let _effortUnsupported = false;

// One-time observability: log which resolved binary path is actually in use,
// the first time a spawn succeeds — cheap confirmation in prod logs that the
// PM2-PATH-gap workaround (resolveClaudeBinary) picked the right binary.
let _loggedClaudeBinaryUse = false;

/**
 * Run one `claude -p` completion. Returns the raw result text (string).
 *
 * @param {string} model  claude-cli/… or bare suffix (prefix stripped internally).
 * @param {string} prompt the dynamic part of the request (goes to stdin AFTER systemPrompt).
 * @param {object} opts   { systemPrompt, timeoutMs, effort }
 *
 * Prefix caching: `claude -p` caches the prefix of stdin within its TTL, so the
 * STABLE systemPrompt is prepended (with two newlines) and the volatile prompt
 * follows — stable-first maximizes cache hits.
 *
 * Rejects immediately (no spawn) while rate-limited so the caller's fallback path
 * engages without burning a subprocess.
 */
export function runClaudeCli(model, prompt, { systemPrompt = null, timeoutMs = DEFAULT_TIMEOUT_MS, effort = null } = {}) {
  if (isClaudeCliRateLimited()) {
    const mins = Math.ceil((_rateLimitedUntil - Date.now()) / 60000);
    return Promise.reject(new Error(`Claude CLI rate limited — resets in ~${mins}m. Falling back.`));
  }

  const suffix = claudeCliModelSuffix(model);
  const useEffort = effort && !_effortUnsupported;

  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const { command, viaCmd } = resolveClaudeLaunch();
    if (!command) {
      reject(new Error("claude binary not found on PATH, ~/.local/bin, or CLAUDE_CLI_PATH — install Claude Code or set CLAUDE_CLI_PATH"));
      return;
    }
    const args = ["-p", "--output-format", "json", "--model", suffix, "--no-session-persistence"];
    if (useEffort) args.push("--effort", effort);

    const spawnCommand = viaCmd ? (process.env.ComSpec || "cmd.exe") : command;
    const spawnArgs = viaCmd ? ["/d", "/c", command, ...args] : args;

    let child;
    try {
      child = spawn(spawnCommand, spawnArgs, { env: { ...process.env }, windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    if (!_loggedClaudeBinaryUse) {
      _loggedClaudeBinaryUse = true;
      log("claude_cli", `using binary at ${command}`);
    }

    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    child.stdin.on("error", () => { /* swallow EPIPE if the child died early */ });
    child.stdin.end(fullPrompt, "utf8");

    let killed = false;
    let graceTimer = null;
    const killTimer = setTimeout(() => {
      killed = true;
      // SIGTERM first, then SIGKILL after a short grace.
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      graceTimer = setTimeout(() => killChildProcess(child), 1500);
      reject(new Error(`Claude CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on("data", (d) => stdoutChunks.push(d.toString()));
    child.stderr.on("data", (d) => stderrChunks.push(d.toString()));

    child.on("error", (err) => {
      clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (!killed) reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (killed) return;

      const output = stdoutChunks.join("").trim();
      const stderr = stderrChunks.join("").trim();

      // Feature-detect --effort rejection: retry ONCE without it, then cache off.
      if (code !== 0 && useEffort && /unknown option|unrecognized option|--effort/i.test(stderr)) {
        _effortUnsupported = true;
        log("claude", "`--effort` rejected by this claude build — retrying without it (cached)");
        runClaudeCli(model, prompt, { systemPrompt, timeoutMs, effort: null }).then(resolve, reject);
        return;
      }

      // The envelope is emitted on stdout EVEN on non-zero exit (verified: an
      // is_error result exits 1 but still prints the JSON). Parse stdout first,
      // regardless of exit code, so we surface the structured error/result.
      let parsed = null;
      if (output) { try { parsed = JSON.parse(output); } catch { parsed = null; } }

      if (parsed && typeof parsed === "object") {
        if (parsed.is_error) {
          const errText = typeof parsed.result === "string" ? parsed.result : JSON.stringify(parsed).slice(0, 300);
          if (looksRateLimited(errText)) {
            _rateLimitedUntil = parseRateLimitReset(errText);
            const mins = Math.ceil((_rateLimitedUntil - Date.now()) / 60000);
            log("claude", `Rate limited — cooldown set for ~${mins} minutes`);
          }
          reject(new Error(errText || "Claude CLI returned an error"));
          return;
        }
        if (parsed.type === "result") {
          resolve(typeof parsed.result === "string" ? parsed.result.trim() : "");
          return;
        }
        reject(new Error(`Unexpected Claude CLI response: ${JSON.stringify(parsed).slice(0, 300)}`));
        return;
      }

      // No parseable envelope.
      if (code !== 0) {
        if (looksRateLimited(stderr)) {
          _rateLimitedUntil = parseRateLimitReset(stderr);
        }
        reject(new Error(stderr || output || `Claude CLI exited with code ${code}`));
        return;
      }
      reject(new Error(stderr || "Claude CLI returned unparseable output"));
    });
  });
}

// ── JSON-action protocol ─────────────────────────────────────────────────────
//
// The CLI is instructed to reply with ONE raw JSON object, exactly one of:
//   {"action":"respond","content":"<final answer>"}
//   {"action":"tool","name":"<tool_name>","arguments":{ … }}
// A single tool call per turn is fine — our loop handles sequential calls.

const _sysPromptCache = {};

// Compact render of the role-filtered tool set for the prompt.
function renderTools(toolSummaries) {
  return toolSummaries.map((t) => {
    const params = t.parameters || { type: "object", properties: {} };
    return `- ${t.name}: ${t.description || ""}\n  params: ${JSON.stringify(params)}`;
  }).join("\n");
}

export function buildClaudeSystemPrompt(agentType, toolSummaries) {
  const cacheKey = agentType + ":" + toolSummaries.map((t) => t.name).join(",");
  if (_sysPromptCache[cacheKey]) return _sysPromptCache[cacheKey];
  const prompt = [
    `You are the ${agentType} reasoning engine for an autonomous Solana DLMM liquidity agent.`,
    "The real agent instructions, portfolio state, and lessons appear in the SYSTEM section of the transcript below — follow them.",
    "Respond with RAW JSON only. Do not wrap it in markdown fences, and add no commentary before or after.",
    "Choose exactly ONE of these two action shapes:",
    '  {"action":"respond","content":"<your final answer to the user>"}',
    '  {"action":"tool","name":"<tool_name>","arguments":{ <valid JSON args> }}',
    'Use "tool" when you need a listed tool to continue; the runner executes it and returns the result on the next turn (one tool call per turn).',
    'Use "respond" only when you can fully answer with the information already available.',
    "Never invent tool outputs, transaction results, or on-chain state.",
    "Only use tool names from the AVAILABLE TOOLS list. Be conservative with write tools (deploy/close/claim/swap/update_config) — call them only when you intentionally want the real action performed.",
    ...(agentType === "SCREENER" ? [
      'If your decision is NOT to deploy, use action "respond" and your content MUST begin with exactly \'NO DEPLOY:\' followed by one short paragraph of reasoning. Never claim to have deployed or executed anything without using the tool action.',
    ] : []),
    `AVAILABLE TOOLS:\n${renderTools(toolSummaries)}`,
  ].join("\n\n");
  _sysPromptCache[cacheKey] = prompt;
  return prompt;
}

function formatMessageContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "string" ? part : (part?.text ?? JSON.stringify(part)))).join("\n");
  }
  return JSON.stringify(content, null, 2);
}

function safeParseJson(raw, fallback = {}) {
  if (!raw || typeof raw !== "string") return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function findToolNameForResult(messages, index, toolCallId) {
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
    const match = m.tool_calls.find((tc) => tc.id === toolCallId);
    if (match?.function?.name) return match.function.name;
  }
  return null;
}

// Flatten the OpenAI-style messages array into a plain-text transcript the CLI
// can read. Adapted from the fork's buildCodexTranscript.
export function buildTranscript(messages) {
  return messages.map((message, index) => {
    if (message.role === "system") return `SYSTEM:\n${formatMessageContent(message.content)}`;
    if (message.role === "user") return `USER:\n${formatMessageContent(message.content)}`;
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      const requested = message.tool_calls.map((tc) => ({
        name: tc.function?.name || "unknown_tool",
        arguments: safeParseJson(tc.function?.arguments, {}),
      }));
      const preface = formatMessageContent(message.content);
      return `${preface ? `ASSISTANT:\n${preface}\n\n` : ""}ASSISTANT TOOL REQUESTS:\n${JSON.stringify(requested, null, 2)}`;
    }
    if (message.role === "assistant") return `ASSISTANT:\n${formatMessageContent(message.content)}`;
    if (message.role === "tool") {
      const toolName = findToolNameForResult(messages, index, message.tool_call_id) || "unknown_tool";
      return `TOOL RESULT (${toolName}):\n${formatMessageContent(message.content)}`;
    }
    return `${String(message.role || "unknown").toUpperCase()}:\n${formatMessageContent(message.content)}`;
  }).join("\n\n");
}

function stripFences(s) {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : s.trim();
}

/**
 * Parse the CLI's raw result text into a normalized action.
 * Returns one of:
 *   { kind: "tool",   name, arguments, content }
 *   { kind: "respond", content }
 *   { kind: "text",    content }   ← unparseable / unknown → plain content, so the
 *                                     loop's existing no-tool-call retry applies.
 */
export function parseClaudeAction(rawText) {
  const text = typeof rawText === "string" ? rawText : "";
  const candidate = stripFences(text);

  let obj = null;
  try {
    obj = JSON.parse(candidate);
  } catch {
    const m = candidate.match(/\{[\s\S]*\}/); // defensively extract a JSON object
    if (m) { try { obj = JSON.parse(m[0]); } catch { obj = null; } }
  }

  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    if (obj.action === "tool" && typeof obj.name === "string" && obj.name.trim()) {
      const args = obj.arguments && typeof obj.arguments === "object" && !Array.isArray(obj.arguments) ? obj.arguments : {};
      return { kind: "tool", name: obj.name.trim(), arguments: args, content: typeof obj.content === "string" ? obj.content : null };
    }
    if (obj.action === "respond") {
      const c = typeof obj.content === "string" ? obj.content : (typeof obj.response === "string" ? obj.response : "");
      return { kind: "respond", content: c };
    }
  }

  // Not a recognized action envelope — treat as plain text.
  return { kind: "text", content: text };
}

// Turn a parsed action into an OpenAI-style assistant message. `id` disambiguates
// synthesized tool_call ids across steps (e.g. "cli_1").
export function actionToMessage(parsed, id) {
  if (parsed.kind === "tool") {
    return {
      role: "assistant",
      content: parsed.content ?? null,
      tool_calls: [{
        id: `cli_${id}`,
        type: "function",
        function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments || {}) },
      }],
    };
  }
  return { role: "assistant", content: parsed.content ?? "" };
}
