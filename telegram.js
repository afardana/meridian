import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId = null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

export function escapeHTML(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/<=/g, "≤")
    .replace(/>=/g, "≥")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function nonEmptyChatId(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

// ─── chatId persistence ──────────────────────────────────────────
function resolveChatId() {
  const fromEnv = nonEmptyChatId(process.env.TELEGRAM_CHAT_ID);
  let fromConfig = null;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      fromConfig = nonEmptyChatId(cfg.telegramChatId);
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
  // user-config wins when set; otherwise fall back to .env
  const resolved = fromConfig || fromEnv || null;
  return resolved != null ? String(resolved) : null;
}

function loadChatId() {
  chatId = resolveChatId();
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== String(chatId)) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
        
        // HTML entity parse error fallback
        if (err.includes("can't parse entities") && body && body.parse_mode === "HTML" && body.text) {
          log("telegram_warn", `${method} HTML parsing failed. Retrying with raw plain text fallback.`);
          const plainText = body.text
            .replace(/<[^>]*>/g, "")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&amp;/g, "&");
          const fallbackBody = { ...body };
          delete fallbackBody.parse_mode;
          fallbackBody.text = plainText;
          return postTelegram(method, fallbackBody);
        }
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text, parseMode = null) {
  if (!TOKEN || !chatId) return;
  const payload = { 
    text: String(text).slice(0, 4096),
    link_preview_options: { is_disabled: true }
  };
  if (parseMode) payload.parse_mode = parseMode;
  return postTelegram("sendMessage", payload);
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
    link_preview_options: { is_disabled: true }
  });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { 
    text: html.slice(0, 4096), 
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true }
  });
}

