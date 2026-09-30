/**
 * LLM provider status for Telegram (2026-09-30).
 *
 * Every role runs Claude through the Claude Code CLI (llm-cli.js) and drops to
 * the OpenAI-compatible fallback (OpenRouter) when the CLI is rate-limited,
 * logged out or erroring. That switch used to be visible only in the agent log,
 * so a dead login could run the bot on the fallback for days unnoticed. This
 * module keeps a small state machine fed by agent.js and:
 *   - sends ONE Telegram alert per state change (Claude unavailable, Claude
 *     back, LLM down, fallback answering again) — never one per call;
 *   - renders a one-line status for the rolling management/screening messages;
 *   - renders the /llm command reply.
 *
 * States: "ok" (Claude answering), "degraded" (fallback answering),
 * "down" (the last step failed on every model). A single transient CLI error is
 * not a state change; CLI_ERROR_ALERT_STREAK consecutive errors are, as is any
 * rejected login or rate limit (those set a cooldown in llm-cli.js).
 * Never throws into the agent loop.
 */
import { log } from "./logger.js";
import { sendHTML, escapeHTML } from "./telegram.js";

const CLI_PREFIX = "claude-cli/";
const CLI_ERROR_ALERT_STREAK = 3;
// A "down" alert for the same cause is not repeated within this window: a flapping
// provider would otherwise alternate down/answering alerts every cycle.
const DOWN_REPEAT_MS = 30 * 60_000;

const _status = {
  state: "ok",
  since: Date.now(),
  reason: null,        // "login" | "rate_limit" | "error" | "provider"
  detail: null,        // last error text (trimmed)
  retryAt: null,       // Claude cooldown end (ms)
  fallbackModel: null,
  cliErrorStreak: 0,
  fallbackCalls: 0,    // answered by the fallback since leaving "ok"
  lastCall: null,      // { at, role, model, via: "claude" | "fallback" | "direct" }
  lastDownAlertAt: 0,
  lastDownDetail: null,
  cliReason: null,     // the degraded reason to return to when "down" clears via the fallback
};

let _notify = (html) => sendHTML(html);

/** Test hook: replace the Telegram sender. */
export function setLlmStatusNotifier(fn) {
  _notify = typeof fn === "function" ? fn : (html) => sendHTML(html);
}

/** Test hook: back to the initial state. */
export function resetLlmStatus() {
  Object.assign(_status, {
    state: "ok", since: Date.now(), reason: null, detail: null, retryAt: null,
    fallbackModel: null, cliErrorStreak: 0, fallbackCalls: 0, lastCall: null,
    lastDownAlertAt: 0, lastDownDetail: null, cliReason: null,
  });
}

export function getLlmStatus() {
  return { ..._status, lastCall: _status.lastCall ? { ..._status.lastCall } : null };
}

/** "claude-cli/claude-opus-5-5" → "Claude Opus 5.5"; "google/gemini-3.7-flash" → "gemini-3.7-flash". */
export function shortModelName(model) {
  if (typeof model !== "string" || !model) return "?";
  let m = model.startsWith(CLI_PREFIX) ? model.slice(CLI_PREFIX.length) : model;
  const full = m.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?$/i);
  if (full) {
    const family = full[1][0].toUpperCase() + full[1].slice(1);
    return `Claude ${family} ${full[2]}${full[3] ? `.${full[3]}` : ""}`;
  }
  if (model.startsWith(CLI_PREFIX)) return `Claude ${m[0].toUpperCase()}${m.slice(1)}`;
  const slash = m.lastIndexOf("/");
  return slash >= 0 ? m.slice(slash + 1) : m;
}

