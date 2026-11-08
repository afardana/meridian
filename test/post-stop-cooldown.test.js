process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const PS = await import("../post-stop-cooldown.js");
const { exitFamilyOf } = await import("../lessons.js");
const { trackPosition, ensureStateInitialized, getTrackedPosition } = await import("../state.js");
const PR = await import("../perf-record.js");
const { modeFor } = await import("../rule-mode.js");
await ensureStateInitialized();

// post-stop-cooldown.js (2026-11-08): no new bot deploy into a POOL within H h of a bot
// stop-class close of that pool. Shadow by default.

const NOW = Date.parse("2026-11-05T12:00:00+07:00");
const hAgo = (h) => new Date(NOW - h * 3600_000).toISOString();
const POOL = "PoolHIGH111";
const rec = (h, reason, over = {}) => ({ pool: POOL, pool_name: "HIGH-SOL", recorded_at: hAgo(h), close_reason: reason, pnl_pct: -16.4, ...over });
const opts = { familyOf: exitFamilyOf };
const cfg24 = { postStopCooldownMode: "shadow", postStopCooldownHours: 24 };

test("stop-class families only — stop_loss, rug, crash, probation_stop, young_stop", () => {
  assert.deepEqual([...PS.POST_STOP_FAMILIES], ["stop_loss", "rug", "crash", "probation_stop", "young_stop"]);
  for (const f of PS.POST_STOP_FAMILIES) assert.equal(PS.isStopClassFamily(f), true, f);
  for (const f of ["trailing_tp", "harvest", "low_yield", "oor_below", "oor_above_unfilled", "tvl_floor", "hold_limit", "manual", "max_hold", null, undefined, ""]) {
    assert.equal(PS.isStopClassFamily(f), false, String(f));
  }
  // Real close reasons, through lessons.js exitFamilyOf.
  const reasons = {
    "Stop loss: PnL -16.40% <= -15%": true,
    "In-range rug (latched 30s): 51 bins/60s from the window high": true,
    "Crash-below fast path: 14 b/min": true,
    "First-entry probation: PnL -8.20% <= -8% at 100 min": true,
    "Young-token stop: PnL -10%": true,
    "Trailing TP: peak 3.8% → current 2.3%": false,
    "Round-trip complete: harvest": false,
    "Low yield: fees 0.1% over 120 min": false,
    "TVL exit: pool TVL $9,000 under the $10,000 minimum": false,
  };
  for (const [reason, blocks] of Object.entries(reasons)) {
    assert.equal(PS.postStopBlockUntil([rec(2, reason)], POOL, NOW, cfg24, opts) !== null, blocks, reason);
  }
});

test("HIGH-SOL: a stop loss 7.2 h ago blocks for 24 h from the close; the reason names family, gap and rule", () => {
  const records = [rec(7.2, "Stop loss: PnL -16.40% <= -15%")];
  assert.equal(PS.postStopBlockUntil(records, POOL, NOW, cfg24, opts), new Date(NOW - 7.2 * 3600_000 + 24 * 3600_000).toISOString());
  assert.equal(PS.postStopRejectReason(records, POOL, NOW, cfg24, opts), "post-stop cooldown: stop_loss close 7.2h ago (24 h rule)");
  const v = PS.postStopVerdict(records, POOL, NOW, cfg24, opts);
  assert.equal(v.wouldSkip, true);
  assert.equal(v.mode, "shadow");
  assert.equal(v.family, "stop_loss");
  assert.equal(v.reason, "post-stop cooldown: stop_loss close 7.2h ago (24 h rule)");
  // Another pool is not blocked; no records → no block.
  assert.equal(PS.postStopBlockUntil(records, "OtherPool", NOW, cfg24, opts), null);
  assert.equal(PS.postStopBlockUntil([], POOL, NOW, cfg24, opts), null);
  assert.equal(PS.postStopBlockUntil(null, POOL, NOW, cfg24, opts), null);
  assert.equal(PS.postStopVerdict([], POOL, NOW, cfg24, opts).wouldSkip, false);
});

