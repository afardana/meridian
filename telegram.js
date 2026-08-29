import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { recordOutboundMessage } from "./telegram-marker.js";
import { getSolPriceUsd } from "./sol-price.js";

/**
 * Render an amount in both currencies: "◎0.4100 ($33.57)".
 * `sol` is authoritative; `usd` is used when provided, otherwise derived from
 * the cached SOL price. Degrades to "◎X" when no USD value is derivable.
 */
export function fmtSolUsd(sol, usd = null, { solDec = 4, usdDec = 2 } = {}) {
  const s = Number(sol);
  if (!Number.isFinite(s)) return "?";
  let u = Number(usd);
  if (!Number.isFinite(u) || u === 0) {
    const price = getSolPriceUsd();
    u = price > 0 ? s * price : null;
  }
  const solStr = `◎${s.toFixed(solDec)}`;
  return u != null ? `${solStr} ($${u.toFixed(usdDec)})` : solStr;
}

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

async function postTelegram(method, body, attempt = 0) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      
      // Handle 429 Rate Limits (except for sendChatAction)
      if (res.status === 429 && method !== "sendChatAction" && attempt < 3) {
        let retryAfter = 5;
        try {
          const json = JSON.parse(err);
          if (json?.parameters?.retry_after) {
            retryAfter = json.parameters.retry_after;
          }
        } catch (_) {}
        log("telegram_warn", `${method} 429 Too Many Requests (attempt ${attempt + 1}). Retrying in ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
        return postTelegram(method, body, attempt + 1);
      }

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
          return postTelegram(method, fallbackBody, attempt);
        }
      }
      return null;
    }
    const json = await res.json();
    // Track the most-recent chat message so the management cycle knows whether its
    // rolling bubble is still last. Only NEW messages count — edits keep their id.
    if (method === "sendMessage" && json?.result?.message_id != null) {
      recordOutboundMessage(json.result.message_id);
    }
    return json;
  } catch (e) {
    // Network-level failure ("fetch failed", ECONNRESET, DNS blip) — transient far
    // more often than not; without a retry a one-off blip silently drops the message
    // (2026-08-21: the morning briefing send died on exactly this). sendChatAction
    // is cosmetic — not worth retrying.
    if (method !== "sendChatAction" && attempt < 3) {
      const backoffMs = 2000 * Math.pow(2, attempt);
      log("telegram_warn", `${method} network failure (${e.message}), retry ${attempt + 1}/3 in ${backoffMs / 1000}s`);
      await new Promise((r) => setTimeout(r, backoffMs));
      return postTelegram(method, body, attempt + 1);
    }
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body, attempt = 0) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();

      // Handle 429 Rate Limits
      if (res.status === 429 && method !== "sendChatAction" && attempt < 3) {
        let retryAfter = 5;
        try {
          const json = JSON.parse(err);
          if (json?.parameters?.retry_after) {
            retryAfter = json.parameters.retry_after;
          }
        } catch (_) {}
        log("telegram_warn", `${method} 429 Too Many Requests (attempt ${attempt + 1}). Retrying in ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
        return postTelegramRaw(method, body, attempt + 1);
      }

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
    try {
      await postTelegram("sendChatAction", { action: "typing" });
    } catch (_) {}
    if (stopped) return; // check again after async await
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

export async function createLiveMessage(title, intro = "Starting...", opts = {}) {
  if (!TOKEN || !chatId) return null;
  // Back-compat: a boolean 3rd arg used to mean showTyping.
  const { showTyping = false, reuseMessageId = null } =
    typeof opts === "boolean" ? { showTyping: opts } : opts;
  const typing = showTyping ? createTypingIndicator() : { stop() {} };

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    // When reusing, adopt the existing bubble's id so the first flush EDITS it
    // (and we skip the initial flush below to avoid flickering the old content).
    messageId: reuseMessageId ?? null,
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
  // New bubble → send the intro now. Reused bubble → leave the existing content
  // untouched until the first real update/finalize (no "Evaluating…" flicker).
  if (!reuseMessageId) await flushNow();

  return {
    getMessageId() { return state.messageId; },
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
    /**
     * Write the cycle's outcome into the bubble.
     *
     * Default (asNewMessage=false) EDITS the bubble in place — silent, no push
     * notification, which is what we want for no-op/STAY ticks so consecutive
     * ticks update one bubble instead of spamming the chat.
     *
     * asNewMessage=true instead posts the outcome as a BRAND-NEW message, which
     * DOES push a notification. Use it when the cycle actually changed state
     * (close/flip/claim): an in-place edit is invisible on the user's phone, so a
     * silent edit meant real position closes went unannounced (Jimothy-SOL,
     * 2026-07-18). Implemented by clearing messageId so flushNow() sends instead
     * of edits; the new message id becomes the bubble the NEXT tick edits.
     */
    async finalize(finalText, { asNewMessage = false } = {}) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      if (asNewMessage) {
        // Post fresh (push notification). No rate-limit wait needed: sending a
        // new message isn't an edit of the just-edited bubble.
        state.messageId = null;
      } else {
        const elapsed = Date.now() - lastEditTime;
        if (state.messageId && elapsed < 3000) {
          await new Promise((resolve) => setTimeout(resolve, 3000 - elapsed));
        }
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
  { command: "exits",      description: "Exit-quality report (post-close price probes)" },
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
/**
 * Deploy notification. Mirrors the close-v2 style: amount in ◎/$, one compact
 * range line, one pool-context line (entry mcap / fee yield / volatility /
 * crowd momentum — the "why we entered" snapshot for later reconciliation
 * against the close + exit-review messages).
 */
export async function notifyDeploy({ pair, amountSol, position, tx, pool, priceRange, rangeCoverage, binStep, baseFee, lazy, strategy, binCount, entryMcap, feeTvl24h, volatility, momentum }) {
  if (hasActiveLiveMessage()) return;
  const solPrice = getSolPriceUsd();
  const entryPriceStr = solPrice > 0 ? ` · SOL @ $${solPrice.toFixed(2)}` : "";
  const rangeBits = [
    rangeCoverage ? `${fmtPct(rangeCoverage.downside_pct)} ↓ · ${fmtPct(rangeCoverage.upside_pct)} ↑` : null,
    binCount ? `${binCount} bins` : null,
    strategy && strategy !== "unknown" ? escapeHTML(strategy) : null,
    binStep ? `step ${binStep}` : null,
    baseFee != null ? `fee ${baseFee}%` : null,
  ].filter(Boolean).join(" · ");
  const fmtMcap = (m) => m >= 1e6 ? `$${(m / 1e6).toFixed(1)}M` : m >= 1e3 ? `$${(m / 1e3).toFixed(0)}k` : `$${Math.round(m)}`;
  const poolBits = [
    feeTvl24h != null ? `fee/TVL ${Number(feeTvl24h).toFixed(2)}%/24h` : null,
    volatility != null ? `vol ${Number(volatility).toFixed(1)}` : null,
    entryMcap > 0 ? `mcap ${fmtMcap(entryMcap)}` : null,
    momentum ? `crowd: ${escapeHTML(momentum)}` : null,
  ].filter(Boolean).join(" · ");
  const links = [
    pool ? `<a href="${meteoraPool(pool)}">pool</a>` : null,
    position ? `<a href="${solscanAcct(position)}">position</a>` : null,
    tx ? `<a href="${solscanTx(tx)}">tx</a>` : null,
  ].filter(Boolean).join(" · ");
  await sendHTML(
    `🚀 <b>Deployed${lazy ? " (Lazy LP)" : ""}</b> ${escapeHTML(pair)} — ${fmtSolUsd(amountSol)}${entryPriceStr}\n` +
    (rangeBits ? `Range: ${rangeBits}\n` : "") +
    (poolBits ? `Pool: ${poolBits}\n` : "") +
    (links ? `🔗 ${links}` : `Position: <code>${position?.slice(0, 8)}...</code>`)
  );
}

/**
 * Close notification. All money fields are EXPLICIT per currency:
 * `pnlSol`/`deployedSol`/`feesSol` are SOL; `pnlUsd`/`deployedUsd`/`feesUsd`
 * are TRUE USD (never solMode-dependent — the caller resolves units).
 * Missing USD sides are derived from the cached SOL price by fmtSolUsd.
 * `outcome` ("success"|"failure"|"neutral", from lessons.classifyOutcome)
 * drives the emoji so a break-even fee-death shows ⚪, not green.
 * "Received" = deployed + pnl (Meteora's closed pnl already includes fees).
 */
export async function notifyClose({ pair, pnlUsd, pnlSol, pnlPct, deployedUsd, deployedSol, feesUsd, feesSol, holdTime, strategy, reason, pool, tx, outcome, gasSol, peakPnlPct, thesis, confidence }) {
  if (hasActiveLiveMessage()) return;
  const sign = (pnlSol ?? 0) >= 0 ? "+" : "";
  const pctSign = (pnlPct ?? 0) >= 0 ? "+" : "";
  const outcomeEmoji = outcome === "success" ? "🟢"
    : outcome === "failure" ? "🔴"
    : outcome === "neutral" ? "⚪"
    : (pnlSol ?? 0) >= 0 ? "🟢" : "🔴"; // fallback: sign-based
  const receivedSol = (deployedSol ?? 0) + (pnlSol ?? 0);
  // Peak-vs-exit line only when there was a meaningful peak above the exit —
  // instant read on exit efficiency (how much of the run we kept).
  const peakLine = peakPnlPct != null && pnlPct != null && peakPnlPct > Math.max(pnlPct + 0.25, 0.5)
    ? `\n🔝 Peak: +${peakPnlPct.toFixed(2)}% → exit ${pctSign}${pnlPct.toFixed(2)}%`
    : "";
  const gasStr = gasSol > 0 ? ` · ⛽ ◎${gasSol.toFixed(5)}` : "";
  const stratStr = strategy && strategy !== "unknown" ? ` · ${escapeHTML(strategy)}` : "";
  // Entry thesis captured at deploy (llm-verdicts extractDeployConfidence →
  // state.attachDeployVerdicts). Mechanical exits run without an LLM, so there is
  // no exit prose to show — pairing the original "why we entered" with the
  // now-quantitative exit rule closes the loop at zero extra LLM cost.
  const thesisLine = thesis
    ? `\n💡 Entered: ${escapeHTML(String(thesis).slice(0, 300))}${confidence != null ? ` <i>(conf ${confidence})</i>` : ""}`
    : "";
  const links = [
    pool ? `<a href="${meteoraPool(pool)}">pool</a>` : null,
    tx ? `<a href="${solscanTx(tx)}">tx</a>` : null,
  ].filter(Boolean).join(" · ");
  await sendHTML(
    `🏁 <b>Closed</b> ${escapeHTML(pair)}\n` +
    `PnL: ${outcomeEmoji} ${sign}${fmtSolUsd(pnlSol ?? 0, pnlUsd)} (${pctSign}${(pnlPct ?? 0).toFixed(2)}%)\n` +
    `Deployed: ◎${(deployedSol ?? 0).toFixed(4)} → Received: ◎${receivedSol.toFixed(4)}\n` +
    `Fees: ${fmtSolUsd(feesSol ?? 0, feesUsd)} · ⏱️ ${fmtDuration(holdTime)}${gasStr}${stratStr}` +
    peakLine +
    thesisLine +
    `\nReason: ${escapeHTML(reason || "agent decision")}` +
    (links ? `\n🔗 ${links}` : "")
  );
}

/**
 * Swap notification. `valueSol`/`valueUsd` add value context (what the output
 * is worth); `slippageUsd`/`slippagePct` surface exit-swap cost vs the
 * pre-swap market quote when the caller has it (auto-swap after close does).
 */
export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx, valueSol, valueUsd, slippageUsd, slippagePct }) {
  if (hasActiveLiveMessage()) return;
  const valueLine = valueSol != null || valueUsd != null
    ? `\nValue: ${fmtSolUsd(valueSol ?? 0, valueUsd)}`
    : "";
  const slipLine = slippageUsd != null
    ? `\nSlippage vs quote: ${slippageUsd >= 0 ? "-" : "+"}$${Math.abs(slippageUsd).toFixed(2)}${slippagePct != null ? ` (${Math.abs(slippagePct).toFixed(2)}%)` : ""}`
    : "";
  await sendHTML(
    `🔄 <b>Swapped</b> ${escapeHTML(inputSymbol)} → ${escapeHTML(outputSymbol)}\n` +
    `In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}` +
    valueLine + slipLine +
    (tx ? `\n🔗 <a href="${solscanTx(tx)}">tx</a>` : "")
  );
}

/**
 * OOR alert. `pnlPct`/`valueSol`/`valueUsd` (optional) let the reader judge
 * severity at a glance — a -1% OOR-above drift and a -12% OOR-below break
 * read very differently. Direction emoji: 📉 below (risk) / 📈 above (profit ran).
 */
export async function notifyOutOfRange({ pair, minutesOOR, direction, binDistance, limitMinutes, pool, pnlPct, valueSol, valueUsd, holdMode = false }) {
  if (hasActiveLiveMessage()) return;
  const dirEmoji = direction === "Below" ? "📉" : direction === "Above" ? "📈" : "⚠️";
  const dirStr = direction ? ` (${direction}${binDistance != null ? `, ${binDistance} bins` : ""})` : "";
  const autoClose = holdMode
    ? " · auto-close disabled (On Hold)"
    : limitMinutes ? ` · auto-close at ${fmtDuration(minutesOOR)}/${fmtDuration(limitMinutes)}` : "";
  const posLine = pnlPct != null || valueSol != null
    ? `\n${pnlPct != null ? `PnL: ${pnlPct >= 0 ? "+" : ""}${Number(pnlPct).toFixed(2)}%` : ""}${pnlPct != null && valueSol != null ? " · " : ""}${valueSol != null ? `value: ${fmtSolUsd(valueSol, valueUsd)}` : ""}`
    : "";
  const link = pool ? `\n🔗 <a href="${meteoraPool(pool)}">pool</a>` : "";
  await sendHTML(
    `${dirEmoji} <b>Out of Range${dirStr}</b> ${escapeHTML(pair)}\n` +
    `OOR for ${fmtDuration(minutesOOR)}${autoClose}` + posLine + link
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

// Human-readable duration from minutes: 47 → "47m", 407 → "6h 47m", 1500 → "1d 1h".
export function fmtDuration(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24), rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

// Deep-link helpers (Telegram renders inline <a href> links).
export const solscanTx = (tx) => (tx ? `https://solscan.io/tx/${tx}` : null);
export const solscanAcct = (addr) => (addr ? `https://solscan.io/account/${addr}` : null);
export const meteoraPool = (pool) => (pool ? `https://app.meteora.ag/dlmm/${pool}` : null);

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
