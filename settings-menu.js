/**
 * Telegram /settings menu (moved out of index.js 2026-11-28 so it can be tested).
 *
 * Pages: main, risk, strategy, screen, tvl. Every item and its explanation lives in ONE table,
 * settings-help.js (SETTINGS_HELP). Every change goes through `update_config` (tools/executor.js,
 * its validators and its persistence) via the injected `executeTool` — this module never writes
 * config itself.
 *
 * Callback data (unchanged from the index.js version, so buttons on menu messages already in the
 * chat keep working): cfg:page:<page> · cfg:toggle:<key> · cfg:input:<key> · cfg:set:<key>:<value>
 * · cfg:step:<key>:<delta> · cfg:noop · cfg:show · cfg:close. New: cfg:page:tvl and
 * cfg:help:<page>. An unknown page renders Main; an unknown action or key answers
 * "Menu outdated — reopen /settings" and changes nothing.
 *
 * Messages are HTML: every dynamic piece goes through escapeHTML exactly once, and the send
 * layer (telegram.js prepareText → sanitizeTelegramHTML, which leaves entities alone) does the rest.
 */

import { config } from "./config.js";
import { escapeHTML } from "./telegram.js";
import { tvlFloorExitConfig } from "./tvl-floor-exit.js";
import { tvlFloorDistressConfig } from "./tvl-floor-distress.js";
import { SETTINGS_HELP, SETTINGS_PAGES, settingHelp } from "./settings-help.js";

export const MENU_OUTDATED = "Menu outdated — reopen /settings";
export const NO_DESCRIPTION = "No description yet.";
/** A ✏ prompt expires after this long; the next text is then an ordinary message. */
export const PENDING_INPUT_TTL_MS = 5 * 60_000;
const TELEGRAM_TEXT_LIMIT = 4096;
const HELP_CHUNK_LIMIT = 3800; // leave room under 4096 for the send layer

// Test hook: replace the help table (to prove a page item without an entry still renders).
let _helpOverride = null;
export function setHelpTableForTest(table) { _helpOverride = table && typeof table === "object" ? table : null; }
function helpOf(key) {
  if (!_helpOverride) return settingHelp(key);
  return Object.prototype.hasOwnProperty.call(_helpOverride, key) ? _helpOverride[key] : null;
}

// ─── Values ────────────────────────────────────────────────────────────────

/** The effective value of a menu key (what the code that reads it would use). */
export function settingValue(key, cfg = config) {
  const m = cfg.management || {};
  switch (key) {
    case "tvlFloorExitMode": return tvlFloorExitConfig(m).mode;
    case "tvlFloorExitUsd": return tvlFloorExitConfig(m).floorUsd;
    case "tvlFloorExitMinReadings": return tvlFloorExitConfig(m).minReadings;
    case "tvlFloorExitMinMinutes": return tvlFloorExitConfig(m).minMinutes;
    case "tvlFloorExitDistressMode": return tvlFloorDistressConfig(m, { warn: null }).mode;
    case "tvlFloorExitLossPct": return tvlFloorDistressConfig(m, { warn: null }).lossPct;
    case "tvlFloorExitPriceDropPct": return tvlFloorDistressConfig(m, { warn: null }).priceDropPct;
    case "tvlFloorExitDumpTurnover": return tvlFloorDistressConfig(m, { warn: null }).dumpTurnover;
    case "tvlFloorExitDumpPricePct": return tvlFloorDistressConfig(m, { warn: null }).dumpPricePct;
    default: break;
  }
  const values = {
    solMode: m.solMode,
    trailingTakeProfit: m.trailingTakeProfit,
    blockPvpSymbols: cfg.screening?.blockPvpSymbols,
    topPerformersEnabled: cfg.screening?.topPerformersEnabled,
    topPerformersLimit: cfg.screening?.topPerformersLimit,
    topPerformersMinTvl: cfg.screening?.topPerformersMinTvl,
    topPerformersRequireTrend: cfg.screening?.topPerformersRequireTrend,
    topPerformerTrendTimeframe: cfg.screening?.topPerformerTrendTimeframe,
    topPerformerTrendCandles: cfg.screening?.topPerformerTrendCandles,
    strategy: cfg.strategy?.strategy,
    minBinsBelow: cfg.strategy?.minBinsBelow,
    maxBinsBelow: cfg.strategy?.maxBinsBelow,
    rebalanceMaxCount: m.rebalanceMaxCount,
    rebalanceBinsBelow: m.rebalanceBinsBelow,
    rebalanceBinsAbove: m.rebalanceBinsAbove,
    minTxPerMin: cfg.screening?.minTxPerMin,
    minVolumeTvlRatio: cfg.screening?.minVolumeTvlRatio,
    toxicConversionEnabled: m.toxicConversionEnabled,
    toxicConversionThresholdPct: m.toxicConversionThresholdPct,
    deployAmountSol: m.deployAmountSol,
    gasReserve: m.gasReserve,
    maxPositions: cfg.risk?.maxPositions,
    maxPositionsExcludeHold: cfg.risk?.maxPositionsExcludeHold,
    maxDeployAmount: cfg.risk?.maxDeployAmount,
    takeProfitPct: m.takeProfitPct,
    stopLossPct: m.stopLossPct,
    trailingTriggerPct: m.trailingTriggerPct,
    trailingDropPct: m.trailingDropPct,
    trailingMinPnlPct: m.trailingMinPnlPct,
    trailingOvershootPct: m.trailingOvershootPct,
    managementIntervalMin: cfg.schedule?.managementIntervalMin,
    screeningIntervalMin: cfg.schedule?.screeningIntervalMin,
  };
  return values[key];
}

