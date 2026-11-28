// Telegram /settings menu: one help table (settings-help.js) for every item, the ✏ prompt format,
// toggle explanations, the TVL-exit page, every change through update_config, HTML safety and
// message length. Run through `npm run test:unit -- settings-menu-help` (the runner gives it a
// fresh MERIDIAN_DATA_DIR, so update_config writes a temp user-config.json).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";

process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

const { config } = await import("../config.js");
const { executeTool } = await import("../tools/executor.js");
const { sanitizeTelegramHTML, escapeHTML } = await import("../telegram.js");
const { dataPath } = await import("../repo-root.js");
const { SETTINGS_HELP, SETTINGS_PAGES, settingHelp } = await import("../settings-help.js");
const { isValidTvlDistressValue, tvlDistressRangeText, TVL_DISTRESS_NUMERIC_KEYS } = await import("../tvl-floor-distress.js");
const menu = await import("../settings-menu.js");

const TVL_KEYS = [
  "tvlFloorExitMode", "tvlFloorExitDistressMode", "tvlFloorExitUsd", "tvlFloorExitMinReadings",
  "tvlFloorExitMinMinutes", "tvlFloorExitLossPct", "tvlFloorExitPriceDropPct",
  "tvlFloorExitDumpTurnover", "tvlFloorExitDumpPricePct",
];

let _nextMsgId = 1000;
function fakeDeps() {
  const calls = { answers: [], sendHTML: [], edits: [], sends: [], editMessage: [], pending: null, cleared: 0, updates: 0 };
  const deps = {
    executeTool: async (name, args) => { if (name === "update_config") calls.updates++; return executeTool(name, args); },
    answerCallbackQuery: async (_id, text = "") => { calls.answers.push(text); },
    sendHTML: async (html) => { calls.sendHTML.push(html); return { ok: true, result: { message_id: ++_nextMsgId } }; },
    sendHTMLWithButtons: async (html, kb) => { calls.sends.push({ html, kb }); },
    editHTMLWithButtons: async (html, id, kb) => { calls.edits.push({ html, id, kb }); },
    editMessage: async (text, id) => { calls.editMessage.push({ text, id }); },
    formatConfigSnapshot: () => "<b>snapshot</b>",
    setPendingInput: (p) => { calls.pending = p; },
    clearPendingInput: () => { calls.cleared++; calls.pending = null; },
  };
  return { deps, calls };
}
const cb = (data) => ({ callbackData: data, callbackQueryId: "q1", messageId: 42, isCallback: true });
const readUserConfig = () => JSON.parse(fs.readFileSync(dataPath("user-config.json"), "utf8"));
const allButtons = (kb) => kb.flat();

test("every menu item has a help entry, and every help entry is on a page", () => {
  const missing = menu.menuKeysWithoutHelp();
  assert.deepEqual(missing, [], `menu keys without an entry in settings-help.js: ${missing.join(", ")}`);
  const reachable = menu.allMenuKeys();
  assert.ok(reachable.length >= 40, `expected the full menu, got ${reachable.length} keys`);
  for (const key of reachable) {
    const e = settingHelp(key);
    assert.ok(e, `menu key ${key} has no entry in settings-help.js`);
    assert.ok(typeof e.label === "string" && e.label.trim(), `${key}: empty label`);
    assert.ok(typeof e.help === "string" && e.help.trim().length >= 40, `${key}: empty / too short help`);
    assert.ok(typeof e.accepts === "string" && e.accepts.trim(), `${key}: empty accepts`);
    assert.ok(e.help.length <= 450, `${key}: help is ${e.help.length} chars — keep it to 1–3 short sentences`);
    assert.ok(["number", "toggle", "choice"].includes(e.kind), `${key}: kind`);
  }
  for (const [key, e] of Object.entries(SETTINGS_HELP)) {
    assert.ok(reachable.includes(key), `help entry ${key} is not reachable from any menu page`);
    assert.ok(Object.prototype.hasOwnProperty.call(SETTINGS_PAGES, e.page), `${key}: unknown page ${e.page}`);
    assert.ok(menu.menuKeysOnPage(e.page).includes(key), `${key}: not rendered on its own page ${e.page}`);
    if (e.kind === "choice") assert.ok(Array.isArray(e.choices) && e.choices.length >= 2, `${key}: choices`);
  }
  // Every page renders the help button; every callback is ≤ 64 bytes (Telegram's limit).
  for (const page of Object.keys(SETTINGS_PAGES)) {
    const { keyboard } = menu.renderSettingsMenu(page);
    assert.ok(allButtons(keyboard).some((b) => b.callback_data === `cfg:help:${page}`), `${page}: Help button`);
    for (const b of allButtons(keyboard)) assert.ok(Buffer.byteLength(b.callback_data) <= 64, b.callback_data);
  }
});