test("bot closes only: adopted (operator) closes and rebalance legs never start a cooldown", () => {
  const stop = "Stop loss: PnL -16.40% <= -15%";
  assert.equal(PS.postStopBlockUntil([rec(3, stop, { adopted: true })], POOL, NOW, cfg24, opts), null, "adopted");
  assert.equal(PS.postStopBlockUntil([rec(3, stop, { rebalance_leg: true })], POOL, NOW, cfg24, opts), null, "rebalance leg flag");
  assert.equal(PS.postStopBlockUntil([rec(3, "rebalance: straddle; Stop loss")], POOL, NOW, cfg24, opts), null, "rebalance: reason");
  assert.equal(PS.postStopBlockUntil([rec(3, stop, { exit_family: "rebalance_leg" })], POOL, NOW, cfg24, opts), null, "stored rebalance_leg family");
  assert.notEqual(PS.postStopBlockUntil([rec(3, stop, { adopted: false })], POOL, NOW, cfg24, opts), null, "adopted:false is a bot close");
});

test("window edge: blocked while now < close + H; a future-dated record is ignored", () => {
  const stop = "Stop loss";
  assert.notEqual(PS.postStopBlockUntil([rec(23.99, stop)], POOL, NOW, cfg24, opts), null);
  assert.equal(PS.postStopBlockUntil([rec(24, stop)], POOL, NOW, cfg24, opts), null, "exactly H ago is out");
  assert.equal(PS.postStopBlockUntil([rec(30, stop)], POOL, NOW, cfg24, opts), null);
  assert.equal(PS.postStopBlockUntil([rec(-1, stop)], POOL, NOW, cfg24, opts), null, "future");
  assert.equal(PS.postStopBlockUntil([{ pool: POOL, close_reason: stop }], POOL, NOW, cfg24, opts), null, "no time");
});

test("the latest stop-class close wins; a later non-stop close does not lift it", () => {
  const records = [rec(20, "Stop loss"), rec(5, "In-range rug (latched 30s)"), rec(2, "Trailing TP: peak 3%", { pnl_pct: 1.5 })];
  const v = PS.postStopVerdict(records, POOL, NOW, cfg24, opts);
  assert.equal(v.family, "rug");
  assert.equal(v.blockUntil, new Date(NOW - 5 * 3600_000 + 24 * 3600_000).toISOString());
  assert.equal(v.reason, "post-stop cooldown: rug close 5.0h ago (24 h rule)");
});

test("H comes from config (clamped 1–72, unusable → 24); the stored exit_family is the default family source", () => {
  const records = [rec(10, "Stop loss")];
  assert.equal(PS.postStopBlockUntil(records, POOL, NOW, { postStopCooldownHours: 12 }, opts) !== null, true);
  assert.equal(PS.postStopBlockUntil(records, POOL, NOW, { postStopCooldownHours: 6 }, opts), null);
  assert.equal(PS.postStopRejectReason(records, POOL, NOW, { postStopCooldownHours: 12 }, opts), "post-stop cooldown: stop_loss close 10.0h ago (12 h rule)");
  assert.deepEqual(PS.postStopCooldownConfig({}), { mode: "shadow", hours: 24 });
  assert.deepEqual(PS.postStopCooldownConfig({ postStopCooldownHours: 0 }), { mode: "shadow", hours: 1 });
  assert.deepEqual(PS.postStopCooldownConfig({ postStopCooldownHours: 500 }), { mode: "shadow", hours: 72 });
  assert.deepEqual(PS.postStopCooldownConfig({ postStopCooldownHours: "x" }), { mode: "shadow", hours: 24 });
  assert.deepEqual(PS.postStopCooldownConfig({ postStopCooldownMode: "enforce", postStopCooldownHours: 48 }), { mode: "enforce", hours: 48 });
  assert.equal(PS.postStopCooldownConfig({ postStopCooldownMode: "ENFORCE" }).mode, "shadow", "a typo never enforces");
  assert.equal(PS.postStopCooldownConfig({ postStopCooldownMode: "off" }).mode, "off");
  // Without familyOf only the stored family counts.
  assert.equal(PS.postStopBlockUntil([rec(3, "whatever", { exit_family: "crash" })], POOL, NOW, cfg24), new Date(NOW - 3 * 3600_000 + 24 * 3600_000).toISOString());
  assert.equal(PS.postStopBlockUntil([rec(3, "Stop loss")], POOL, NOW, cfg24), null);
  // A throwing familyOf is "no family", never a crash.
  assert.equal(PS.postStopBlockUntil(records, POOL, NOW, cfg24, { familyOf: () => { throw new Error("x"); } }), null);
});