function trimNumber(n, digits = 2) {
  return String(parseFloat(Number(n).toFixed(digits)));
}

/** Value as shown on a button (no unit; "off" for null, as before). */
export function fmtButtonValue(key, value) {
  const entry = helpOf(key) || {};
  if (value == null) return "off";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "number" || (value !== "" && Number.isFinite(Number(value)))) {
    const n = Number(value);
    if (entry.unit === "$") return `$${Math.round(n).toLocaleString("en-US")}`;
    return trimNumber(n, entry.digits ?? 2);
  }
  return String(value);
}

/** Value with its unit, as shown in prompts, notes and the Help message. Plain text. */
export function fmtValueWithUnit(key, value) {
  const entry = helpOf(key) || {};
  if (value == null) return "off";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number" || (value !== "" && Number.isFinite(Number(value)))) {
    const n = Number(value);
    if (entry.unit === "$") return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    const shown = trimNumber(n, Math.max(entry.digits ?? 2, 2));
    if (!entry.unit) return shown;
    if (entry.unit === "%") return `${shown} %`;
    return `${shown} ${entry.unit}`;
  }
  return String(value);
}

/**
 * The stored value (what update_config last wrote / config.js loaded), used to tell a no-op tap:
 * for the TVL keys the effective value can differ from the stored one (an invalid stored mode
 * reads as shadow), and tapping "shadow" then must still write.
 */
export function storedSettingValue(key, cfg = config) {
  if (String(key).startsWith("tvlFloorExit")) return cfg.management?.[key];
  return settingValue(key, cfg);
}

// ─── Rendering ─────────────────────────────────────────────────────────────

const btn = (text, data) => ({ text, callback_data: data });

/**
 * The help entry, or — for a key a page renders without one (a test fails on that) — a stand-in
 * so the menu still renders and the item still works: key as label, "No description yet.".
 */
function entryFor(key, kind = "number", choices = null, page = "main") {
  return helpOf(key) || {
    label: key, kind, choices, help: NO_DESCRIPTION, accepts: kind === "toggle" ? "tap to switch on / off" : "see the code",
    page, missing: true,
  };
}

function toggleButton(key, cfg) {
  const e = entryFor(key, "toggle");
  return btn(`${e.label}: ${fmtButtonValue(key, settingValue(key, cfg))}`, `cfg:toggle:${key}`);
}

function inputButton(key, cfg) {
  const e = entryFor(key, "number");
  return btn(`${e.label}: ${fmtButtonValue(key, settingValue(key, cfg))} ✏`, `cfg:input:${key}`);
}

function choiceRow(key, cfg) {
  const e = entryFor(key, "choice");
  const current = settingValue(key, cfg);
  // No entry (so no choices known): one inert button that still names the key.
  if (!Array.isArray(e.choices) || !e.choices.length) return [btn(`${key}: ${fmtButtonValue(key, current)}`, `cfg:noop:${key}`)];
  return e.choices.map((c) => btn(`${e.button ? `${e.button}: ` : ""}${c}${c === current ? " ✓" : ""}`, `cfg:set:${key}:${c}`));
}