test("✏ prompt: label, key, current value, explanation, accepted input, instruction", () => {
  const p = menu.buildInputPrompt("deployAmountSol");
  assert.match(p, /^✏️ <b>Deploy SOL<\/b> \(<code>deployAmountSol<\/code>\)\n/);
  assert.match(p, new RegExp(`Current: <b>${config.management.deployAmountSol} SOL</b>`));
  assert.ok(p.includes(escapeHTML(SETTINGS_HELP.deployAmountSol.help)));
  assert.match(p, /<i>Accepted: a number of SOL above 0\.<\/i>/);
  assert.ok(!p.includes('"off" to clear'), "deployAmountSol does not accept off");
  assert.ok(!p.includes("Send a number, or"), "old wording gone");

  const floor = menu.buildInputPrompt("trailingMinPnlPct");
  assert.ok(floor.includes('"off" to clear'), "the trail floor really accepts off");
  // Only nullable items say "off" to clear.
  for (const [key, e] of Object.entries(SETTINGS_HELP)) {
    if (e.kind !== "number") continue;
    const prompt = menu.buildInputPrompt(key);
    assert.equal(prompt.includes('"off" to clear'), e.nullable === true, `${key}: off wording`);
    assert.ok(prompt.length <= 4096, `${key}: prompt ${prompt.length} chars`);
  }
});

test("HTML: every text is escaped exactly once and survives the send layer unchanged", () => {
  const raw = "PnL < 1 % & price ≤ entry";
  const once = escapeHTML(raw);
  assert.equal(once, "PnL &lt; 1 % &amp; price ≤ entry");
  assert.equal(sanitizeTelegramHTML(once), once, "the send layer leaves escaped text alone (no double escape)");

  const texts = [];
  for (const key of Object.keys(SETTINGS_HELP)) {
    if (SETTINGS_HELP[key].kind === "number") texts.push(menu.buildInputPrompt(key));
    texts.push(menu.changeNote(key));
  }
  for (const page of Object.keys(SETTINGS_PAGES)) {
    texts.push(menu.renderSettingsMenu(page, { note: menu.changeNote("tvlFloorExitLossPct") }).text);
    texts.push(...menu.buildPageHelp(page));
  }
  for (const t of texts) {
    assert.equal(sanitizeTelegramHTML(t), t, `not send-safe: ${t.slice(0, 120)}`);
    assert.ok(!/&amp;(amp|lt|gt);/.test(t), `double-escaped: ${t.slice(0, 120)}`);
  }
  // Labels with ≤ and % render as is.
  assert.ok(menu.buildInputPrompt("tvlFloorExitLossPct").includes("<b>Loss ≤ %</b>"));
});

test("Help: one message (or more) per page, every item on it, each under 4096", () => {
  for (const page of Object.keys(SETTINGS_PAGES)) {
    const parts = menu.buildPageHelp(page);
    assert.ok(parts.length >= 1);
    for (const part of parts) assert.ok(part.length <= 4096, `${page}: ${part.length} chars`);
    const joined = parts.join("\n");
    for (const key of menu.menuKeysOnPage(page)) {
      assert.ok(joined.includes(`<code>${key}</code>`), `${page}: help lacks ${key}`);
      assert.ok(joined.includes(escapeHTML(SETTINGS_HELP[key].help)), `${page}: help text of ${key}`);
    }
  }
});

