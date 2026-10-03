process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const { sanitizeTelegramHTML, truncateTelegramHTML, isCoveredByLiveMessage } = await import("../telegram.js");

test("stray <, > and & are escaped; Telegram tags and entities are kept", () => {
  // 2026-10-03 15:06: "Unsupported start tag" from an unfilled-ladder close reason
  assert.equal(sanitizeTelegramHTML("<b>swordcat</b>: pnl 0.00% < 1%"), "<b>swordcat</b>: pnl 0.00% &lt; 1%");
  assert.equal(sanitizeTelegramHTML("TVL <100k & vol >= 2 <=3"), "TVL &lt;100k &amp; vol &gt;= 2 &lt;=3");
  assert.equal(sanitizeTelegramHTML("already &lt; and &amp; and &#36;"), "already &lt; and &amp; and &#36;");
  assert.equal(sanitizeTelegramHTML('<a href="https://x.io/?a=1&b=2">pool</a> <code>a<b</code>'), '<a href="https://x.io/?a=1&b=2">pool</a> <code>a&lt;b</code>');
  assert.equal(sanitizeTelegramHTML("<div>x</div> <tg-spoiler>y</tg-spoiler>"), "&lt;div&gt;x&lt;/div&gt; <tg-spoiler>y</tg-spoiler>");
  assert.equal(sanitizeTelegramHTML(null), "");
});

test("over-long HTML is cut outside tags and entities, with open tags closed", () => {
  const html = "<b>" + "x".repeat(5000) + "</b>";
  const out = truncateTelegramHTML(html);
  assert.ok(out.length <= 4096, `length ${out.length}`);
  assert.ok(out.endsWith("…</b>"));
  const mid = "<i>" + "y".repeat(4010) + "<code>abc</code>" + "z".repeat(200) + "</i>";
  const cut = truncateTelegramHTML(mid);
  assert.ok(cut.length <= 4096);
  assert.ok(!/<[^>]*$/.test(cut), "never ends inside a tag");
  assert.ok(cut.endsWith("</i>"));
  assert.equal(truncateTelegramHTML("short <b>ok</b>"), "short <b>ok</b>");
  const ent = "a".repeat(4013) + "&amp;tail" + "b".repeat(100);
  assert.ok(!/&[a-z]*$/.test(truncateTelegramHTML(ent).replace(/…$/, "")), "never ends inside an entity");
});

test("notifications are skipped only when an open live message shows the same event", () => {
  assert.equal(isCoveredByLiveMessage("close_position", "SI-SOL"), false, "no live message → never covered");
  const src = fs.readFileSync(new URL("../telegram.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\n  if \(hasActiveLiveMessage\(\)\) return;/, "no blanket suppression left");
  assert.match(src, /if \(isCoveredByLiveMessage\("deploy_position", pair, position, pool\)\) return;/);
  assert.match(src, /if \(isCoveredByLiveMessage\("close_position", pair, position\)\) return;/);
  assert.match(src, /if \(isSwapCoveredByLiveMessage\(inputSymbol\)\) return;/);
  assert.match(src, /async toolStart\(name, context = null\) \{\s+noteLiveCoverage\(name, context\);/);
  assert.equal((src.match(/text: prepareText\(text, parseMode\),/g) || []).length, 4, "every send/edit path is sanitized");
  const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exec, /notifyClose\(\{\s+position: args\.position_address \|\| null,/);
});