/** The item rows of a page (no navigation / footer). Unknown page → main. */
function pageRows(page, cfg) {
  const i = (k) => [inputButton(k, cfg)];
  const t = (k) => [toggleButton(k, cfg)];
  switch (page) {
    case "risk":
      return [
        i("deployAmountSol"),
        i("gasReserve"),
        i("maxPositions"),
        t("maxPositionsExcludeHold"),
        i("maxDeployAmount"),
        i("takeProfitPct"),
        i("stopLossPct"),
        t("trailingTakeProfit"),
        i("trailingTriggerPct"),
        i("trailingDropPct"),
        i("trailingMinPnlPct"),
        i("trailingOvershootPct"),
        t("toxicConversionEnabled"),
        i("toxicConversionThresholdPct"),
      ];
    case "screen":
      return [
        [toggleButton("topPerformersEnabled", cfg), toggleButton("topPerformersRequireTrend", cfg)],
        choiceRow("topPerformerTrendTimeframe", cfg),
        [inputButton("topPerformersMinTvl", cfg), inputButton("topPerformersLimit", cfg)],
        i("topPerformerTrendCandles"),
        [inputButton("minTxPerMin", cfg), inputButton("minVolumeTvlRatio", cfg)],
        t("blockPvpSymbols"),
        i("managementIntervalMin"),
        i("screeningIntervalMin"),
      ];
    case "strategy":
      return [
        choiceRow("strategy", cfg),
        i("minBinsBelow"),
        i("maxBinsBelow"),
        i("rebalanceMaxCount"),
        [inputButton("rebalanceBinsBelow", cfg), inputButton("rebalanceBinsAbove", cfg)],
      ];
    case "tvl":
      return [
        choiceRow("tvlFloorExitMode", cfg),
        choiceRow("tvlFloorExitDistressMode", cfg),
        i("tvlFloorExitUsd"),
        [inputButton("tvlFloorExitMinReadings", cfg), inputButton("tvlFloorExitMinMinutes", cfg)],
        i("tvlFloorExitLossPct"),
        i("tvlFloorExitPriceDropPct"),
        [inputButton("tvlFloorExitDumpTurnover", cfg), inputButton("tvlFloorExitDumpPricePct", cfg)],
      ];
    default:
      return [
        t("solMode"),
        t("trailingTakeProfit"),
        [btn("Risk / deploy", "cfg:page:risk"), btn("Screening", "cfg:page:screen")],
        [btn("Show config", "cfg:show")],
      ];
  }
}

/** The page whose rows render `key` (first match), else "main". */
function pageOfKey(key) {
  for (const page of Object.keys(SETTINGS_PAGES)) {
    for (const row of pageRows(page, config)) {
      for (const b of row) if (new RegExp(`^cfg:(?:toggle|input|set|step|noop):${key}(?::|$)`).test(b.callback_data)) return page;
    }
  }
  return "main";
}

/** The rendered buttons for `key` on any page (used to rebuild a stand-in entry). */
function renderedButtonsFor(key, cfg = config) {
  const out = [];
  for (const page of Object.keys(SETTINGS_PAGES)) {
    for (const row of pageRows(page, cfg)) {
      for (const b of row) if (new RegExp(`^cfg:(?:toggle|input|set|step|noop):${key}(?::|$)`).test(b.callback_data)) out.push(b.callback_data);
    }
  }
  return out;
}

/** Entry for a callback: the table entry, or a stand-in for a key a page renders without one. */
function entryForCallback(key, cfg) {
  const e = helpOf(key);
  if (e) return e;
  const datas = renderedButtonsFor(key, cfg);
  if (!datas.length) return null;
  const page = pageOfKey(key);
  if (datas.some((d) => d.startsWith("cfg:toggle:"))) return entryFor(key, "toggle", null, page);
  const choices = datas.filter((d) => d.startsWith("cfg:set:")).map((d) => d.split(":").slice(3).join(":"));
  if (choices.length) return entryFor(key, "choice", choices, page);
  return entryFor(key, "number", null, page);
}