test("Help button sends the page help through sendHTML; old callbacks fail soft", async () => {
  const { deps, calls } = fakeDeps();
  await menu.handleSettingsCallback(cb("cfg:help:risk"), deps);
  assert.ok(calls.sendHTML.length >= 1);
  assert.ok(calls.sendHTML.join("").includes("<code>stopLossPct</code>"));

  for (const data of ["cfg:toggle:noSuchKey", "cfg:frobnicate:x", "cfg:input:solMode", "cfg:set:strategy:curve", "cfg:toggle:deployAmountSol"]) {
    const f = fakeDeps();
    const before = JSON.stringify(config);
    await menu.handleSettingsCallback(cb(data), f.deps);
    assert.deepEqual(f.calls.answers, [menu.MENU_OUTDATED], data);
    assert.equal(JSON.stringify(config), before, `${data} changed config`);
  }
  // An unknown page renders Main instead of failing.
  const g = fakeDeps();
  await menu.handleSettingsCallback(cb("cfg:page:nosuchpage"), g.deps);
  assert.match(g.calls.edits[0].html, /<b>Settings menu<\/b>/);
  // noop / close / show still work.
  const h = fakeDeps();
  await menu.handleSettingsCallback(cb("cfg:show"), h.deps);
  assert.equal(h.calls.edits[0].html, "<b>snapshot</b>");
  await menu.handleSettingsCallback(cb("cfg:close"), h.deps);
  assert.equal(h.calls.editMessage[0].text, "Settings menu closed.");
});

test("toggle: flips through update_config and re-renders with the item's explanation", async () => {
  const before = config.management.toxicConversionEnabled;
  const { deps, calls } = fakeDeps();
  await menu.handleSettingsCallback(cb("cfg:toggle:toxicConversionEnabled"), deps);
  assert.equal(config.management.toxicConversionEnabled, !before);
  assert.equal(readUserConfig().toxicConversionEnabled, !before, "persisted by update_config");
  assert.equal(calls.answers.length, 1);
  assert.ok(calls.answers[0].length <= 200, "toast within Telegram's 200 chars");
  assert.equal(calls.answers[0], `Toxic Conv Guard: ${!before ? "on" : "off"}`);
  const html = calls.edits[0].html;
  assert.ok(html.includes(`ℹ️ <b>Toxic Conv Guard</b> is now <b>${!before ? "on" : "off"}</b>`));
  assert.ok(html.includes(escapeHTML(SETTINGS_HELP.toxicConversionEnabled.help)), "explanation in the header");
  assert.match(html, /<b>Settings: Risk<\/b>/);
  // Legacy callbacks of existing buttons keep working.
  const f = fakeDeps();
  await menu.handleSettingsCallback(cb("cfg:toggle:toxicConversionEnabled"), f.deps);
  assert.equal(config.management.toxicConversionEnabled, before);
  const s = fakeDeps();
  const target = config.strategy.strategy === "spot" ? "bid_ask" : "spot";
  await menu.handleSettingsCallback(cb(`cfg:set:strategy:${target}`), s.deps);
  assert.equal(config.strategy.strategy, target);
  assert.ok(s.calls.edits[0].html.includes(escapeHTML(SETTINGS_HELP.strategy.help)));
  await menu.handleSettingsCallback(cb("cfg:set:strategy:spot"), s.deps);
  const maxBefore = config.risk.maxPositions;
  const st = fakeDeps();
  await menu.handleSettingsCallback(cb("cfg:step:maxPositions:1"), st.deps);
  assert.equal(config.risk.maxPositions, maxBefore + 1);
  await menu.handleSettingsCallback(cb("cfg:step:maxPositions:-1"), st.deps);
  assert.equal(config.risk.maxPositions, maxBefore);
});

