process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

import { test } from "node:test";
import assert from "node:assert/strict";

// 2026-10-12: one mark for who opened a position — 🤖 the bot, 🧑 the operator — from the
// existing `adopted` flag, in every Telegram output.
const sent = [];
globalThis.fetch = async (_url, init) => {
  sent.push(JSON.parse(init.body));
  return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }), text: async () => "" };
};

const { ownerTag, tagPair, isManualOwner } = await import("../owner-tag.js");
const T = await import("../telegram.js");
const I = await import("../index.js");
const { splitPerfByOwner, ownerSplitLine } = await import("../briefing.js");

test("mapping: adopted = the operator's, everything else the bot's", () => {
  assert.deepEqual(ownerTag({ adopted: true }), { owner: "manual", emoji: "🧑", label: "Manual" });
  assert.deepEqual(ownerTag({ adopted: false }), { owner: "bot", emoji: "🤖", label: "Bot" });
  // a perf record of a bot deploy carries no `adopted` key at all (written as `|| undefined`)
  assert.equal(ownerTag({ pool_name: "QI-SOL" }).owner, "bot");
  assert.equal(ownerTag(null).owner, "bot");
  assert.equal(ownerTag({ adopted: "true" }).owner, "bot", "only the boolean flag counts");
  // a bot deploy recovered through the adoption path is still the bot's
  assert.equal(ownerTag({ adopted: true, strategy_source: "bot_recovery" }).owner, "bot");
  assert.equal(ownerTag({ adopted: true, strategy_source: "bot_deploy_recovered" }).owner, "bot");
  assert.equal(ownerTag({ adopted: true, strategy_source: "manual_adoption" }).owner, "manual");
  assert.equal(isManualOwner({ adopted: true }), true);
  assert.equal(tagPair("QI-SOL", { adopted: false }), "🤖 QI-SOL");
  assert.equal(tagPair("CRAWL-SOL", { adopted: true }), "🧑 CRAWL-SOL");
  assert.equal(tagPair("BONK → SOL", null), "BONK → SOL", "no position known → no tag");
});

test("close / deploy / swap / out-of-range notifications carry the tag", async () => {
  const close = { pnlSol: 0.01, pnlPct: 1.2, deployedSol: 0.5, feesSol: 0.002, holdTime: 30, reason: "trailing TP: a < b" };
  await T.notifyClose({ ...close, pair: "CRAWL-SOL", owner: { adopted: true } });
  await T.notifyClose({ ...close, pair: "QI-SOL", owner: { adopted: false } });
  await T.notifyDeploy({ pair: "QI-SOL", amountSol: 0.5, position: "Pos1111111111" });
  await T.notifySwap({ inputSymbol: "CRAWL", outputSymbol: "SOL", amountIn: 10, amountOut: "0.1", owner: { adopted: true } });
  await T.notifySwap({ inputSymbol: "BONK", outputSymbol: "SOL", amountIn: 10, amountOut: "0.1" });
  await T.notifyOutOfRange({ pair: "CRAWL-SOL", minutesOOR: 12, direction: "Below", binDistance: 4, limitMinutes: 60, owner: { adopted: true } });
  const [c1, c2, d, s1, s2, o] = sent.map((m) => m.text);
  assert.match(c1, /^🏁 <b>Closed Position<\/b> · 🧑 <code>CRAWL-SOL<\/code>\n/);
  assert.match(c2, /^🏁 <b>Closed Position<\/b> · 🤖 <code>QI-SOL<\/code>\n/);
  assert.match(c1, /trailing TP: a &lt; b/, "HTML sanitising intact");
  assert.match(d, /^🚀 <b>Deployed<\/b> 🤖 <code>QI-SOL<\/code>\n/, "a deploy is always the bot's");
  assert.match(s1, /^🔄 <b>Swapped<\/b> 🧑 <code>CRAWL → SOL<\/code>\n/);
  assert.match(s2, /^🔄 <b>Swapped<\/b> <code>BONK → SOL<\/code>\n/, "a hand swap has no owner");
  assert.match(o, /^📉 <b>Out of Range Alert<\/b> · 🧑 <code>CRAWL-SOL<\/code> \(Below, 4 bins\)\n/);
  assert.match(T.formatRebalanceMessage({ pair: "CRAWL-SOL", owner: { adopted: true } }), /^🔄 <b>Rebalanced<\/b> 🧑 CRAWL-SOL/);
  for (const m of sent) assert.equal(m.parse_mode, "HTML");
});