export function normalizePage(page) {
  return Object.prototype.hasOwnProperty.call(SETTINGS_PAGES, page) ? page : "main";
}

/** The config keys reachable from a page's buttons, in display order (each once). */
export function menuKeysOnPage(page, cfg = config) {
  const keys = [];
  for (const row of pageRows(normalizePage(page), cfg)) {
    for (const b of row) {
      const m = /^cfg:(?:toggle|input|set|step|noop):([^:]+)/.exec(b.callback_data);
      if (m && !keys.includes(m[1])) keys.push(m[1]);
    }
  }
  return keys;
}

/** Keys a page renders that have no entry in settings-help.js (should be empty). */
export function menuKeysWithoutHelp(cfg = config) {
  return allMenuKeys(cfg).filter((k) => !helpOf(k));
}

/** Every config key reachable from any page. */
export function allMenuKeys(cfg = config) {
  const keys = new Set();
  for (const page of Object.keys(SETTINGS_PAGES)) for (const k of menuKeysOnPage(page, cfg)) keys.add(k);
  return [...keys];
}

function summaryLines(cfg) {
  const s = cfg.screening || {};
  const m = cfg.management || {};
  const r = cfg.risk || {};
  const tvl = tvlFloorExitConfig(m);
  const d = tvlFloorDistressConfig(m, { warn: null });
  return [
    `Mode: ${m.solMode ? "SOL" : "USD"}`,
    `Screening: Top Performers ${s.topPerformersEnabled === false ? "off" : "on"} (limit ${s.topPerformersLimit ?? 10})`,
    `Strategy: ${cfg.strategy?.strategy}`,
    `Deploy: ${m.deployAmountSol} SOL | Max Pos: ${r.maxPositions}${r.maxPositionsExcludeHold ? " (excl HOLD)" : ""}`,
    `TP/SL: ${m.takeProfitPct}% / ${m.stopLossPct}% | trailing ${m.trailingTakeProfit ? "on" : "off"}`,
    `TVL exit: ${tvl.mode} · distress gate ${d.mode} · min $${Math.round(tvl.floorUsd).toLocaleString("en-US")}`,
  ];
}

/**
 * The menu message for a page: { text (HTML), keyboard }. `note` is an HTML line shown under the
 * summary (already escaped — build it with changeNote()).
 */
export function renderSettingsMenu(page = "main", { cfg = config, note = null } = {}) {
  const p = normalizePage(page);
  const title = p === "main" ? "Settings menu" : `Settings: ${SETTINGS_PAGES[p]}`;
  const lines = [`<b>${escapeHTML(title)}</b>`, "", ...summaryLines(cfg).map(escapeHTML)];
  if (note) lines.push("", note);
  lines.push("", "<i>✏ = tap to edit (the prompt explains the setting) · ℹ️ Help explains every item on this page.</i>");

  const nav = [
    [btn("Main", "cfg:page:main"), btn("Risk", "cfg:page:risk"), btn("Strategy", "cfg:page:strategy")],
    [btn("Screen", "cfg:page:screen"), btn("TVL exit", "cfg:page:tvl")],
  ];
  const footer = [[btn("Refresh", `cfg:page:${p}`), btn("ℹ️ Help", `cfg:help:${p}`), btn("Close", "cfg:close")]];
  return { text: lines.join("\n"), keyboard: [...nav, ...pageRows(p, cfg), ...footer] };
}

// ─── Texts ─────────────────────────────────────────────────────────────────

/** "Send the new value…" instruction for an ✏ item. Plain text. */
function inputInstruction(entry) {
  return entry.nullable
    ? `Send the new value as your next message, "off" to clear it, or "cancel".`
    : `Send the new value as your next message, or "cancel".`;
}

/** The ✏ prompt: label + key, current value, explanation, accepted input, instruction. HTML. */
export function buildInputPrompt(key, cfg = config) {
  const e = entryForCallback(key, cfg);
  if (!e) return escapeHTML(MENU_OUTDATED);
  return [
    `✏️ <b>${escapeHTML(e.label)}</b> (<code>${escapeHTML(key)}</code>)`,
    `Current: <b>${escapeHTML(fmtValueWithUnit(key, settingValue(key, cfg)))}</b>`,
    "",
    escapeHTML(e.help),
    "",
    `<i>Accepted: ${escapeHTML(e.accepts)}.</i>`,
    escapeHTML(inputInstruction(e)),
  ].join("\n");
}