export async function editMessage(text, messageId, parseMode = null) {
  if (!TOKEN || !chatId || !messageId) return null;
  const payload = {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    link_preview_options: { is_disabled: true }
  };
  if (parseMode) payload.parse_mode = parseMode;
  return postTelegram("editMessageText", payload);
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
    link_preview_options: { is_disabled: true }
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

export function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function escape(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function render() {
    const sections = [];
    if (state.title) {
      sections.push(`🔄 <b>${escape(state.title.replace(/^🔄\s*/, ""))}</b>`);
    }
    if (state.intro) {
      sections.push(escape(state.intro));
    }
    if (state.toolLines.length > 0) {
      sections.push(state.toolLines.map(line => escape(line)).join("\n"));
    }
    if (state.footer) {
      sections.push(state.footer);
    }
    return sections.join("\n\n").slice(0, 4096);
  }

  let lastEditTime = 0;
  async function flushNow() {
    const elapsed = Date.now() - lastEditTime;
    if (state.messageId && elapsed < 3000) {
      scheduleFlush(3000 - elapsed);
      return;
    }
    state.flushTimer = null;
    state.flushRequested = false;
    lastEditTime = Date.now();
    const htmlText = render();
    if (!state.messageId) {
      const sent = await sendHTML(htmlText);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(htmlText, state.messageId, "HTML");
  }

  function scheduleFlush(delay = 1500) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      const elapsed = Date.now() - lastEditTime;
      if (state.messageId && elapsed < 3000) {
        await new Promise((resolve) => setTimeout(resolve, 3000 - elapsed));
      }
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${escapeHTML(errorText)}`;
      const elapsed = Date.now() - lastEditTime;
      if (state.messageId && elapsed < 3000) {
        await new Promise((resolve) => setTimeout(resolve, 3000 - elapsed));
      }
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

const BOT_COMMANDS = [
  { command: "help",       description: "Show commands" },
  { command: "health",     description: "System health check and error telemetry" },
  { command: "status",     description: "Wallet + positions snapshot" },
  { command: "wallet",     description: "Wallet, deploy amount, HiveMind status" },
  { command: "positions",  description: "List open positions" },
  { command: "pool",       description: "Detailed info for one open position" },
  { command: "close",      description: "Close one position by index" },
  { command: "closeall",   description: "Close all open positions" },
  { command: "set",        description: "Set note/instruction on position" },
  { command: "config",     description: "Show important runtime config" },
  { command: "settings",   description: "Button menu for common config" },
  { command: "setcfg",     description: "Update persisted config key" },
  { command: "screen",     description: "Refresh deterministic candidate list" },
  { command: "candidates", description: "Show latest cached candidates" },
  { command: "deploy",     description: "Deploy candidate by cached index" },
  { command: "briefing",   description: "Morning briefing" },
  { command: "hive",       description: "HiveMind sync status" },
  { command: "agy",        description: "Run Google Antigravity prompt" },
  { command: "sessions",   description: "List and resume agy sessions" },
  { command: "exit",       description: "Close active agy session" },
  { command: "gitstatus",  description: "Check git repo status and updates" },
  { command: "gitpull",    description: "Pull latest changes from upstream git" },
  { command: "restart",    description: "Restart PM2 meridian daemon" },
  { command: "sync",       description: "Check upstream for updates manually" },
  { command: "pause",      description: "Stop cron cycles" },
  { command: "resume",     description: "Start cron cycles again" },
  { command: "cooldowns",  description: "List and release active cooldowns" },
  { command: "stop",       description: "Shut down agent" },
];

async function registerCommands() {
  if (!BASE) return;
  try {
    await fetch(`${BASE}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    log("telegram", "Bot commands registered");
  } catch (e) {
    log("telegram_warn", `Failed to register bot commands: ${e.message}`);
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  loadChatId();
  if (!chatId) {
    log("telegram_warn", "TELEGRAM_CHAT_ID not set in .env or user-config.telegramChatId — outbound notifications and inbound control disabled until configured.");
  }
  _polling = true;
  poll(onMessage); // fire-and-forget
  registerCommands();
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee, lazy }) {
  if (hasActiveLiveMessage()) return;
  const priceStr = priceRange
    ? `Price range: ${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} – ${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}\n`
    : "";
  const coverageStr = rangeCoverage
    ? `Range cover: ${fmtPct(rangeCoverage.downside_pct)} downside | ${fmtPct(rangeCoverage.upside_pct)} upside | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `Bin step: ${binStep ?? "?"}  |  Base fee: ${baseFee != null ? baseFee + "%" : "?"}\n`
    : "";
  await sendHTML(
    `✅ <b>Deployed${lazy ? " (Lazy LP)" : ""}</b> ${escapeHTML(pair)}\n` +
    `Amount: ${amountSol} SOL\n` +
    priceStr +
    coverageStr +
    poolStr +
    `Position: <code>${position?.slice(0, 8)}...</code>\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyClose({ pair, pnlUsd, pnlSol, pnlPct, deployedUsd, deployedSol, feesUsd, holdTime, strategy, reason }) {
  if (hasActiveLiveMessage()) return;
  const sign = pnlUsd >= 0 ? "+" : "";
  const pctSign = pnlPct >= 0 ? "+" : "";
  const headEmoji = (pnlUsd ?? 0) >= 0 ? "🟢" : "🔴";
  await sendHTML(
    `${headEmoji} <b>Position Closed</b> — ${escapeHTML(pair)}\n` +
    `💰 PnL: ${sign}$${(pnlUsd ?? 0).toFixed(2)} (${sign}◎${(pnlSol ?? 0).toFixed(4)}) (${pctSign}${(pnlPct ?? 0).toFixed(2)}%)\n` +
    `💎 Deployed: $${(deployedUsd ?? 0).toFixed(2)} (◎${(deployedSol ?? 0).toFixed(4)})\n` +
    `💎 Fees: $${(feesUsd ?? 0).toFixed(2)}\n` +
    `⏱️ Hold time: ${holdTime ?? "?"}m\n` +
    `📐 Strategy: ${escapeHTML(strategy || "unknown")}\n` +
    `📝 Reason: ${escapeHTML(reason || "agent decision")}`
  );
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `🔄 <b>Swapped</b> ${escapeHTML(inputSymbol)} → ${escapeHTML(outputSymbol)}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}\n` +
    `Tx: <code>${tx?.slice(0, 16)}...</code>`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `⚠️ <b>Out of Range</b> ${escapeHTML(pair)}\n` +
    `Been OOR for ${minutesOOR} minutes`
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

// Helper to balance tags
function balanceTags(html) {
  // Telegram requires strictly nested tags — crossed tags like
  // <b>...<i>...</b>...</i> cause parse errors.
  // This function fixes both unclosed AND crossed tags.
  const tagRegex = /<\/?([a-zA-Z0-9\-]+)(?:\s+[^>]*)?>/g;
  const selfClosing = new Set(["br", "hr", "img"]);
  const tokens = [];
  let lastIndex = 0;
  let match;

  while ((match = tagRegex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: html.slice(lastIndex, match.index) });
    }
    const tagName = match[1].toLowerCase();
    if (!selfClosing.has(tagName)) {
      tokens.push({
        type: match[0].startsWith("</") ? "close" : "open",
        tag: tagName,
        value: match[0],
      });
    } else {
      tokens.push({ type: "text", value: match[0] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < html.length) {
    tokens.push({ type: "text", value: html.slice(lastIndex) });
  }

  // Rebuild with proper nesting
  const stack = []; // currently open tags
  let result = "";
  for (const token of tokens) {
    if (token.type === "text") {
      result += token.value;
    } else if (token.type === "open") {
      stack.push(token.tag);
      result += `<${token.tag}>`;
    } else {
      // Close tag — find it in the stack
      const idx = stack.lastIndexOf(token.tag);
      if (idx === -1) {
        // Orphan close tag — skip it
        continue;
      }
      // Close any tags opened after this one (crossed tags)
      const toReopen = [];
      while (stack.length > idx + 1) {
        const inner = stack.pop();
        result += `</${inner}>`;
        toReopen.push(inner);
      }
      stack.pop(); // remove the target tag
      result += `</${token.tag}>`;
      // Reopen the crossed tags
      for (const tag of toReopen) {
        stack.push(tag);
        result += `<${tag}>`;
      }
    }
  }
  // Close any remaining unclosed tags
  while (stack.length > 0) {
    result += `</${stack.pop()}>`;
  }
  return result;
}

export function markdownToTelegramHTML(markdown) {
  if (!markdown) return "";

  // Helper to escape HTML special chars
  function escapeHTML(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/<=/g, "≤")
      .replace(/>=/g, "≥")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  const placeholderMap = new Map();
  let placeholderCounter = 0;

  // 1. Extract block code blocks (```lang ... ```)
  let processed = markdown.replace(/```(\w*)\s*\r?\n([\s\S]*?)```/g, (match, lang, code) => {
    const key = `HTMLCODEBLOCKPLACEHOLDER${placeholderCounter++}`;
    const escapedCode = escapeHTML(code.trimEnd());
    const langAttr = lang ? ` class="language-${lang}"` : "";
    placeholderMap.set(key, `<pre><code${langAttr}>${escapedCode}</code></pre>`);
    return key;
  });

  // 2. Extract inline code blocks (`code`)
  processed = processed.replace(/`([^`\n]+)`/g, (match, code) => {
    const key = `HTMLINLINECODEPLACEHOLDER${placeholderCounter++}`;
    placeholderMap.set(key, `<code>${escapeHTML(code)}</code>`);
    return key;
  });

  // Now escape the rest of the text
  processed = escapeHTML(processed);

  // 3. Process blockquotes (lines starting with &gt;)
  function formatBlockquoteGroup(lines) {
    if (lines.length === 0) return "";
    const firstLine = lines[0].trim();
    const alertMatch = firstLine.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i);
    if (alertMatch) {
      const type = alertMatch[1].toUpperCase();
      const content = lines.slice(1).join("\n").trim();
      const emojiMap = {
        NOTE: "ℹ️",
        TIP: "💡",
        IMPORTANT: "📢",
        WARNING: "⚠️",
        CAUTION: "🔥"
      };
      const emoji = emojiMap[type] || "ℹ️";
      const isExpandable = content.split("\n").length > 3 || content.length > 200;
      const attr = isExpandable ? " expandable" : "";
      return `<blockquote${attr}><b>${emoji} ${type}</b><br/>${content}</blockquote>`;
    } else {
      const content = lines.join("\n").trim();
      const isExpandable = content.split("\n").length > 4 || content.length > 250;
      const attr = isExpandable ? " expandable" : "";
      return `<blockquote${attr}>${content}</blockquote>`;
    }
  }

  const lines = processed.split("\n");
  const parsedLines = [];
  let inBlockquote = false;
  let blockquoteLines = [];

  for (let line of lines) {
    const match = line.match(/^\s*&gt;\s?(.*)$/);
    if (match) {
      inBlockquote = true;
      blockquoteLines.push(match[1]);
    } else {
      if (inBlockquote) {
        parsedLines.push(formatBlockquoteGroup(blockquoteLines));
        blockquoteLines = [];
        inBlockquote = false;
      }
      parsedLines.push(line);
    }
  }
  if (inBlockquote) {
    parsedLines.push(formatBlockquoteGroup(blockquoteLines));
  }
  processed = parsedLines.join("\n");

  // 4. Process list items (starts of lines)
  processed = processed.replace(/^\s*[-*+]\s+(.+)/gm, "• $1");

  // 5. Process links: [text](url)
  processed = processed.replace(/\[([^\]]+)\]\(((?:https?:\/\/|tg:\/\/)[^\s)]+)\)/g, (match, text, url) => {
    return `<a href="${url}">${text}</a>`;
  });

  // 6. Bold: **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  processed = processed.replace(/__(.+?)__/g, "<b>$1</b>");

  // 7. Italic: *text* or _text_
  // Avoid matching across lines or bold markers; require word boundaries for
  // underscore to prevent identifiers like fee_tvl becoming italic.
  processed = processed.replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, "<i>$1</i>");
  processed = processed.replace(/(?<![a-zA-Z0-9])_([^_\n]+?)_(?![a-zA-Z0-9])/g, "<i>$1</i>");

  // 8. Strikethrough: ~~text~~
  processed = processed.replace(/~~([\s\S]+?)~~/g, "<s>$1</s>");

  // 9. Spoilers: ||text||
  processed = processed.replace(/\|\|([\s\S]+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>");

  // 10. Headers: # Heading -> bold
  processed = processed.replace(/^#{1,6}\s+(.+)/gm, "<b>$1</b>");

  // 11. Restore the code blocks
  for (const [key, value] of placeholderMap.entries()) {
    processed = processed.replace(key, value);
  }

  // 12. Process checklist checkboxes
  processed = processed.replace(/\[x\]/ig, "✅");
  processed = processed.replace(/\[ \]/g, "⬜");
  processed = processed.replace(/\[\/\]/g, "🔄");

  // Balance HTML tags to prevent parsing errors
  processed = balanceTags(processed);

  return processed;
}