test("verdict per mode: wouldSkip is the rule's answer in every mode (the tag); only enforce blocks at the gates", () => {
  const records = [rec(7.2, "Stop loss")];
  for (const mode of ["off", "shadow", "enforce"]) {
    const v = PS.postStopVerdict(records, POOL, NOW, { postStopCooldownMode: mode }, opts);
    assert.equal(v.mode, mode);
    assert.equal(v.wouldSkip, true, mode);
  }
});

test("rule-mode spec: off | shadow | enforce, strict, unknown → shadow", () => {
  assert.equal(modeFor("postStopCooldownMode", null), "shadow");
  assert.equal(modeFor("postStopCooldownMode", "enforce"), "enforce");
  assert.equal(modeFor("postStopCooldownMode", "Enforce"), "shadow");
  assert.equal(modeFor("postStopCooldownMode", "bogus"), "shadow");
});

test("record capture: trackPosition keeps the fields for a bot deploy, drops them on an adopted row; the perf record carries them", () => {
  const until = new Date(NOW + 3600_000).toISOString();
  trackPosition({ position: "PSC_BOT", pool: POOL, pool_name: "HIGH-SOL", strategy: "spot", amount_sol: 0.4, bin_range: { min: 0, max: 69 }, active_bin: 69, post_stop_block_until: until, post_stop_gate_would_skip: true });
  const bot = getTrackedPosition("PSC_BOT");
  assert.equal(bot.post_stop_block_until, until);
  assert.equal(bot.post_stop_gate_would_skip, true);
  trackPosition({ position: "PSC_NONE", pool: POOL, pool_name: "HIGH-SOL", strategy: "spot", amount_sol: 0.4, bin_range: { min: 0, max: 69 }, active_bin: 69, post_stop_block_until: "not-a-date", post_stop_gate_would_skip: "yes" });
  const none = getTrackedPosition("PSC_NONE");
  assert.equal(none.post_stop_block_until, null);
  assert.equal(none.post_stop_gate_would_skip, null);
  trackPosition({ position: "PSC_ADOPT", pool: POOL, pool_name: "HIGH-SOL", strategy: "spot", amount_sol: 0.4, bin_range: { min: 0, max: 69 }, active_bin: 69, adopted: true, post_stop_block_until: until, post_stop_gate_would_skip: true });
  const ad = getTrackedPosition("PSC_ADOPT");
  assert.equal(ad.post_stop_block_until, null);
  assert.equal(ad.post_stop_gate_would_skip, null);

  const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/perf-record-sites.json", import.meta.url), "utf8"));
  const dec = (v) => {
    if (v === "__NaN__") return NaN;
    if (v === "__undefined__") return undefined;
    if (Array.isArray(v)) return v.map(dec);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]));
    return v;
  };
  const SITE = { close: PR.closePositionPerfRecord, rebalance_leg: PR.rebalanceLegPerfRecord, external_reconcile: PR.externalReconcilePerfRecord };
  for (const c of FIX.cases) {
    const args = dec(c.args);
    const key = args.tracked ? "tracked" : "snapshot";
    const tagged = SITE[c.site]({ ...args, [key]: { ...args[key], post_stop_block_until: until, post_stop_gate_would_skip: true } });
    assert.equal(tagged.post_stop_block_until, until, c.name);
    assert.equal(tagged.post_stop_gate_would_skip, true, c.name);
    const plain = SITE[c.site](args);
    assert.equal(plain.post_stop_block_until, null, c.name);
    assert.equal(plain.post_stop_gate_would_skip, null, c.name);
  }
});