/** Header note after a toggle / choice tap: the new value and the item's explanation. HTML. */
export function changeNote(key, cfg = config, { withHelp = true } = {}) {
  const e = entryForCallback(key, cfg);
  if (!e) return null;
  const head = `${withHelp ? "ℹ️" : "✅"} <b>${escapeHTML(e.label)}</b> is now <b>${escapeHTML(fmtValueWithUnit(key, settingValue(key, cfg)))}</b>`;
  return withHelp ? `${head}\n${escapeHTML(e.help)}` : head;
}

function helpBlock(key, cfg) {
  const e = entryForCallback(key, cfg);
  return [
    `<b>${escapeHTML(e.label)}</b> (<code>${escapeHTML(key)}</code>) — now <b>${escapeHTML(fmtValueWithUnit(key, settingValue(key, cfg)))}</b>`,
    escapeHTML(e.help),
    `<i>Accepted: ${escapeHTML(e.accepts)}.</i>`,
  ].join("\n");
}

/** The page's Help message(s): every item on the page with its explanation, each part ≤ 4096. */
export function buildPageHelp(page, cfg = config) {
  const p = normalizePage(page);
  const header = `ℹ️ <b>Help — ${escapeHTML(SETTINGS_PAGES[p])}</b>`;
  const blocks = menuKeysOnPage(p, cfg).map((k) => helpBlock(k, cfg));
  const parts = [];
  let cur = header;
  for (const b of blocks) {
    const next = `${cur}\n\n${b}`;
    if (next.length > HELP_CHUNK_LIMIT && cur !== header) {
      parts.push(cur);
      cur = `${header} <i>(continued)</i>\n\n${b}`;
    } else {
      cur = next;
    }
  }
  parts.push(cur);
  return parts.map((t) => (t.length > TELEGRAM_TEXT_LIMIT ? t.slice(0, TELEGRAM_TEXT_LIMIT) : t));
}

// ─── Input parsing ─────────────────────────────────────────────────────────

/**
 * Parse an ✏ reply for `key`. → { ok: true, value } | { ok: false, error } | { cancel: true }.
 * Only the menu-side checks of the help table are applied here; update_config's own validators
 * run when the value is sent.
 */
export function normalizeTypedValue(raw) {
  // Phones type U+2212 (−), U+2013 (–) or U+2014 (—) for a minus; the parser wants ASCII "-".
  return String(raw ?? "").replace(/[\u2212\u2013\u2014]/g, "-").trim();
}

export function parseMenuInput(key, raw, cfg = config) {
  const e = entryForCallback(key, cfg);
  if (!e) return { ok: false, error: MENU_OUTDATED };
  const text = normalizeTypedValue(raw);
  if (/^cancel$/i.test(text)) return { cancel: true };
  if (e.kind === "choice") {
    const v = text.toLowerCase();
    return e.choices.includes(v) ? { ok: true, value: v } : { ok: false, error: `"${text}" is not one of ${e.choices.join(" / ")}` };
  }
  if (e.kind === "toggle") {
    if (/^(on|true|yes)$/i.test(text)) return { ok: true, value: true };
    if (/^(off|false|no)$/i.test(text)) return { ok: true, value: false };
    return { ok: false, error: `"${text}" is not on / off` };
  }
  if (/^(off|null)$/i.test(text)) {
    return e.nullable ? { ok: true, value: null } : { ok: false, error: `"off" is not accepted for this setting` };
  }
  // Plain decimal numbers only (no commas, hex or exponents: "1,5" must not become 15).
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return { ok: false, error: `"${text}" is not a plain number` };
  const value = Number(text);
  if (!Number.isFinite(value)) return { ok: false, error: `"${text}" is not a number` };
  return checkNumber(e, value, text);
}

function checkNumber(e, value, shown = String(value)) {
  const c = e.check;
  if (!c) return { ok: true, value };
  if (c.integer && !Number.isInteger(value)) return { ok: false, error: `${shown} is not a whole number` };
  if (c.min != null && (c.minExclusive ? !(value > c.min) : !(value >= c.min))) return { ok: false, error: `${shown} is out of range` };
  if (c.max != null && (c.maxExclusive ? !(value < c.max) : !(value <= c.max))) return { ok: false, error: `${shown} is out of range` };
  return { ok: true, value };
}