test("/positions rows, the position card and the menu buttons", () => {
  const p = { pair: "A<B>-SOL", pool: "Pool111", position: "Pos111", in_range: true, pnl_usd: 0.01, pnl_pct: 1.5, total_value_usd: 0.5, unclaimed_fees_usd: 0.001, age_minutes: 12 };
  const bot = I.renderPositionsListRow(p, 0, { solMode: true, owner: { adopted: false } });
  const manual = I.renderPositionsListRow({ ...p, hold_mode: true }, 1, { solMode: true, owner: { adopted: true } });
  assert.match(bot, /^<b>1\.<\/b> 🟢 🤖 <a href="https:\/\/app\.meteora\.ag\/dlmm\/Pool111">A&lt;B&gt;-SOL<\/a>\n/);
  assert.match(manual, /^<b>2\.<\/b> 🟢 🧑 <a href="[^"]+">A&lt;B&gt;-SOL<\/a> · 🛡️ <b>\[HOLD\]<\/b>\n/);
  assert.match(bot, /Value: <code>◎0\.5<\/code> · PnL: <code>\+◎0\.01 \(\+1\.5%\)<\/code>/, "the rest of the row is unchanged");
  // a live row has no `adopted` flag: the row itself is used when it carries one
  assert.match(I.renderPositionsListRow({ ...p, adopted: true }, 0), /🧑 <a /);
  assert.match(I.renderPositionActionCard({ ...p, adopted: true }, 0).text, /Position #1 · 🧑 A&lt;B&gt;-SOL<\/b> <i>\(Manual\)<\/i>/);
  assert.match(I.renderPositionActionCard({ ...p, adopted: false }, 0).text, /Position #1 · 🤖 A&lt;B&gt;-SOL<\/b> <i>\(Bot\)<\/i>/);
  const menu = I.renderPositionsMenu([{ ...p, adopted: true }, { ...p, adopted: false }]);
  assert.match(menu.keyboard[0][0].text, /^1\. 🧑 A<B>-SOL /);
  assert.match(menu.keyboard[1][0].text, /^2\. 🤖 A<B>-SOL /);
  assert.deepEqual(I.ownerOf({ adopted: true, pair: "x" }), { adopted: true, pair: "x" });
  assert.equal(ownerTag(I.ownerOf({ position: "not-tracked-anywhere", pair: "x" })).owner, "bot");
});

test("hold / thin-pool alerts carry the tag when the owner is given", () => {
  const cfg = { limitPct: -25, tvlUsd: 100000 };
  assert.match(I.holdThinLimitAlertText({ pair: "F-SOL", pnlPct: -26, heldSec: 65, valuations: 3, entryTvlUsd: 42000, cfg, owner: { adopted: true } }), /\n🧑 F-SOL: PnL/);
  assert.match(I.holdThinLimitAlertText({ pair: "F-SOL", pnlPct: -26, heldSec: 65, valuations: 3, entryTvlUsd: 42000, cfg }), /\nF-SOL: PnL/);
  const v = { rule: "stop_loss", threshold_pct: -15, pnl_pct: -15.2 };
  assert.match(I.holdDownsideAlertText({ pair: "Q-SOL", verdict: v, heldMin: 3, tracked: { entry_tvl: 500000 }, mgmt: {}, owner: { adopted: false } }), /\n🤖 Q-SOL: PnL/);
  assert.match(I.thinPoolAdoptionAlertText({ pair: "F-SOL", amountSol: 1, entryTvlUsd: 42000, mgmt: {}, owner: { adopted: true } }), /\n🧑 F-SOL \(◎1\.000\): pool TVL/);
});

test("briefing: the 24h result is split bot / manual", () => {
  const recs = [
    { pool_name: "QI-SOL", pnl_sol: 0.02, pnl_usd: 0.02 },
    { pool_name: "ART-SOL", pnl_sol: -0.005, pnl_usd: -0.01 },
    { pool_name: "CRAWL-SOL", adopted: true, pnl_sol: 0.1, pnl_usd: 0.1 },
  ];
  const s = splitPerfByOwner(recs);
  assert.deepEqual([s.bot.closes, s.manual.closes], [2, 1]);
  assert.ok(Math.abs(s.bot.pnlSol - 0.015) < 1e-12 && Math.abs(s.manual.pnlSol - 0.1) < 1e-12);
  assert.equal(ownerSplitLine(recs), "🤖 Bot: 2 closed · +◎0.0150 · 50% win  |  🧑 Manual: 1 closed · +◎0.1000 · 100% win");
  assert.equal(ownerSplitLine([{ pool_name: "QI-SOL", pnl_sol: -0.02, pnl_usd: -0.02 }]), "🤖 Bot: 1 closed · −◎0.0200 · 0% win  |  🧑 Manual: 0 closed");
  assert.equal(ownerSplitLine([]), null);
});