test("TVL exit page: renders every key with the effective (default) values", () => {
  const { text, keyboard } = menu.renderSettingsMenu("tvl");
  assert.match(text, /<b>Settings: TVL exit<\/b>/);
  assert.match(text, /TVL exit: enforce · distress gate enforce · min \$10,000/);
  const buttons = allButtons(keyboard);
  assert.ok(buttons.some((b) => b.callback_data === "cfg:page:tvl"), "nav button");
  assert.deepEqual(menu.menuKeysOnPage("tvl"), TVL_KEYS);
  const texts = buttons.map((b) => b.text);
  for (const t of ["Exit: off", "Exit: shadow", "Exit: enforce ✓", "Distress: off", "Distress: shadow", "Distress: enforce ✓",
    "TVL min: $10,000 ✏", "Min readings: 3 ✏", "Min minutes: 5 ✏", "Loss ≤ %: -10 ✏", "No-PnL price ≤ %: -30 ✏",
    "Dump turnover: 2 ✏", "Dump price ≤ %: -5 ✏"]) {
    assert.ok(texts.includes(t), `missing button "${t}" in ${JSON.stringify(texts)}`);
  }
  // Effective values when a key is absent / present / garbage (as the readers resolve them).
  const prodLike = { management: { tvlFloorExitMode: "enforce", tvlFloorExitLossPct: -20 } };
  assert.equal(menu.settingValue("tvlFloorExitMode", prodLike), "enforce");
  assert.equal(menu.settingValue("tvlFloorExitDistressMode", prodLike), "enforce", "absent distress mode = enforce");
  assert.equal(menu.settingValue("tvlFloorExitLossPct", prodLike), -20);
  assert.equal(menu.settingValue("tvlFloorExitPriceDropPct", prodLike), -30);
  assert.equal(menu.settingValue("tvlFloorExitUsd", prodLike), 10000);
  assert.equal(menu.settingValue("tvlFloorExitMinReadings", prodLike), 3);
  assert.equal(menu.settingValue("tvlFloorExitMinMinutes", prodLike), 5);
  const odd = { management: { tvlFloorExitMode: "bogus", tvlFloorExitDistressMode: "bogus", tvlFloorExitMinReadings: 1, tvlFloorExitUsd: 0, tvlFloorExitLossPct: 7 } };
  assert.equal(menu.settingValue("tvlFloorExitMode", odd), "shadow", "unknown master mode reads as shadow");
  assert.equal(menu.settingValue("tvlFloorExitDistressMode", odd), "enforce");
  assert.equal(menu.settingValue("tvlFloorExitMinReadings", odd), 3);
  assert.equal(menu.settingValue("tvlFloorExitUsd", odd), 10000);
  assert.equal(menu.settingValue("tvlFloorExitLossPct", odd), -10, "invalid loss reads as the default");
});

test("TVL exit page: each value key round-trips through update_config", async () => {
  const cases = {
    tvlFloorExitUsd: ["12000", 12000],
    tvlFloorExitMinReadings: ["4", 4],
    tvlFloorExitMinMinutes: ["9", 9],
    tvlFloorExitLossPct: ["-20", -20],
    tvlFloorExitPriceDropPct: ["-40", -40],
    tvlFloorExitDumpTurnover: ["3.5", 3.5],
    tvlFloorExitDumpPricePct: ["-8", -8],
  };
  for (const [key, [input, expected]] of Object.entries(cases)) {
    const { deps, calls } = fakeDeps();
    await menu.handleSettingsCallback(cb(`cfg:input:${key}`), deps);
    assert.equal(calls.pending.key, key);
    assert.equal(calls.pending.page, "tvl");
    assert.equal(calls.pending.menuMsgId, 42);
    assert.ok(calls.pending.promptMessageId > 0, "prompt message id recorded");
    assert.ok(calls.sendHTML[0].includes(`<code>${key}</code>`), "prompt sent through sendHTML");
    await menu.handleSettingsInput(calls.pending, input, deps);
    assert.equal(config.management[key], expected, `${key} in memory`);
    assert.equal(readUserConfig()[key], expected, `${key} persisted`);
    assert.equal(menu.settingValue(key), expected, `${key} effective`);
    assert.ok(calls.sendHTML.at(-1).includes(`is now <b>`), `${key}: confirmation`);
    assert.match(calls.edits.at(-1).html, /<b>Settings: TVL exit<\/b>/);
  }
});