function refusedText(key, detail) {
  const e = entryForCallback(key, config);
  return `❌ <b>${escapeHTML(e.label)}</b> (<code>${escapeHTML(key)}</code>) not changed: ${escapeHTML(detail)}.\n<i>Accepted: ${escapeHTML(e.accepts)}.</i> Tap ✏ again to retry.`;
}

/** Send one change through update_config. → { ok, value? , refusal? } */
async function applyChange(key, value, deps, reason) {
  const result = await deps.executeTool("update_config", { changes: { [key]: value }, reason });
  if (!result?.success) {
    const err = result?.error ? `update_config refused it (${result.error})` : `update_config refused ${key} = ${JSON.stringify(value)}`;
    return { ok: false, refusal: err };
  }
  return { ok: true };
}

// ─── Pending ✏ prompt ──────────────────────────────────────────────────────

/** The pending-input record set when a ✏ prompt is sent. */
export function makePendingInput(key, page, menuMsgId, nowMs = Date.now()) {
  return { key, page, menuMsgId, createdAt: nowMs, promptMessageId: null };
}

/**
 * Is a text message the reply to the pending ✏ prompt?
 *   "accept"  — arrived after the prompt, within PENDING_INPUT_TTL_MS
 *   "expired" — the prompt is older than the TTL: drop it, treat the text as a normal message
 *   "stale"   — the text was sent BEFORE the prompt (e.g. queued while the bot was busy):
 *               keep the prompt, treat the text as a normal message
 * Order is decided by Telegram message ids when both are known (ids grow per chat, bot messages
 * included), else by the message date (Telegram `date`, seconds) against the prompt's time.
 */
export function pendingInputVerdict(pending, msg, nowMs = Date.now()) {
  if (!pending) return "stale";
  const createdAt = Number(pending.createdAt);
  if (Number.isFinite(createdAt) && nowMs - createdAt > PENDING_INPUT_TTL_MS) return "expired";
  const promptId = Number(pending.promptMessageId);
  const msgId = Number(msg?.message_id);
  if (Number.isFinite(promptId) && promptId > 0 && Number.isFinite(msgId) && msgId > 0) {
    return msgId > promptId ? "accept" : "stale";
  }
  const dateSec = Number(msg?.date);
  if (Number.isFinite(dateSec) && dateSec > 0 && Number.isFinite(createdAt)) {
    // Telegram dates are whole seconds: a message from the prompt's own second counts as after it.
    return dateSec * 1000 >= Math.floor(createdAt / 1000) * 1000 ? "accept" : "stale";
  }
  return "accept"; // nothing to compare (not a Telegram message)
}

// ─── Handlers ──────────────────────────────────────────────────────────────

/**
 * deps: { executeTool, answerCallbackQuery, sendHTML, sendHTMLWithButtons, editHTMLWithButtons,
 *         editMessage, formatConfigSnapshot, setPendingInput, clearPendingInput, cfg?, now? }
 */
export async function showSettingsMenu(deps, { messageId = null, page = "main", note = null } = {}) {
  const menu = renderSettingsMenu(page, { cfg: deps.cfg || config, note });
  if (messageId) return deps.editHTMLWithButtons(menu.text, messageId, menu.keyboard);
  return deps.sendHTMLWithButtons(menu.text, menu.keyboard);
}

const sameValue = (a, b) => (a === b) || (a != null && b != null && typeof a !== "boolean" && typeof b !== "boolean" && Number(a) === Number(b) && Number.isFinite(Number(a)));