function hhmm(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function ago(ms) {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m ago`;
}

function trim(text, n = 160) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function send(html) {
  try {
    Promise.resolve(_notify(html)).catch((e) => log("telegram_error", `LLM status alert failed: ${e.message}`));
  } catch (e) {
    log("telegram_error", `LLM status alert failed: ${e.message}`);
  }
}

function setState(state, patch = {}) {
  if (_status.state !== state) _status.since = Date.now();
  _status.state = state;
  Object.assign(_status, patch);
}

function unavailableAlert(reason, detail, fallbackModel, retryAt) {
  const fb = `<code>${escapeHTML(fallbackModel || "fallback")}</code>`;
  if (reason === "login") {
    return `⚠️ <b>Claude unavailable</b> — login rejected\n` +
      `<code>${escapeHTML(trim(detail))}</code>\n` +
      `• Using fallback ${fb}; Claude is retried${retryAt ? ` at <code>${hhmm(retryAt)}</code>` : " every 15m"}\n` +
      `• Fix on the VM as <code>angga</code>: <code>claude setup-token</code> → <code>CLAUDE_CODE_OAUTH_TOKEN</code> in <code>/opt/meridian/.env</code> → restart`;
  }
  if (reason === "rate_limit") {
    return `⏳ <b>Claude rate-limited</b>${retryAt ? ` until <code>${hhmm(retryAt)}</code>` : ""}\n` +
      `• Using fallback ${fb} until then\n<code>${escapeHTML(trim(detail))}</code>`;
  }
  return `⚠️ <b>Claude CLI failing</b> — ${CLI_ERROR_ALERT_STREAK} errors in a row\n` +
    `<code>${escapeHTML(trim(detail))}</code>\n• Using fallback ${fb} for each step until Claude answers`;
}

function classifyCliError(message, cooldown) {
  if (/^Claude CLI unavailable/i.test(message)) return "cooldown";
  if (cooldown?.reason) return cooldown.reason;
  return "error";
}

/** A claude-cli/ model answered. */
export function recordClaudeSuccess({ role, model }) {
  try {
    const wasState = _status.state;
    const since = _status.since;
    const fallbackCalls = _status.fallbackCalls;
    _status.lastCall = { at: Date.now(), role, model, via: "claude" };
    _status.cliErrorStreak = 0;
    if (wasState !== "ok") {
      setState("ok", { reason: null, detail: null, retryAt: null, fallbackCalls: 0 });
      log("llm_status", `[LLM_STATUS] Claude answering again (${shortModelName(model)})`);
      send(`✅ <b>Claude back</b> — <code>${escapeHTML(shortModelName(model))}</code> answering again\n` +
        `• ${wasState === "down" ? "LLM was down" : "Fallback was in use"} since <code>${hhmm(since)}</code>` +
        (fallbackCalls ? ` · ${fallbackCalls} step(s) answered by the fallback` : ""));
    }
  } catch (e) {
    log("llm_status", `recordClaudeSuccess failed (ignored): ${e.message}`);
  }
}

/**
 * A claude-cli/ call failed and the step goes to `fallbackModel`.
 * `cooldown` is llm-cli's getClaudeCliCooldown() after the failure.
 */
export function recordClaudeFailure({ role, model, error, fallbackModel, cooldown = null }) {
  try {
    const message = String(error?.message || error || "");
    const kind = classifyCliError(message, cooldown);
    _status.fallbackModel = fallbackModel || _status.fallbackModel;
    if (kind === "cooldown") return; // a known outage, no new information
    _status.cliErrorStreak += 1;
    const alertable = kind === "login" || kind === "rate_limit" || _status.cliErrorStreak >= CLI_ERROR_ALERT_STREAK;
    if (!alertable) return;
    const retryAt = cooldown?.until ?? null;
    if (_status.state === "ok" || (_status.state === "degraded" && _status.reason !== kind)) {
      setState("degraded", { reason: kind, detail: trim(message, 300), retryAt });
      log("llm_status", `[LLM_STATUS] Claude unavailable (${kind}) — fallback ${fallbackModel} (${role} ${model})`);
      send(unavailableAlert(kind, message, fallbackModel, retryAt));
    } else {
      _status.detail = trim(message, 300);
      _status.retryAt = retryAt;
    }
  } catch (e) {
    log("llm_status", `recordClaudeFailure failed (ignored): ${e.message}`);
  }
}

/** A non-CLI model answered: the fallback (after a CLI failure) or a role configured without claude-cli/. */
export function recordProviderSuccess({ role, model, viaFallback = false }) {
  try {
    _status.lastCall = { at: Date.now(), role, model, via: viaFallback ? "fallback" : "direct" };
    if (viaFallback) _status.fallbackCalls += 1;
    if (_status.state === "down") {
      const next = viaFallback ? "degraded" : "ok";
      setState(next, next === "ok" ? { reason: null, detail: null, retryAt: null } : { reason: _status.cliReason ?? "error" });
      log("llm_status", `[LLM_STATUS] LLM answering again via ${model}`);
      send(`✅ <b>LLM answering again</b> via <code>${escapeHTML(shortModelName(model))}</code>` +
        (viaFallback ? "\n• Still on the fallback — Claude is not answering yet" : ""));
    }
  } catch (e) {
    log("llm_status", `recordProviderSuccess failed (ignored): ${e.message}`);
  }
}

/** The step failed on its last model (fallback or a direct provider) after retries. */
export function recordProviderFailure({ role, model, error }) {
  try {
    const message = trim(error?.message || error || "", 300);
    const now = Date.now();
    const repeat = _status.state === "down"
      || (_status.lastDownDetail === message && now - _status.lastDownAlertAt < DOWN_REPEAT_MS);
    if (_status.state !== "down") _status.cliReason = _status.reason;
    setState("down", { reason: "provider", detail: message });
    if (repeat) return;
    _status.lastDownAlertAt = now;
    _status.lastDownDetail = message;
    log("llm_status", `[LLM_STATUS] LLM down — ${role} step failed on ${model}: ${message}`);
    send(`🛑 <b>LLM down</b> — ${escapeHTML(role || "agent")} step failed on <code>${escapeHTML(shortModelName(model))}</code>\n` +
      `<code>${escapeHTML(trim(message))}</code>\n` +
      `• Screening and LLM management decisions fail until a model answers; mechanical exits (stop loss, trailing, OOR, crash) keep running`);
  } catch (e) {
    log("llm_status", `recordProviderFailure failed (ignored): ${e.message}`);
  }
}

/** One line for the rolling management/screening messages. */
export function formatLlmStatusLine({ roleModel = null } = {}) {
  const s = _status;
  const last = s.lastCall ? ` · last answer ${ago(s.lastCall.at)}` : "";
  if (s.state === "down") {
    return `🤖 <b>LLM down</b> since <code>${hhmm(s.since)}</code> — <code>${escapeHTML(trim(s.detail, 80))}</code>`;
  }
  if (s.state === "degraded") {
    const why = s.reason === "login" ? "Claude login rejected"
      : s.reason === "rate_limit" ? "Claude rate-limited"
        : "Claude CLI failing";
    const retry = s.retryAt && s.retryAt > Date.now() ? ` · retry <code>${hhmm(s.retryAt)}</code>` : "";
    return `🤖 ⚠️ fallback <code>${escapeHTML(shortModelName(s.fallbackModel))}</code> — ${why}${retry}${last}`;
  }
  const model = s.lastCall?.via === "claude" ? s.lastCall.model : roleModel;
  return `🤖 ${escapeHTML(shortModelName(model))} ✓${last}`;
}

/** /llm command reply. */
export function formatLlmStatusReport(llmConfig = {}) {
  const s = _status;
  const header = s.state === "ok" ? "✅ <b>LLM: Claude answering</b>"
    : s.state === "degraded" ? "⚠️ <b>LLM: on the fallback</b>"
      : "🛑 <b>LLM: down</b>";
  const lines = [
    header,
    "",
    `• Screening: <code>${escapeHTML(llmConfig.screeningModel || "?")}</code>`,
    `• Management: <code>${escapeHTML(llmConfig.managementModel || "?")}</code>`,
    `• General: <code>${escapeHTML(llmConfig.generalModel || "?")}</code>`,
    `• Fallback: <code>${escapeHTML(llmConfig.claudeCliFallbackModel || s.fallbackModel || "?")}</code>`,
    "",
    `• State since <code>${hhmm(s.since)}</code>${s.reason ? ` (${escapeHTML(s.reason)})` : ""}`,
  ];
  if (s.retryAt && s.retryAt > Date.now()) lines.push(`• Claude retried at <code>${hhmm(s.retryAt)}</code>`);
  if (s.detail) lines.push(`• Last error: <code>${escapeHTML(trim(s.detail, 200))}</code>`);
  if (s.fallbackCalls) lines.push(`• Steps answered by the fallback: ${s.fallbackCalls}`);
  lines.push(s.lastCall
    ? `• Last answer: ${escapeHTML(s.lastCall.role || "?")} · <code>${escapeHTML(shortModelName(s.lastCall.model))}</code> · ${ago(s.lastCall.at)}`
    : "• No LLM call since the last restart");
  return lines.join("\n");
}