test("invalid values are refused with the accepted range; nothing changes", async () => {
  const snapshot = () => JSON.stringify([config.management, config.risk, config.screening, config.schedule]);
  const refusals = [
    // update_config's own validator (the distress gate): the range shown is the validator's.
    ["tvlFloorExitLossPct", "5", "−95 … −1"],
    ["tvlFloorExitLossPct", "-99", "−95 … −1"],
    ["tvlFloorExitPriceDropPct", "-2", "−99 … −5"],
    ["tvlFloorExitDumpTurnover", "0.1", "0.25 … 100"],
    ["tvlFloorExitDumpPricePct", "0", "−99 … −1"],
    // Menu-side checks (keys update_config does not validate; their readers would ignore these).
    ["tvlFloorExitMinReadings", "1", "2 or more"],
    ["minBinsBelow", "40.5", "whole number"],
    ["rebalanceBinsAbove", "3.2", "whole number"],
    ["tvlFloorExitMinReadings", "2.5", "2 or more"],
    ["tvlFloorExitUsd", "0", "above 0"],
    ["stopLossPct", "off", "negative"],
    ["stopLossPct", "5", "negative"],
    ["takeProfitPct", "off", "above 0"],
    ["managementIntervalMin", "61", "1 to 60"],
    ["screeningIntervalMin", "0", "1 to 60"],
    ["deployAmountSol", "1,5", "above 0"],
    ["deployAmountSol", "abc", "above 0"],
  ];
  for (const [key, input, expectAccepts] of refusals) {
    const { deps, calls } = fakeDeps();
    const before = snapshot();
    await menu.handleSettingsInput({ key, page: SETTINGS_HELP[key].page, menuMsgId: 42 }, input, deps);
    assert.equal(snapshot(), before, `${key}=${input} changed config`);
    assert.equal(calls.sendHTML.length, 1);
    const msg = calls.sendHTML[0];
    assert.match(msg, /^❌ <b>/, `${key}=${input}`);
    assert.ok(msg.includes("not changed"), msg);
    assert.ok(msg.includes(escapeHTML(expectAccepts)), `${key}=${input}: ${msg}`);
    assert.equal(calls.edits.length, 0, "menu not re-rendered on a refusal");
  }
  // update_config's refusal is quoted.
  const { deps, calls } = fakeDeps();
  await menu.handleSettingsInput({ key: "tvlFloorExitLossPct", page: "tvl", menuMsgId: 42 }, "5", deps);
  assert.ok(calls.sendHTML[0].includes("update_config refused tvlFloorExitLossPct = 5"));
  // cancel
  const c = fakeDeps();
  await menu.handleSettingsInput({ key: "gasReserve", page: "risk", menuMsgId: 42 }, "cancel", c.deps);
  assert.match(c.calls.sendHTML[0], /^Cancelled/);
  // "off" where it is accepted.
  const o = fakeDeps();
  await menu.handleSettingsInput({ key: "trailingMinPnlPct", page: "risk", menuMsgId: 42 }, "off", o.deps);
  assert.equal(config.management.trailingMinPnlPct, null);
});

test("the distress keys' accepted ranges are the validator's", () => {
  for (const key of TVL_DISTRESS_NUMERIC_KEYS) {
    const range = tvlDistressRangeText(key);
    assert.ok(SETTINGS_HELP[key].accepts.includes(range), `${key}: ${SETTINGS_HELP[key].accepts}`);
    const [lo, hi] = range.split("…").map((s) => Number(s.trim().replace("−", "-")));
    assert.equal(isValidTvlDistressValue(key, lo), true, `${key} ${lo}`);
    assert.equal(isValidTvlDistressValue(key, hi), true, `${key} ${hi}`);
    assert.equal(isValidTvlDistressValue(key, lo - 0.01), false, `${key} below`);
    assert.equal(isValidTvlDistressValue(key, hi + 0.01), false, `${key} above`);
    assert.equal(SETTINGS_HELP[key].check, undefined, `${key}: update_config validates it, no menu-side check`);
  }
});