export async function handleSettingsCallback(msg, deps) {
  const cfg = deps.cfg || config;
  const now = typeof deps.now === "function" ? deps.now() : Date.now();
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  const answer = (text = "") => deps.answerCallbackQuery(msg.callbackQueryId, text);
  // Any menu action other than a no-op or reading Help ends a pending ✏ prompt (tapping
  // ✏ again sets a fresh one below).
  if (action !== "noop" && action !== "help" && typeof deps.clearPendingInput === "function") deps.clearPendingInput();

  if (action === "noop") return answer();
  if (action === "close") {
    await answer("Closed");
    return deps.editMessage("Settings menu closed.", msg.messageId);
  }
  if (action === "show") {
    await answer();
    return deps.editHTMLWithButtons(deps.formatConfigSnapshot(), msg.messageId, [[btn("Back", "cfg:page:main")]]);
  }
  if (action === "page") {
    await answer();
    return showSettingsMenu(deps, { messageId: msg.messageId, page: parts[2] || "main" });
  }
  if (action === "help") {
    await answer();
    for (const part of buildPageHelp(parts[2] || "main", cfg)) await deps.sendHTML(part);
    return;
  }

  const key = parts[2];
  const entry = key ? entryForCallback(key, cfg) : null;
  if (!entry || !["toggle", "input", "set", "step"].includes(action)) return answer(MENU_OUTDATED);

  if (action === "input") {
    if (entry.kind !== "number") return answer(MENU_OUTDATED);
    const pending = makePendingInput(key, entry.page, msg.messageId, now);
    deps.setPendingInput(pending);
    await answer();
    const sent = await deps.sendHTML(buildInputPrompt(key, cfg));
    const promptId = sent?.result?.message_id;
    if (promptId != null) deps.setPendingInput({ ...pending, promptMessageId: promptId });
    return;
  }

  let value;
  if (action === "toggle") {
    if (entry.kind !== "toggle") return answer(MENU_OUTDATED);
    value = !Boolean(settingValue(key, cfg));
  } else if (action === "set") {
    if (entry.kind !== "choice") return answer(MENU_OUTDATED);
    value = parts.slice(3).join(":");
    if (!entry.choices.includes(value)) return answer(MENU_OUTDATED);
  } else {
    // step (no current page renders step buttons; kept so an old message's button still works)
    if (entry.kind !== "number") return answer(MENU_OUTDATED);
    const current = Number(settingValue(key, cfg));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) return answer(MENU_OUTDATED);
    const checked = checkNumber(entry, Number((current + delta).toFixed(4)));
    if (!checked.ok) return answer(`${entry.label}: ${checked.error}`);
    value = checked.value;
  }

  // A tap on the value already set writes nothing (no update_config call, no identical edit).
  if (sameValue(storedSettingValue(key, cfg), value) && sameValue(settingValue(key, cfg), value)) {
    return answer(`${entry.label}: already ${fmtValueWithUnit(key, value)}`);
  }

  const res = await applyChange(key, value, deps, "Telegram settings menu");
  if (!res.ok) {
    await answer(`${entry.label} not changed — ${res.refusal}`);
    return;
  }
  await answer(`${entry.label}: ${fmtValueWithUnit(key, settingValue(key, cfg))}`);
  return showSettingsMenu(deps, {
    messageId: msg.messageId,
    page: entry.page,
    note: changeNote(key, cfg, { withHelp: entry.kind !== "number" }),
  });
}

/** The reply to an ✏ prompt. `pending` = { key, page, menuMsgId, … }. The caller has checked pendingInputVerdict. */
export async function handleSettingsInput(pending, text, deps) {
  const cfg = deps.cfg || config;
  const { key, menuMsgId } = pending || {};
  const entry = key ? entryForCallback(key, cfg) : null;
  if (!entry) return deps.sendHTML(escapeHTML(MENU_OUTDATED));
  const parsed = parseMenuInput(key, text, cfg);
  if (parsed.cancel) return deps.sendHTML(`Cancelled — <b>${escapeHTML(entry.label)}</b> unchanged.`);
  if (!parsed.ok) return deps.sendHTML(refusedText(key, parsed.error));
  if (sameValue(storedSettingValue(key, cfg), parsed.value) && sameValue(settingValue(key, cfg), parsed.value)) {
    return deps.sendHTML(`<b>${escapeHTML(entry.label)}</b> is already <b>${escapeHTML(fmtValueWithUnit(key, parsed.value))}</b> — nothing changed.`);
  }
  const res = await applyChange(key, parsed.value, deps, "Telegram input field");
  if (!res.ok) return deps.sendHTML(refusedText(key, res.refusal));
  const note = changeNote(key, cfg, { withHelp: false });
  await deps.sendHTML(`${note}.`);
  return showSettingsMenu(deps, { messageId: menuMsgId, page: entry.page, note });
}
