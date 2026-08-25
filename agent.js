import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

// Cache unsupported model capabilities to avoid repeating API failures across cycles
const _unsupportedRequiredModels = new Set();
const _unsupportedToolChoiceModels = new Set();
const MANAGER_TOOLS  = new Set(["close_position", "claim_fees", "swap_token", "get_position_pnl", "simulate_pnl_curve", "predict_range_survival", "get_my_positions", "get_wallet_positions", "get_wallet_balance", "set_position_note"]);
const SCREENER_TOOLS = new Set(["deploy_position", "get_active_bin", "get_top_candidates", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_pool_memory", "simulate_pool", "get_wallet_balance", "get_my_positions"]);
const GENERAL_INTENT_ONLY_TOOLS = new Set([
  "self_update",
  "update_config",
  "add_to_blacklist",
  "remove_from_blacklist",
  "block_deployer",
  "unblock_deployer",
  "add_pool_note",
  "set_position_note",
  "add_smart_wallet",
  "remove_smart_wallet",
  "add_lesson",
  "pin_lesson",
  "unpin_lesson",
  "clear_lessons",
  "add_strategy",
  "remove_strategy",
  "set_active_strategy",
]);

// Intent → tool subsets for GENERAL role
const INTENT_TOOLS = {
  decisions:   new Set(["get_recent_decisions"]),
  deploy:      new Set(["deploy_position", "get_top_candidates", "get_active_bin", "get_pool_memory", "check_smart_wallets_on_pool", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "get_wallet_balance", "get_my_positions", "add_pool_note"]),
  close:       new Set(["close_position", "get_my_positions", "get_position_pnl", "get_wallet_balance", "swap_token"]),
  claim:       new Set(["claim_fees", "get_my_positions", "get_position_pnl", "get_wallet_balance"]),
  swap:        new Set(["swap_token", "get_wallet_balance"]),
  config:      new Set(["update_config"]),
  blocklist:   new Set(["add_to_blacklist", "remove_from_blacklist", "list_blacklist", "block_deployer", "unblock_deployer", "list_blocked_deployers"]),
  selfupdate:  new Set(["self_update"]),
  balance:     new Set(["get_wallet_balance", "get_my_positions", "get_wallet_positions"]),
  positions:   new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance", "set_position_note", "get_wallet_positions"]),
  strategy:    new Set(["list_strategies", "get_strategy", "add_strategy", "update_strategy", "delete_strategy", "remove_strategy", "set_active_strategy"]),
  screen:      new Set(["get_top_candidates", "get_token_holders", "get_token_narrative", "get_token_info", "search_pools", "check_smart_wallets_on_pool", "get_pool_detail", "get_my_positions", "discover_pools"]),
  memory:      new Set(["get_pool_memory", "add_pool_note", "list_blacklist", "add_to_blacklist", "remove_from_blacklist"]),
  smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet", "list_smart_wallets", "check_smart_wallets_on_pool"]),
  study:       new Set(["study_top_lpers", "get_top_lpers", "get_pool_detail", "search_pools", "get_token_info", "discover_pools", "add_smart_wallet", "list_smart_wallets"]),
  performance: new Set(["get_performance_history", "get_my_positions", "get_position_pnl"]),
  lessons:     new Set(["add_lesson", "pin_lesson", "unpin_lesson", "list_lessons", "clear_lessons"]),
};

const INTENT_PATTERNS = [
  { intent: "decisions",   re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i },
  { intent: "deploy",      re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
  { intent: "close",       re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
  { intent: "claim",       re: /\b(claim|harvest|collect)\b.*\bfee/i },
  { intent: "swap",        re: /\b(swap|convert|sell|exchange)\b/i },
  { intent: "selfupdate",  re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
  { intent: "blocklist",   re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
  { intent: "config",      re: /\b(config|setting|threshold|update|set |change)\b/i },
  { intent: "balance",     re: /\b(balance|wallet|sol|how much)\b/i },
  { intent: "positions",   re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
  { intent: "strategy",    re: /\b(strategy|strategies)\b/i },
  { intent: "screen",      re: /\b(screen|candidate|find pool|search|research|token)\b/i },
  { intent: "memory",      re: /\b(memory|pool history|note|remember)\b/i },
  { intent: "smartwallet", re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i },
  { intent: "study",       re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
  { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
  { intent: "lessons",     re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
];

function getToolsForRole(agentType, goal = "") {
  if (agentType === "MANAGER")  return tools.filter(t => MANAGER_TOOLS.has(t.function.name));
  if (agentType === "SCREENER") return tools.filter(t => SCREENER_TOOLS.has(t.function.name));

  // GENERAL: match intent from goal, combine matched tool sets
  const matched = new Set();
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(goal)) {
      for (const t of INTENT_TOOLS[intent]) matched.add(t);
    }
  }

  // Fall back to all tools if no intent matched
  if (matched.size === 0) return tools.filter(t => !GENERAL_INTENT_ONLY_TOOLS.has(t.function.name));
  return tools.filter(t => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config, DEFAULT_LLM_MODEL, FALLBACK_LLM_MODEL, normalizeLlmModel } from "./config.js";
import { getStateSummary, attachDeployVerdicts } from "./state.js";
import { extractDeployConfidence, runBearDebate } from "./llm-verdicts.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";
import {
  isClaudeCliModel,
  runClaudeCli,
  buildClaudeSystemPrompt,
  buildTranscript,
  parseClaudeAction,
  actionToMessage,
  CLAUDE_EFFORT_BY_ROLE,
} from "./llm-cli.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
const client = new OpenAI({
  baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
  apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
  timeout: 5 * 60 * 1000,
  defaultHeaders: {
    "Connection": "close",
  },
});

const DEFAULT_MODEL = process.env.LLM_MODEL || DEFAULT_LLM_MODEL;

const MUTATING_TOOL_INTENTS = /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS = /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS = /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
  if (agentType === "MANAGER") return false;
  if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
  if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
  if (MUTATING_TOOL_INTENTS.test(goal)) return true;
  return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
  if (providerMode === "user_embedded") {
    return [
      ...sessionHistory,
      {
        role: "user",
        content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
      },
    ];
  }

  return [
    { role: "system", content: systemPrompt },
    ...sessionHistory,
    { role: "user", content: goal },
  ];
}

function isSystemRoleError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return (/tool_choice/i.test(message) && /required/i.test(message)) ||
         (/No endpoints found that support the provided 'tool_choice' value/i.test(message));
}

function isThinkingModeToolChoiceError(error) {
  const message = String(error?.message || error?.error?.message || error || "");
  return /thinking mode does not support/i.test(message) && /tool_choice/i.test(message);
}

/**
 * Claude Code CLI completion — the drop-in for `client.chat.completions.create`
 * when a role's model is prefixed `claude-cli/`. Builds a role-filtered JSON-action
 * prompt, runs `claude -p`, and normalizes the reply to an OpenAI-style assistant
 * message ({ role, content, tool_calls? }) so the rest of agentLoop is unchanged.
 * See llm-cli.js. Throws on CLI failure/rate-limit so the caller can degrade to the
 * OpenRouter fallback model via the existing retry machinery.
 */
async function createClaudeCliMessage(messages, model, agentType, goal, cliId) {
  const roleTools = getToolsForRole(agentType, goal);
  const toolSummaries = roleTools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters || { type: "object", properties: {} },
  }));
  const systemPrompt = buildClaudeSystemPrompt(agentType, toolSummaries);
  const transcript = buildTranscript(messages);
  const effort = CLAUDE_EFFORT_BY_ROLE[agentType] || "medium";
  const timeoutMs = config.llm?.claudeCliTimeoutMs ?? 240000;
  const raw = await runClaudeCli(
    model,
    `CONVERSATION TRANSCRIPT:\n${transcript}\n\nRespond now with a single raw JSON action object.`,
    { systemPrompt, effort, timeoutMs },
  );
  if (!raw) throw new Error("Empty response from Claude CLI");
  return actionToMessage(parseClaudeAction(raw), cliId);
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(goal, maxSteps = config.llm.maxSteps, sessionHistory = [], agentType = "GENERAL", model = null, maxOutputTokens = null, options = {}) {
  const { interactive = false, onToolStart = null, onToolFinish = null } = options;
  const resolvedModel = normalizeLlmModel(model) || DEFAULT_MODEL;
  // Build dynamic system prompt with current portfolio state
  const [portfolio, positions] = await Promise.all([getWalletBalances(), getMyPositions()]);
  const stateSummary = getStateSummary();
  const lessons = getLessonsForPrompt({ agentType });
  const perfSummary = getPerformanceSummary();
  const decisionSummary = getDecisionSummary();
  let weightsSummary = null;
  if (agentType === "SCREENER") {
    try {
      const { getWeightsSummary } = await import("./signal-weights.js");
      const { config } = await import("./config.js");
      if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
    } catch { /* signal-weights not critical */ }
  }
  const systemPrompt = buildSystemPrompt(agentType, portfolio, positions, stateSummary, lessons, perfSummary, weightsSummary, decisionSummary);

  let providerMode = "system";
  let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

  // Track write tools fired this session — prevent the model from calling the same
  // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
  const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
  // These lock after first attempt regardless of success — retrying them is always wrong
  const NO_RETRY_TOOLS = new Set(["deploy_position"]);
  const firedOnce = new Set();
  const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
  let sawToolCall = false;
  // Bear-case debate + structured-confidence verdict for the SCREENER deploy this
  // session. Populated when deploy_position is intercepted; returned to the caller
  // so index.js can surface it in the screening report. See llm-verdicts.js.
  let deployVerdict = null;
  // The assistant text that PRECEDED the current step's tool calls — used to parse
  // the screener's CONFIDENCE/THESIS lines (robust to the no-tool-call quirk).
  let lastAssistantText = "";
  let noToolRetryCount = 0;
  let cliCallCounter = 0; // disambiguates synthesized claude-cli tool_call ids
  
  const initialModel = resolvedModel || config.llm?.generalModel || DEFAULT_LLM_MODEL; // fallback for cache check
  let omitToolChoice = _unsupportedToolChoiceModels.has(initialModel);
  // Proactively prompt if we know toolChoice is unsupported but we need a tool, saving a turn
  if (omitToolChoice && mustUseRealTool) {
    messages.push({
      role: providerMode === "system" ? "system" : "user",
      content: providerMode === "system"
        ? "This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
        : "[SYSTEM REMINDER]\nThis request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
    });
  }

  let emptyStreak = 0;
  for (let step = 0; step < maxSteps; step++) {
    log("agent", `Step ${step + 1}/${maxSteps}`);

    try {
      const activeModel = resolvedModel;

      // Retry up to 3 times on transient provider errors (502, 503, 529)
      const FALLBACK_MODEL = FALLBACK_LLM_MODEL;
      let response;
      let usedModel = activeModel;
      // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
      const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
      let toolChoice = (step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool)) ? "required" : "auto";
      if (toolChoice === "required" && _unsupportedRequiredModels.has(usedModel)) {
        toolChoice = "auto";
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // ── Claude Code CLI backend ──────────────────────────────────────
          // When the resolved model is prefixed `claude-cli/`, route this
          // completion through `claude -p` instead of the OpenAI client. On
          // CLI failure/rate-limit, degrade to the OpenRouter fallback model
          // and let the existing retry loop re-issue via the OpenAI client
          // (claudeCliFallbackModel default null → the same FALLBACK_MODEL the
          // 502/529 path already uses). Dormant + byte-identical when no
          // claude-cli/ model is configured (isClaudeCliModel === false).
          if (isClaudeCliModel(usedModel)) {
            try {
              const cliMsg = await createClaudeCliMessage(messages, usedModel, agentType, goal, ++cliCallCounter);
              response = { choices: [{ message: cliMsg }] };
            } catch (cliErr) {
              // The fallback MUST be a non-CLI model, else we'd loop the CLI path
              // and never obtain a response. Ignore a misconfigured claude-cli/ fallback.
              const cfgFb = config.llm?.claudeCliFallbackModel;
              const fb = (cfgFb && !isClaudeCliModel(cfgFb)) ? cfgFb : FALLBACK_MODEL;
              log("agent", `[CLAUDE_CLI] falling back to ${fb}: ${cliErr?.message || cliErr}`);
              usedModel = fb;
              response = undefined;
              continue; // retry this attempt against the OpenRouter fallback model
            }
          } else {
          const reqParams = {
            model: usedModel,
            messages,
            tools: getToolsForRole(agentType, goal),
            temperature: config.llm.temperature,
            max_tokens: maxOutputTokens ?? config.llm.maxTokens,
          };
          if (!omitToolChoice) reqParams.tool_choice = toolChoice;
          response = await client.chat.completions.create(reqParams);
          }
        } catch (error) {
          if (providerMode === "system" && isSystemRoleError(error)) {
            providerMode = "user_embedded";
            messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
            log("agent", "Provider rejected system role — retrying with embedded system instructions");
            attempt -= 1;
            continue;
          }
          if (toolChoice === "required" && isToolChoiceRequiredError(error)) {
            toolChoice = "auto";
            _unsupportedRequiredModels.add(usedModel);
            log("agent", `Provider rejected tool_choice=required — retrying with tool_choice=auto (cached for ${usedModel})`);
            attempt -= 1;
            continue;
          }
          if (!omitToolChoice && isThinkingModeToolChoiceError(error)) {
            omitToolChoice = true;
            _unsupportedToolChoiceModels.add(usedModel);
            log("agent", `Provider thinking mode does not support tool_choice — retrying without it (cached for ${usedModel})`);
            attempt -= 1;
            continue;
          }
          
          const errMsg = String(error?.message || error?.error?.message || error || "");
          const isTransient = errMsg.includes("ECONNRESET") ||
                              errMsg.includes("ETIMEDOUT") ||
                              errMsg.includes("fetch failed") ||
                              errMsg.includes("502") ||
                              errMsg.includes("503") ||
                              errMsg.includes("504") ||
                              error.status === 429 ||
                              error.status === 502 ||
                              error.status === 503 ||
                              error.status === 504;
          if (isTransient && attempt < 2) {
            const wait = (attempt + 1) * 3000;
            log("agent", `Transient LLM error (${errMsg}), retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          throw error;
        }
        if (response.choices?.length) break;
        const errCode = response.error?.code;
        if (errCode === 502 || errCode === 503 || errCode === 529) {
          const wait = (attempt + 1) * 5000;
          if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
            usedModel = FALLBACK_MODEL;
            log("agent", `Switching to fallback model ${FALLBACK_MODEL}`);
          } else {
            log("agent", `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
            await new Promise((r) => setTimeout(r, wait));
          }
        } else {
          break;
        }
      }

      if (!response.choices?.length) {
        log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
        throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
      }
      const msg = response.choices[0].message;
      if (!msg.content && msg.reasoning_content) {
        msg.content = msg.reasoning_content;
        log("agent", "Mapped reasoning_content to message content");
      }
      // Repair malformed tool call JSON before pushing to history —
      // the API rejects the next request if history contains invalid JSON args
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.arguments) {
            try {
              JSON.parse(tc.function.arguments);
            } catch {
              try {
                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
              } catch {
                tc.function.arguments = "{}";
                log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
              }
            }
          }
        }
      }
      messages.push(msg);

      // Remember the latest non-empty assistant text — the screener states its
      // CONFIDENCE/THESIS lines here, in the turn that also carries the deploy call.
      if (msg.content && String(msg.content).trim()) lastAssistantText = String(msg.content);

      // If the model didn't call any tools, it's done
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // Hermes sometimes returns null content — pop the empty message and retry once
        if (!msg.content) {
          messages.pop(); // remove the empty assistant message
          log("agent", "Empty response, retrying...");
          continue;
        }
        // Narrow bypass: a claude-cli SCREENER turn that explicitly declares a
        // structured no-deploy decision (see llm-cli.js buildClaudeSystemPrompt)
        // is accepted as final without the retry loop below — it's a legitimate,
        // clearly-marked decision, not a hallucinated-action risk. All other
        // text-only finals (any model, any role) keep the existing 3x retry guard.
        const isNoDeployFinal = mustUseRealTool && !sawToolCall &&
          isClaudeCliModel(usedModel) && agentType === "SCREENER" &&
          /^(?:⛔\s*)?(?:\*\*)?no deploy/i.test(String(msg.content).trim());
        if (isNoDeployFinal) {
          log("agent", "Accepted structured NO DEPLOY final (claude-cli, no retry)");
        } else if (mustUseRealTool && !sawToolCall) {
          noToolRetryCount += 1;
          messages.pop();
          log("agent", `Rejected no-tool final answer (${noToolRetryCount}/3) for tool-required request`);
          if (noToolRetryCount >= 3) {
            // The model declined to emit a tool call (a known thinking-model
            // quirk). This is a non-event for cron cycles — surface it calmly,
            // not as an error, and flag it so callers can present it gracefully.
            log("agent", "Giving up after 3 no-tool retries — returning no-action result");
            return {
              content: "No action this cycle — the model returned no tool call. Will retry on the next cycle.",
              userMessage: goal,
              noToolFallback: true,
            };
          }
          messages.push({
            role: providerMode === "system" ? "system" : "user",
            content: providerMode === "system"
              ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
              : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
          });
          continue;
        }
        log("agent", "Final answer reached");
        log("agent", msg.content);
        return { content: msg.content, userMessage: goal, deployVerdict };
      }
      sawToolCall = true;

      // Execute each tool call in parallel
      const toolResults = await Promise.all(msg.tool_calls.map(async (toolCall) => {
        const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
        let functionArgs;

        try {
          functionArgs = JSON.parse(toolCall.function.arguments);
        } catch {
          try {
            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
            log("warn", `Repaired malformed JSON args for ${functionName}`);
          } catch (parseError) {
            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
            functionArgs = {};
          }
        }

        // Block once-per-session tools from firing a second time
        if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
          log("agent", `Blocked duplicate ${functionName} call — already executed this session`);
          await onToolFinish?.({
            name: functionName,
            args: functionArgs,
            result: { blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` },
            success: false,
            step,
          });
          return {
            role: "tool",
            tool_call_id: toolCall.id,
            content: JSON.stringify({ blocked: true, reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.` }),
          };
        }

        await onToolStart?.({ name: functionName, args: functionArgs, step });

        // ── SCREENER deploy gate: structured confidence + adversarial bear debate ──
        // Runs ONCE, only for the SCREENER's deploy_position, before it executes.
        // Fail-open by construction: any error → proceed. log_only (default) never
        // blocks — it records what it WOULD have done. Only "enforce" veto blocks.
        if (functionName === "deploy_position" && agentType === "SCREENER" && !deployVerdict) {
          try {
            const bearEnabled = config.screening?.bearDebateEnabled ?? true;
            const bearAction = config.screening?.bearDebateAction ?? "log_only"; // "enforce" to act
            let bearModel = config.llm?.bearDebateModel ?? (model || config.llm?.screeningModel || DEFAULT_MODEL);
            // The bear debate runs through the OpenAI client (not the CLI this
            // phase), so a claude-cli/ model id would be rejected by OpenRouter.
            // Fall back to a real OpenRouter model. Dormant when no cli model set.
            if (isClaudeCliModel(bearModel)) bearModel = config.llm?.claudeCliFallbackModel || DEFAULT_MODEL;
            const { confidence, thesis } = extractDeployConfidence(lastAssistantText);

            if (bearEnabled) {
              const bear = await runBearDebate({
                client, model: bearModel,
                thesis, confidence,
                deployArgs: functionArgs,
                candidateContext: lastAssistantText,
              });
              const enforce = bearAction === "enforce";
              deployVerdict = {
                deploy_confidence: confidence ?? null,
                deploy_thesis: thesis ?? null,
                bear_verdict: bear.verdict,
                bear_confidence: bear.confidence,
                bear_reason: bear.reason,
                bear_parsed: bear.parsed, // false = structured VERDICT not found → fail-open proceed (calibration signal)
                bear_action: bearAction,
                bear_error: bear.error || null,
                enforced: false,
                blocked: false,
                size_down: false,
              };
              log("agent",
                `Bear debate [${enforce ? "ENFORCE" : "log_only"}]: verdict=${bear.verdict}` +
                ` conf=${bear.confidence ?? "n/a"} screenerConf=${confidence ?? "n/a"}` +
                ` reason="${bear.reason || ""}"`);

              if (bear.verdict === "veto") {
                if (enforce) {
                  deployVerdict.enforced = true;
                  deployVerdict.blocked = true;
                  firedOnce.add(functionName); // lock — never retry a vetoed deploy this cycle
                  log("agent", "Bear VETO enforced — blocking deploy this cycle");
                  const blockResult = {
                    blocked: true,
                    success: false,
                    reason: `Deploy vetoed by risk-manager debate this cycle: ${bear.reason || "strong money-losing risk"}. Do not retry — report NO DEPLOY.`,
                    bear_debate: { verdict: bear.verdict, reason: bear.reason },
                  };
                  await onToolFinish?.({ name: functionName, args: functionArgs, result: blockResult, success: false, step });
                  return { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(blockResult) };
                }
                log("agent", "Bear VETO (log_only) — would block, proceeding");
              } else if (bear.verdict === "size_down") {
                deployVerdict.size_down = true;
                if (enforce) {
                  deployVerdict.enforced = true;
                  // Halve the SOL amount in place. Deploys are single-side SOL (amount_y / amount_sol).
                  for (const k of ["amount_y", "amount_sol"]) {
                    if (typeof functionArgs[k] === "number" && functionArgs[k] > 0) {
                      const before = functionArgs[k];
                      functionArgs[k] = before / 2;
                      log("agent", `Bear size_down enforced — halved ${k} ${before} → ${functionArgs[k]}`);
                    }
                  }
                } else {
                  log("agent", "Bear size_down (log_only) — would halve amount, proceeding at full size");
                }
              }
            }
          } catch (verr) {
            // The gate must NEVER break a deploy by failing. Any error → proceed.
            log("agent", `Bear-debate gate error (${verr?.message || verr}) — proceeding with deploy`);
          }
        }

        const result = await executeTool(functionName, functionArgs);
        await onToolFinish?.({
          name: functionName,
          args: functionArgs,
          result,
          success: result?.success !== false && !result?.error && !result?.blocked,
          step,
        });

        // Post-hoc: attach the deploy verdicts (confidence + bear debate) onto the
        // freshly-tracked position for later outcome correlation. Mirrors the
        // fee_efficiency/organic_momentum capture; we do it here because we can't
        // thread these through dlmm.js's trackPosition. Non-fatal.
        if (functionName === "deploy_position" && deployVerdict && result?.position &&
            result?.success !== false && !result?.error && !result?.blocked) {
          try {
            attachDeployVerdicts(result.position, {
              deploy_confidence: deployVerdict.deploy_confidence,
              deploy_thesis: deployVerdict.deploy_thesis,
              bear_debate: {
                verdict: deployVerdict.bear_verdict,
                confidence: deployVerdict.bear_confidence,
                reason: deployVerdict.bear_reason,
                action: deployVerdict.bear_action,
                enforced: deployVerdict.enforced,
                // Fail-open discriminator: a "proceed" with parsed=false is an
                // error/parse-miss default, NOT a risk manager approving the deploy.
                // Without these two the persisted record is indistinguishable from
                // a real proceed, which silently poisons outcome correlation.
                parsed: deployVerdict.bear_parsed,
                error: deployVerdict.bear_error,
              },
            });
          } catch (aerr) {
            log("agent", `attachDeployVerdicts failed (${aerr?.message || aerr}) — non-fatal`);
          }
        }

        // Lock deploy_position after first attempt regardless of outcome — retrying is never right
        // For close/swap: only lock on success so genuine failures can be retried
        if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
        else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

        return {
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        };
      }));

      messages.push(...toolResults);
    } catch (error) {
      log("error", `Agent loop error at step ${step}: ${error.message}`);

      // If it's a rate limit, wait and retry
      if (error.status === 429) {
        log("agent", "Rate limited, waiting 30s...");
        await sleep(30000);
        continue;
      }

      // For other errors, break the loop
      throw error;
    }
  }

  log("agent", "Max steps reached without final answer");
  return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal, deployVerdict };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