test("three-way modes: set buttons go through update_config; a stale value fails soft", async () => {
  for (const key of ["tvlFloorExitMode", "tvlFloorExitDistressMode"]) {
    for (const mode of ["shadow", "off", "enforce"]) {
      const { deps, calls } = fakeDeps();
      await menu.handleSettingsCallback(cb(`cfg:set:${key}:${mode}`), deps);
      assert.equal(config.management[key], mode, `${key}=${mode}`);
      assert.equal(readUserConfig()[key], mode);
      assert.equal(menu.settingValue(key), mode);
      const html = calls.edits[0].html;
      assert.ok(html.includes(escapeHTML(SETTINGS_HELP[key].help)), "explanation shown after the tap");
      const btnText = (key === "tvlFloorExitMode" ? "Exit: " : "Distress: ") + mode + " ✓";
      assert.ok(allButtons(calls.edits[0].kb).some((b) => b.text === btnText), btnText);
    }
    const { deps, calls } = fakeDeps();
    await menu.handleSettingsCallback(cb(`cfg:set:${key}:bogus`), deps);
    assert.deepEqual(calls.answers, [menu.MENU_OUTDATED]);
    assert.equal(config.management[key], "enforce");
  }
  // parseMenuInput accepts the three words for a mode key (case-insensitive) and nothing else.
  assert.deepEqual(menu.parseMenuInput("tvlFloorExitMode", "Shadow"), { ok: true, value: "shadow" });
  assert.equal(menu.parseMenuInput("tvlFloorExitMode", "on").ok, false);
});

test("typed minus signs (−, –, —) and surrounding spaces are read as ASCII minus", async () => {
  assert.deepEqual(menu.parseMenuInput("tvlFloorExitLossPct", " −20 "), { ok: true, value: -20 });
  assert.deepEqual(menu.parseMenuInput("stopLossPct", "–15"), { ok: true, value: -15 });
  assert.deepEqual(menu.parseMenuInput("stopLossPct", "—12.5"), { ok: true, value: -12.5 });
  const { deps } = fakeDeps();
  await menu.handleSettingsInput({ key: "tvlFloorExitLossPct", page: "tvl", menuMsgId: 42 }, "−20", deps);
  assert.equal(config.management.tvlFloorExitLossPct, -20);
  await menu.handleSettingsInput({ key: "stopLossPct", page: "risk", menuMsgId: 42 }, "–15", deps);
  assert.equal(config.management.stopLossPct, -15);
});

test("intervals: 60 (hourly) is accepted, as before", async () => {
  const { deps } = fakeDeps();
  const before = config.schedule.managementIntervalMin;
  await menu.handleSettingsInput({ key: "managementIntervalMin", page: "screen", menuMsgId: 42 }, "60", deps);
  assert.equal(config.schedule.managementIntervalMin, 60);
  await menu.handleSettingsInput({ key: "managementIntervalMin", page: "screen", menuMsgId: 42 }, String(before), deps);
  assert.equal(config.schedule.managementIntervalMin, before);
});

test("a page item without a help entry still renders and works; the coverage check names it", async () => {
  const table = { ...SETTINGS_HELP };
  delete table.toxicConversionEnabled;
  delete table.strategy;
  delete table.gasReserve;
  menu.setHelpTableForTest(table);
  try {
    assert.deepEqual(menu.menuKeysWithoutHelp().sort(), ["gasReserve", "strategy", "toxicConversionEnabled"]);
    const risk = menu.renderSettingsMenu("risk");
    const texts = allButtons(risk.keyboard).map((b) => b.text);
    assert.ok(texts.some((t) => t.startsWith("toxicConversionEnabled: ")), "key as label");
    assert.ok(texts.some((t) => t.startsWith("gasReserve: ") && t.endsWith("✏")));
    const strat = menu.renderSettingsMenu("strategy");
    assert.ok(allButtons(strat.keyboard).some((b) => b.callback_data === "cfg:noop:strategy"), "choice without entry: inert button");
    assert.ok(menu.buildPageHelp("risk").join("\n").includes(menu.NO_DESCRIPTION));
    assert.ok(menu.buildInputPrompt("gasReserve").includes(menu.NO_DESCRIPTION));
    // The stand-in toggle still goes through update_config.
    const before = config.management.toxicConversionEnabled;
    const { deps, calls } = fakeDeps();
    await menu.handleSettingsCallback(cb("cfg:toggle:toxicConversionEnabled"), deps);
    assert.equal(config.management.toxicConversionEnabled, !before);
    assert.equal(calls.updates, 1);
    await menu.handleSettingsCallback(cb("cfg:toggle:toxicConversionEnabled"), deps);
    assert.equal(config.management.toxicConversionEnabled, before);
  } finally {
    menu.setHelpTableForTest(null);
  }
  assert.deepEqual(menu.menuKeysWithoutHelp(), []);
});