test("wiring: both gates call the predicate; enforce rejects, shadow admits + logs / tags; the poll uses it; not shown to the LLM", () => {
  const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  const scr = read("tools/screening.js");
  assert.match(scr, /import \{ postStopVerdict \} from "\.\.\/post-stop-cooldown\.js"/);
  assert.match(scr, /postStopFor = \(poolAddress\) => postStopVerdict\(records, poolAddress, now, s, \{ familyOf: exitFamilyOf \}\)/);
  const gates = scr.slice(scr.indexOf("function applyRankSafetyGates("), scr.indexOf("if (!isUsableVolatility(p.volatility))"));
  assert.match(gates, /isBaseMintOnCooldown[\s\S]*postStopFor\(p\.pool\)/, "beside the other cooldowns");
  assert.match(gates, /if \(postStop\.mode === "enforce"\) \{\s+pushFilteredReason\(filteredOut, p, postStop\.reason\);\s+return false;/);
  assert.match(gates, /if \(postStop\.mode === "shadow"\) p\._postStopCooldown = postStop;/, "shadow admits");
  assert.match(scr, /applyRankSafetyGates\(universe, \{ occupiedPools, occupiedMints, filteredOut, postStopFor \}\)/);
  assert.match(scr, /\[POST_STOP_COOLDOWN_SHADOW\] would-skip \$\{p\.name\}: \$\{v\.family\} close \$\{v\.gapHours\.toFixed\(1\)\}h ago \(postStopCooldownMode=shadow\)/);

  const exec = read("tools/executor.js");
  const vd = exec.slice(exec.indexOf("async function validateDeployPoolThresholds("), exec.indexOf("const tvl = poolDetailTvl(detail);"));
  assert.match(vd, /if \(args\?\.existing_position !== true\) \{[\s\S]*postStopVerdict\(getAllPerformance\(\), args\.pool_address, Date\.now\(\), config\.screening, \{ familyOf: exitFamilyOf \}\)/, "new deploys only");
  assert.match(vd, /if \(postStop\.mode === "enforce"\) \{[\s\S]{0,160}return \{ pass: false, reason: postStop\.reason \};/);
  assert.match(exec, /post_stop_block_until: postStop \? postStop\.blockUntil : null,/);
  assert.match(exec, /post_stop_gate_would_skip: postStop \? postStop\.wouldSkip : null,/);
  assert.match(exec, /postStopCooldownMode: \["screening", "postStopCooldownMode"\]/);
  assert.match(exec, /postStopCooldownHours: \["screening", "postStopCooldownHours"\]/);
  // The rebalance / straddle re-check passes existing_position: true and never reaches the rule.
  assert.match(exec, /validateDeployPoolThresholds\(\{ pool_address: tracked\.pool, pool_name: tracked\.pool_name, existing_position: true \}\)/);

  const idx = read("index.js");
  assert.match(idx, /postStopVerdict\(postStopRecords, c\.pool, postStopNow, config\.screening, \{ familyOf: exitFamilyOf \}\)/);
  assert.match(idx, /return v\.mode === "enforce" && v\.wouldSkip;/, "the poll filters only in enforce");
  assert.match(idx, /filter\(\(c\) => !quoteTokenRejectReason\(c\) && !postStopBlocks\(c\)\)/);

  const prompt = read("prompt.js");
  assert.doesNotMatch(prompt + idx, /_postStopCooldown|post_stop_block_until/, "not shown to the LLM");

  const cfg = read("config.js");
  assert.match(cfg, /postStopCooldownMode:\s+postStopCooldownConfig\(u\)\.mode/);
  assert.match(cfg, /postStopCooldownHours:\s+postStopCooldownConfig\(u\)\.hours/);
  const dl = read("tools/dlmm.js") + read("perf-record.js");
  assert.equal(dl.split("\n").filter((l) => l.includes("post_stop_gate_would_skip")).length, 3, "param + trackPosition + the shared perf-record builder");
});