test("re-tapping the value already set calls nothing and edits nothing", async () => {
  const { deps, calls } = fakeDeps();
  await menu.handleSettingsCallback(cb("cfg:set:strategy:spot"), deps); // may set it
  const f = fakeDeps();
  await menu.handleSettingsCallback(cb("cfg:set:strategy:spot"), f.deps);
  assert.equal(f.calls.updates, 0, "no update_config call");
  assert.equal(f.calls.edits.length, 0, "no identical edit");
  assert.deepEqual(f.calls.answers, ["Strategy: already spot"]);
  await menu.handleSettingsCallback(cb("cfg:set:tvlFloorExitMode:enforce"), f.deps);
  assert.equal(f.calls.updates, 0);
  assert.equal(f.calls.answers.at(-1), "TVL exit: already enforce");
  // A stored garbage mode reads as shadow; tapping shadow must still write it.
  config.management.tvlFloorExitMode = "bogus";
  try {
    const g = fakeDeps();
    await menu.handleSettingsCallback(cb("cfg:set:tvlFloorExitMode:shadow"), g.deps);
    assert.equal(g.calls.updates, 1);
    assert.equal(config.management.tvlFloorExitMode, "shadow");
  } finally {
    const h = fakeDeps();
    await menu.handleSettingsCallback(cb("cfg:set:tvlFloorExitMode:enforce"), h.deps);
  }
  // Same for a typed value equal to the current one.
  const t = fakeDeps();
  await menu.handleSettingsInput({ key: "gasReserve", page: "risk", menuMsgId: 42 }, String(config.management.gasReserve), t.deps);
  assert.equal(t.calls.updates, 0);
  assert.match(t.calls.sendHTML[0], /is already/);
  void calls;
});

test("pending ✏ prompt: cleared by Close / page change / another item, kept by Help / noop", async () => {
  for (const data of ["cfg:close", "cfg:page:risk", "cfg:toggle:toxicConversionEnabled", "cfg:set:strategy:spot", "cfg:input:gasReserve", "cfg:show"]) {
    const { deps, calls } = fakeDeps();
    await menu.handleSettingsCallback(cb(data), deps);
    assert.ok(calls.cleared >= 1, `${data} clears the pending prompt`);
  }
  for (const data of ["cfg:help:risk", "cfg:noop"]) {
    const { deps, calls } = fakeDeps();
    await menu.handleSettingsCallback(cb(data), deps);
    assert.equal(calls.cleared, 0, `${data} keeps the pending prompt`);
  }
  // restore the toggle flipped above
  const { deps } = fakeDeps();
  await menu.handleSettingsCallback(cb("cfg:toggle:toxicConversionEnabled"), deps);
});

test("pending ✏ prompt: only a message sent after the prompt, within 5 minutes, is the value", () => {
  const t0 = 1_800_000_000_000;
  const pending = { ...menu.makePendingInput("gasReserve", "risk", 42, t0), promptMessageId: 500 };
  // By message id (Telegram ids grow per chat, bot messages included).
  assert.equal(menu.pendingInputVerdict(pending, { message_id: 501, date: t0 / 1000 }, t0 + 1000), "accept");
  assert.equal(menu.pendingInputVerdict(pending, { message_id: 499, date: t0 / 1000 + 10 }, t0 + 1000), "stale", "queued before the prompt");
  // Expiry.
  assert.equal(menu.pendingInputVerdict(pending, { message_id: 600 }, t0 + menu.PENDING_INPUT_TTL_MS + 1), "expired");
  assert.equal(menu.pendingInputVerdict(pending, { message_id: 600 }, t0 + menu.PENDING_INPUT_TTL_MS - 1), "accept");
  // No prompt id: by date (whole seconds; the prompt's own second counts as after).
  const noId = menu.makePendingInput("gasReserve", "risk", 42, t0 + 400);
  assert.equal(menu.pendingInputVerdict(noId, { message_id: 10, date: Math.floor(t0 / 1000) - 5 }, t0 + 2000), "stale");
  assert.equal(menu.pendingInputVerdict(noId, { message_id: 10, date: Math.floor(t0 / 1000) }, t0 + 2000), "accept");
  assert.equal(menu.pendingInputVerdict(null, { message_id: 10 }, t0), "stale");
});
