// Fresh top-performer lane (plan 16, Phase 1) — the pure lane definition (fresh-lane.js), its
// config keys, and the live capture runtime (fresh-lane-paper.js) with injected fakes: failure
// isolation, 429 back-off, one entry per episode, tracking end, quotes, operator capture.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const L = await import("../fresh-lane.js");
const P = await import("../fresh-lane-paper.js");
const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/fresh-lane-winston.json", import.meta.url), "utf8"));
const NOW = Date.parse(FX.fetched_at);
const WINSTON = FX.rows[0];
const WINSTON_POOL = "3Ey68w4bi12Ko3Aq71TE4B6GuxLmeTjwgUCQrcXCGaeh";
const SOL = L.SOL_MINT;
const winstonSafety = () => ({
  mint: L.parseMintSafety(FX.winston_mint_account),
  fees_sol: FX.winston_jupiter.fees,
  jupiter_audit: { bot_holders_pct: FX.winston_jupiter.audit.botHoldersPercentage, bundler_pct: FX.winston_jupiter.audit.bundlerStats.holdingPct },
});
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── definition ───────────────────────────────────────────────────────────────────────────────
test("the real WINSTON-SOL row (#1 on the 2h list, 2026-11-27 15:40Z) qualifies; the rest of that top 6 does not", () => {
  assert.equal(WINSTON.pool_address, WINSTON_POOL);
  const q = L.laneQualifies(WINSTON, winstonSafety(), { now: NOW, rank: 1 });
  assert.deepEqual(q, { ok: true, reasons: [] });
  for (let i = 1; i < 6; i++) {
    const r = L.laneRowChecks(FX.rows[i], { now: NOW, rank: i + 1 });
    assert.ok(r.some((x) => /token age/.test(x)), `${FX.rows[i].name}: ${r.join("; ")}`);
  }
  assert.ok(L.laneRowChecks(FX.rows[5], { now: NOW, rank: 6 }).includes("rank #6 > 5 on the 2h list"));
});

test("each definition item rejects on its own", () => {
  const ok = { now: NOW, rank: 1 };
  const reasons = (mut, safetyMut = (s) => s, ctx = ok) => { const r = clone(WINSTON); mut(r); return L.laneQualifies(r, safetyMut(winstonSafety()), ctx).reasons; };
  assert.deepEqual(reasons(() => {}, (s) => s, { now: NOW, rank: 6 }), ["rank #6 > 5 on the 2h list"]);
  assert.deepEqual(reasons(() => {}, (s) => s, { now: NOW, rank: null }), ["not on the 2h top list"]);
  assert.deepEqual(reasons((r) => { r.token_y.address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; r.token_y.symbol = "USDC"; }), ["quote token is not SOL (USDC)"]);
  assert.deepEqual(reasons((r) => { r.pool_type = "damm_v2"; }), ["not a DLMM pool (damm_v2)"]);
  assert.match(reasons(() => {}, (s) => s, { now: WINSTON.token_x.created_at + 25 * 3_600_000, rank: 1 })[0], /^token age 25\.0 h > 24 h$/);
  assert.deepEqual(reasons((r) => { r.active_tvl = 9_999; }), ["active TVL $9,999 < $10,000"]);
  assert.deepEqual(reasons((r) => { r.token_x.market_cap = 99_000; }), ["market cap $99,000 < $100,000"]);
  assert.deepEqual(reasons((r) => { r.base_token_holders = 499; }), ["holders 499 < 500"]);
  assert.deepEqual(reasons(() => {}, (s) => ({ ...s, fees_sol: 29.9 })), ["token fees 29.90 SOL < 30 SOL"]);
  assert.deepEqual(reasons(() => {}, (s) => ({ ...s, fees_sol: null })), ["token fees unknown"]);
  assert.deepEqual(reasons(() => {}, (s) => ({ ...s, mint: { ...s.mint, mint_authority: "Auth111" } })), ["mint authority enabled (on chain)"]);
  assert.deepEqual(reasons(() => {}, (s) => ({ ...s, mint: { ...s.mint, freeze_authority: "Auth111" } })), ["freeze authority enabled (on chain)"]);
  assert.deepEqual(reasons(() => {}, (s) => ({ ...s, mint: { read: false } })), ["mint account unreadable"]);
  assert.deepEqual(L.laneQualifies(WINSTON, null, ok).reasons, ["token safety reads unavailable"], "a failed safety read never qualifies");
  // the API's own flags are a free pre-filter
  assert.deepEqual(reasons((r) => { r.token_x.has_mint_authority = true; }), ["mint authority enabled"]);
  // blacklists
  assert.deepEqual(L.laneRowChecks(WINSTON, { ...ok, isBlacklisted: (m) => m === WINSTON.token_x.address }), ["token blacklisted"]);
  const withDev = clone(WINSTON); withDev.token_x.dev = "Dev1111";
  assert.deepEqual(L.laneRowChecks(withDev, { ...ok, isDevBlocked: (d) => d === "Dev1111" }), ["dev blocklisted"]);
  assert.deepEqual(L.laneRowChecks(WINSTON, { ...ok, isBlacklisted: () => { throw new Error("x"); } }), ["token blacklist unreadable"]);
});

test("Token-2022 extensions: transfer fee and transfer hook are read from the jsonParsed mint", () => {
  const w = L.parseMintSafety(FX.winston_mint_account);
  assert.equal(w.read, true);
  assert.equal(w.program, L.TOKEN_2022_PROGRAM);
  assert.deepEqual([w.mint_authority, w.freeze_authority, w.transfer_fee_bps, w.transfer_hook_program], [null, null, 0, null]);
  const withExt = (ext) => { const v = clone(FX.winston_mint_account); v.data.parsed.info.extensions.push(ext); return L.parseMintSafety(v); };
  const fee = withExt({ extension: "transferFeeConfig", state: { olderTransferFee: { transferFeeBasisPoints: 0 }, newerTransferFee: { transferFeeBasisPoints: 20 } } });
  assert.equal(fee.transfer_fee_bps, 20);
  assert.deepEqual(L.laneSafetyChecks({ mint: fee, fees_sol: 61 }), ["transfer fee 20 bps"]);
  const zeroFee = withExt({ extension: "transferFeeConfig", state: { olderTransferFee: { transferFeeBasisPoints: 0 }, newerTransferFee: { transferFeeBasisPoints: 0 } } });
  assert.deepEqual(L.laneSafetyChecks({ mint: zeroFee, fees_sol: 61 }), [], "a fee config at 0 bps is no transfer fee");
  const hook = withExt({ extension: "transferHook", state: { authority: null, programId: "Hook111111111111111111111111111111111111111" } });
  assert.deepEqual(L.laneSafetyChecks({ mint: hook, fees_sol: 61 }), ["transfer hook"]);
  const noHook = withExt({ extension: "transferHook", state: { authority: null, programId: null } });
  assert.deepEqual(L.laneSafetyChecks({ mint: noHook, fees_sol: 61 }), []);
  assert.deepEqual(L.parseMintSafety(null), { read: false });
});

test("the list request is the UI's query, encoded as one filter_by value; the tracking batch uses pool_address=[…]", () => {
  const u = L.laneListUrl("https://x");
  assert.equal(u, "https://x/pools?page_size=50&timeframe=2h&category=top&filter_by=pool_type%3Ddlmm%26%26dlmm_collect_fee_mode%3Dboth%26%26base_token_market_cap%3E%3D70000%26%26base_token_holders%3E%3D15%26%26volume%3E%3D1000%26%26fee%3E%3D5%26%26active_tvl%3E%3D10000");
  assert.equal(decodeURIComponent(new URL(u).searchParams.get("filter_by")), L.LANE_LIST_FILTER);
  const t = new URL(L.laneTrackUrl("https://x", ["A", "B"]));
  assert.equal(t.searchParams.get("filter_by"), "pool_address=[A,B]");
  assert.equal(t.searchParams.get("timeframe"), "5m");
});

test("snapshot, active bin from pool_price, tick and the would-enter line", () => {
  const snap = L.laneSnapshot(WINSTON, winstonSafety(), { now: NOW, rank: 1 });
  assert.equal(snap.rank, 1);
  assert.equal(snap.pool, WINSTON_POOL);
  assert.equal(snap.token_age_min, 149);
  assert.equal(snap.recorded.fee_pct, 3);
  assert.equal(snap.row.pool_address, WINSTON_POOL, "the whole API row is kept");
  // 2.0112e-6 SOL / token, 6 decimals, bin step 100: ln(2.0112e-3)/ln(1.01)
  assert.equal(snap.active_bin, Math.round(Math.log(WINSTON.pool_price * 1e3) / Math.log(1.01)));
  assert.equal(L.priceToBin(Math.pow(1.01, -5) / 1e3, 100, 6, 9), -5);
  assert.equal(L.priceToBin(null, 100, 6), null);
  const tk = L.tickFromRow(WINSTON, { at: NOW, rank: 1 });
  assert.deepEqual([tk.seen, tk.active_bin, tk.fee_usd, tk.fee_window_min, tk.rank], [true, snap.active_bin, WINSTON.fee, 5, 1]);
  assert.equal(L.unseenTick(NOW).seen, false);
  assert.equal(L.wouldEnterLine(snap), "[FRESH_LANE_SHADOW] would-enter WINSTON-SOL: rank #1 on the 2h list, token age 149m, active TVL $11,037, mcap $146,390, fee tier 3 %, bot holders 39.2 % (freshLaneMode=shadow)");
});

test("one paper entry per pool per episode: blocked while open and for 6 h after the window", () => {
  const H = 3_600_000;
  const prev = [{ entered_at: NOW, track_hours: 6 }];
  assert.equal(L.episodeAllows([], NOW, 6).ok, true);
  assert.deepEqual([L.episodeAllows(prev, NOW + 5 * H, 6).ok, L.episodeAllows(prev, NOW + 5 * H, 6).reason], [false, "paper entry still open"]);
  assert.deepEqual([L.episodeAllows(prev, NOW + 7 * H, 6).ok, L.episodeAllows(prev, NOW + 7 * H, 6).reason], [false, "inside the 6 h gap after the last entry's window"]);
  assert.equal(L.episodeAllows(prev, NOW + 12 * H - 1, 6).ok, false);
  assert.equal(L.episodeAllows(prev, NOW + 12 * H, 6).ok, true);
  assert.equal(L.episodeAllows([{ entered_at: new Date(NOW).toISOString(), track_hours: 2 }], NOW + 8 * H, 6).ok, true, "the entry's own track_hours counts");
});

test("config: freshLaneMode off | shadow (no enforce), poll ≥ 30 s, tracking 1–24 h; update_config validates them", async () => {
  assert.deepEqual(L.freshLaneConfig({}), { mode: "shadow", pollSec: 45, trackHours: 6 });
  assert.equal(L.freshLaneConfig({ freshLaneMode: "off" }).mode, "off");
  assert.equal(L.freshLaneConfig({ freshLaneMode: "enforce" }).mode, "shadow", "there is no enforce");
  assert.equal(L.freshLaneConfig({ freshLanePollSec: 5 }).pollSec, 30);
  assert.equal(L.freshLaneConfig({ freshLaneTrackHours: 99 }).trackHours, 24);
  assert.equal(L.freshLaneConfig({ freshLaneTrackHours: 0 }).trackHours, 6);
  const { config } = await import("../config.js");
  assert.deepEqual([config.screening.freshLaneMode, config.screening.freshLanePollSec, config.screening.freshLaneTrackHours], ["shadow", 45, 6]);
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exe, /freshLaneMode: \["screening", "freshLaneMode"\]/);
  assert.match(exe, /"freshLaneMode" && !FRESH_LANE_MODES\.includes\(val\)/);
  assert.match(exe, /freshLanePollSec: \["screening", "freshLanePollSec"\]/);
  assert.match(exe, /freshLaneTrackHours: \["screening", "freshLaneTrackHours"\]/);
  assert.match(fs.readFileSync(new URL("../config.js", import.meta.url), "utf8"), /fresh\.freshLaneMode/);
  assert.equal(L.isValidFreshLanePollSec(29), false);
  assert.equal(L.isValidFreshLanePollSec(30), true);
  assert.equal(L.isValidFreshLaneTrackHours(25), false);
});

test("rate headers: reset is read as unix seconds", () => {
  const h = new Map([["x-ratelimit-limit", "150"], ["x-ratelimit-remaining", "3"], ["x-ratelimit-reset", "1795794060"]]);
  assert.deepEqual(L.parseRateHeaders(h, NOW), { limit: 150, remaining: 3, resetMs: 1795794060000 });
  assert.equal(L.parseRateHeaders(new Map([["x-ratelimit-reset", "5"]]), NOW).resetMs, NOW + 5000);
  assert.deepEqual(L.parseRateHeaders(null, NOW), { limit: null, remaining: null, resetMs: null });
});

// ── capture runtime ──────────────────────────────────────────────────────────────────────────
function res(body, { status = 200, headers = {} } = {}) {
  return { status, ok: status >= 200 && status < 300, headers: new Map(Object.entries(headers)), json: async () => body };
}
function harness({ rows = [clone(WINSTON)], list, track, quote, tokenInfo, mint, cfg = {}, paused = () => false, pendingFile = null, store: storeOverride = null } = {}) {
  const clock = { t: NOW };
  const logs = [];
  const calls = { list: 0, track: 0, hour: 0, quotes: [], mint: 0, info: 0 };
  const store = storeOverride || { trades: [], updates: [], ticks: [], failed: new Set(), insertTrade(t) { this.trades.push(clone(t)); }, updateTrade(id, f) { this.updates.push({ id, ...clone(f) }); }, insertTick(k) { this.ticks.push(clone(k)); }, isFailed(id) { return this.failed.has(id); }, async loadRecent() { return []; } };
  const lane = P.createFreshLane({
    getConfig: () => ({ freshLaneMode: "shadow", freshLaneTrackHours: 6, ...cfg }),
    discoveryBase: "https://disc",
    fetchImpl: async (url) => {
      if (url.includes("category=top")) { calls.list++; return list ? list(clock.t) : res({ data: rows }); }
      const hour = new URL(url).searchParams.get("timeframe") === "1h";
      if (hour) calls.hour++; else calls.track++;
      if (track) return track(url, clock.t);
      const pools = decodeURIComponent(new URL(url).searchParams.get("filter_by")).replace(/^pool_address=\[|\]$/g, "").split(",");
      return res({ data: rows.filter((r) => pools.includes(r.pool_address)).map((r) => (hour ? { ...r, fee: 240 } : r)) }, { headers: { date: new Date(clock.t).toUTCString() } });
    },
    getTokenInfo: async (a) => { calls.info++; return tokenInfo ? tokenInfo(a) : { results: [{ mint: a.query, global_fees_sol: 61.08, audit: { bot_holders_pct: "39.18", mint_disabled: true, freeze_disabled: true } }] }; },
    readMintAccount: async () => { calls.mint++; return mint ? mint() : FX.winston_mint_account; },
    getQuote: async (a) => { calls.quotes.push({ ...a, at: clock.t }); if (quote) return quote(a, clock.t); return a.input_mint === SOL ? { out_amount: 3_200_000_000, price_impact_pct: 1.2 } : { out_amount: 480_000_000 }; },
    store,
    log: (cat, m) => logs.push(m),
    quotesPaused: paused,
    pendingFile,
    now: () => clock.t,
  });
  return { lane, clock, logs, calls, store };
}

test("a qualifying pool opens ONE paper entry with its snapshot, ticks and entry quotes; the would-enter line is logged once", async () => {
  const h = harness();
  await h.lane.tick();
  assert.equal(h.store.trades.length, 1);
  const t = h.store.trades[0];
  assert.equal(t.lane, "paper");
  assert.equal(t.pool, WINSTON_POOL);
  assert.equal(t.entry.rank, 1);
  assert.equal(t.entry.row.pool_address, WINSTON_POOL);
  assert.equal(t.entry.safety.fees_sol, 61.08);
  assert.equal(h.logs.filter((m) => m.startsWith("[FRESH_LANE_SHADOW] would-enter WINSTON-SOL")).length, 1);
  assert.equal(h.store.ticks.length, 1, "the entry poll also records the first tick");
  assert.deepEqual(h.calls.quotes.map((q) => [q.input_mint === SOL ? "buy" : "sell", q.amount_raw, q.skip_taker]), [["buy", 500_000_000, true], ["sell", 3_200_000_000, true]]);
  const last = h.store.updates.at(-1).entry.quotes;
  assert.equal(last.buy.out_raw, 3_200_000_000);
  assert.ok(Math.abs(last.buy.tokens_value_sol - 3200 * WINSTON.pool_price) < 1e-12);
  assert.ok(Number.isFinite(last.sell_entry.ratio));
  // the same pool on the next polls: no second entry, one tick per poll
  for (let i = 0; i < 3; i++) { h.clock.t += 45_000; await h.lane.tick(); }
  assert.equal(h.store.trades.length, 1);
  assert.equal(h.store.ticks.length, 4);
  assert.equal(h.calls.mint, 1, "safety reads are cached");
});

test("tracking ends after freshLaneTrackHours; a new entry only 6 h after the window", async () => {
  const H = 3_600_000;
  const h = harness({ cfg: { freshLaneTrackHours: 1 } });
  await h.lane.tick();
  h.clock.t = NOW + H + 1;
  await h.lane.tick();
  assert.deepEqual(h.store.updates.filter((u) => u.status).map((u) => u.status), ["ended"]);
  const ticksAfterEnd = h.store.ticks.length;
  h.clock.t = NOW + 3 * H; await h.lane.tick();
  assert.equal(h.store.ticks.length, ticksAfterEnd, "no tick after the window");
  assert.equal(h.store.trades.length, 1, "inside the 6 h gap");
  // the row is ~3 h old token at fixture time; move the token's creation forward so it still qualifies
  h.clock.t = NOW + 7 * H;
  const rows = [clone(WINSTON)]; rows[0].token_x.created_at = h.clock.t - 3 * H;
  const h2 = harness({ rows, cfg: { freshLaneTrackHours: 1 } });
  h2.clock.t = NOW; await h2.lane.tick();
  h2.clock.t = NOW + 7 * H; await h2.lane.tick();
  assert.equal(h2.store.trades.length, 2, "1 h window + 6 h gap passed → a new episode");
});

test("failure isolation: a throwing or rejecting fetch, mint read, token info, quote or store never escapes tick()", async () => {
  const boom = () => { throw new Error("boom"); };
  for (const k of ["list", "track", "tokenInfo", "mint", "quote"]) {
    const h = harness({ [k]: boom });
    await assert.doesNotReject(h.lane.tick(), k);
    h.clock.t += 45_000;
    await assert.doesNotReject(h.lane.tick(), `${k} second`);
    const lines = h.logs.filter((m) => /^\[FRESH_LANE\] .* failed: boom/.test(m));
    assert.equal(lines.length, 1, `${k}: logged once per cause per 10 min (${h.logs.join(" | ")})`);
  }
  // a store whose methods throw
  const h = harness();
  h.store.insertTrade = boom; h.store.insertTick = boom; h.store.updateTrade = boom;
  await assert.doesNotReject(h.lane.tick());
  // the timer wrapper swallows a rejecting tick
  const lane = { tick: async () => { throw new Error("x"); } };
  const timer = P.startFreshLaneTimer(lane, () => 30);
  timer.stop();
});

test("a 429 from the discovery API pauses the lane 10 min; a low x-ratelimit-remaining slows it to the reset", async () => {
  let status = 429;
  const h = harness({ list: () => res({}, { status }) });
  await h.lane.tick();
  assert.equal(h.calls.list, 1);
  status = 200;
  h.clock.t += 5 * 60_000; await h.lane.tick();
  assert.equal(h.calls.list, 1, "no request inside the 10-min back-off");
  h.clock.t += 5 * 60_000 + 1; await h.lane.tick();
  assert.equal(h.calls.list, 2);
  const h2 = harness({ list: (t) => res({ data: [clone(WINSTON)] }, { headers: { "x-ratelimit-remaining": "2", "x-ratelimit-reset": String(Math.floor((t + 20_000) / 1000)) } }) });
  await h2.lane.tick();
  assert.equal(h2.calls.track, 0, "tracking skipped when the list said slow down");
  h2.clock.t += 10_000; await h2.lane.tick();
  assert.equal(h2.calls.list, 1);
  h2.clock.t += 15_000; await h2.lane.tick();
  assert.equal(h2.calls.list, 2);
});

test("quotes: ≤ 4 per minute overall, a Jupiter 429 is skipped (quotes pause 60 s), sells every 15 min", async () => {
  let q429 = true;
  const h = harness({ quote: (a) => { if (q429) throw new Error("Swap V2 quote failed: 429 Too Many Requests"); return a.input_mint === SOL ? { out_amount: 1e9 } : { out_amount: 4e8 }; } });
  await h.lane.tick();
  assert.equal(h.calls.quotes.length, 1, "the buy quote was tried once and skipped");
  q429 = false;
  h.clock.t += 45_000; await h.lane.tick();
  assert.equal(h.calls.quotes.length, 1, "quotes paused 60 s after a 429");
  h.clock.t += 45_000; await h.lane.tick();
  assert.equal(h.calls.quotes.length, 3, "buy retried (attempt 2) + entry sell");
  const sells = () => h.calls.quotes.filter((q) => q.input_mint !== SOL).length;
  h.clock.t = NOW + 14 * 60_000; await h.lane.tick();
  assert.equal(sells(), 1, "the next sell is due 15 min after the entry");
  h.clock.t = NOW + 15 * 60_000; await h.lane.tick();
  assert.equal(sells(), 2, "15-min sell");
  h.clock.t = NOW + 16 * 60_000; await h.lane.tick();
  assert.equal(sells(), 2, "then not again before 30 min");
  assert.ok(h.store.ticks.some((k) => k.sell_quote && Number.isFinite(k.sell_quote.ratio)), "the sell quote rides on that poll's tick");
  // budget: 6 qualifying pools in one poll would need 12 entry quotes; at most 4 in a minute
  const rows = FX.rows.slice(0, 5).map((r, i) => { const c = clone(WINSTON); c.pool_address = `Pool${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`; c.token_x.address = `Mint${i}`; return c; });
  const h3 = harness({ rows });
  await h3.lane.tick();
  h3.clock.t += 45_000; await h3.lane.tick();
  const inFirstMinute = h3.calls.quotes.filter((q) => q.at - NOW < 60_000).length;
  assert.ok(inFirstMinute <= 4, `${inFirstMinute} quotes in the first minute`);
  assert.equal(h3.store.trades.length, 4, "≤ 2 new safety reads per poll: 2 entries per poll");
});

test("while a transaction may be in flight only the QUOTES pause; discovery and ticks go on; mode off does nothing", async () => {
  let paused = true;
  const h = harness({ paused: () => paused });
  await h.lane.tick();
  assert.equal(h.calls.list, 1, "the discovery read is never paused");
  assert.equal(h.store.trades.length, 1);
  assert.equal(h.store.ticks.length, 1);
  assert.equal(h.calls.quotes.length, 0, "no quote while paused");
  paused = false;
  h.clock.t += 45_000; await h.lane.tick();
  assert.equal(h.calls.quotes.length, 2, "buy + entry sell once the pause is over");
  // a throwing indicator counts as paused
  const h2 = harness({ paused: () => { throw new Error("x"); } });
  await h2.lane.tick();
  assert.equal(h2.calls.quotes.length, 0);
  const off = harness({ cfg: { freshLaneMode: "off" } });
  await off.lane.tick();
  assert.deepEqual([off.calls.list, off.calls.track, off.store.trades.length], [0, 0, 0]);
  assert.equal(off.lane.noteOperatorAdoption({ position: "Pos1", pool: WINSTON_POOL, row: clone(WINSTON), owner: "manual" }), false);
});

test("F2: no buy quote → the entry is kept, the buy is tried on the entry poll + 2 more, then the entry sell is taken anyway (entry_quote missing)", async () => {
  const h = harness({ quote: (a) => (a.input_mint === SOL ? null : { out_amount: 470_000_000 }) });
  for (let i = 0; i < 4; i++) { await h.lane.tick(); h.clock.t += 45_000; }
  assert.equal(h.store.trades.length, 1, "the entry is recorded whatever the quotes do");
  assert.equal(h.calls.quotes.filter((q) => q.input_mint === SOL).length, 3);
  const sells = h.calls.quotes.filter((q) => q.input_mint !== SOL);
  assert.equal(sells.length, 1);
  assert.equal(sells[0].amount_raw, Math.floor((0.5 / WINSTON.pool_price) * 1e6), "◎0.5 worth at the active-bin price");
  const entry = h.store.updates.at(-1).entry;
  assert.equal(entry.entry_quote, "missing");
  assert.equal(entry.quotes.base_raw_source, "price");
  assert.ok(Number.isFinite(entry.quotes.sell_entry.ratio));
  // the 15-min sells use the same base amount
  h.clock.t = NOW + 15 * 60_000; await h.lane.tick();
  assert.equal(h.calls.quotes.filter((q) => q.input_mint !== SOL).length, 2);
});

test("a pool missing from the batch answer for 20 polls ends its entry as vanished; a failed insert is forgotten with no tick", async () => {
  let present = true;
  const h = harness({ track: (url, t) => res({ data: present ? [clone(WINSTON)] : [] }, { headers: { date: new Date(t).toUTCString() } }) });
  await h.lane.tick();
  present = false;
  for (let i = 0; i < 20; i++) { h.clock.t += 45_000; await h.lane.tick(); }
  const end = h.store.updates.find((u) => u.status === "ended");
  assert.ok(end, "ended");
  assert.equal(end.entry.ended_reason, "vanished");
  assert.equal(h.store.ticks.filter((k) => k.seen === false).length, 20);
  // insert failed
  const h2 = harness();
  h2.store.insertTrade = function (t) { this.failed.add(t.id); };
  await h2.lane.tick();
  assert.equal(h2.store.ticks.length, 0, "no tick for a trade that was never persisted");
  assert.equal(h2.lane._state().trades.size, 0);
  assert.ok(h2.logs.some((m) => /was not stored — entry dropped/.test(m)));
});

test("ticks carry the raw 5m bucket fee, its bucket start (server Date − 30 s lag) and, once per bucket, the 1h fee", async () => {
  const h = harness();
  await h.lane.tick();
  const k0 = h.store.ticks[0];
  assert.equal(k0.fee_usd, WINSTON.fee);
  assert.equal(k0.fee_time_source, "server");
  const sec = Math.floor(NOW / 1000) * 1000; // the Date header has second resolution
  assert.equal(k0.fee_bucket_start, new Date(Math.floor((sec - 30_000) / 300_000) * 300_000).toISOString());
  assert.equal(k0.fee_1h_usd, 240);
  h.clock.t += 45_000; await h.lane.tick();
  const sameBucket = Math.floor((h.clock.t - 30_000) / 300_000) === Math.floor((NOW - 30_000) / 300_000);
  assert.equal(h.store.ticks[1].fee_1h_usd, sameBucket ? null : 240);
  assert.equal(h.calls.hour, sameBucket ? 1 : 2, "the 1h batch once per bucket");
  assert.equal(L.feeBucketStart(Date.parse("2026-11-27T16:25:12Z")), Date.parse("2026-11-27T16:20:00Z"), "12 s after the boundary the answer is still the old bucket");
  assert.equal(L.feeBucketStart(Date.parse("2026-11-27T16:25:31Z")), Date.parse("2026-11-27T16:25:00Z"));
});

test("risky Token-2022 extensions are recorded, not gated", () => {
  const v = clone(FX.winston_mint_account);
  v.data.parsed.info.extensions.push({ extension: "permanentDelegate", state: { delegate: "Del1111" } }, { extension: "defaultAccountState", state: { accountState: "frozen" } }, { extension: "pausableConfig", state: {} }, { extension: "confidentialTransferMint", state: {} });
  const m = L.parseMintSafety(v);
  assert.deepEqual(m.risky_extensions, { permanent_delegate: "Del1111", default_account_state_frozen: true, pausable: true, confidential_transfer: true });
  assert.deepEqual(L.laneSafetyChecks({ mint: m, fees_sol: 61 }), [], "not gated");
  assert.equal(L.laneSnapshot(WINSTON, { mint: m, fees_sol: 61 }, { now: NOW, rank: 1 }).recorded.risky_extensions.pausable, true);
  assert.deepEqual(L.parseMintSafety(FX.winston_mint_account).risky_extensions, { permanent_delegate: null, default_account_state_frozen: null, pausable: false, confidential_transfer: false });
});

test("operator capture: a manual adoption in the class is recorded as lane 'operator' with no network call on the adoption path", async () => {
  const h = harness({ rows: [] }); // the pool is not on the list now
  const before = { ...h.calls, quotes: h.calls.quotes.length };
  assert.equal(h.lane.noteOperatorAdoption({ position: "PosOp1", pool: WINSTON_POOL, row: clone(WINSTON), owner: "manual" }), true);
  assert.deepEqual([h.calls.list, h.calls.track, h.calls.mint, h.calls.info, h.calls.quotes.length], [before.list, before.track, before.mint, before.info, before.quotes], "noteOperatorAdoption is synchronous and fetches nothing");
  assert.equal(h.lane.noteOperatorAdoption({ position: "PosOp1", pool: WINSTON_POOL, row: clone(WINSTON), owner: "manual" }), false, "once per position");
  assert.equal(h.lane.noteOperatorAdoption({ position: "PosBot", pool: WINSTON_POOL, row: clone(WINSTON), owner: "bot" }), false, "a bot deploy is not an operator entry");
  const old = clone(WINSTON); old.token_x.created_at = NOW - 48 * 3_600_000;
  assert.equal(h.lane.noteOperatorAdoption({ position: "PosOld", pool: WINSTON_POOL, row: old, owner: "manual" }), false, "outside the class (token age)");
  assert.equal(h.lane.noteOperatorAdoption(null), false);
  // the next poll does the safety reads and opens the entry
  h.clock.t += 45_000;
  await h.lane.tick();
  const op = h.store.trades.find((t) => t.lane === "operator");
  assert.ok(op);
  assert.equal(op.position, "PosOp1");
  assert.equal(op.entry.qualifies_full, false, "off the 2h list → the full definition is not met");
  assert.ok(op.entry.full_reasons.includes("not on the 2h top list"));
  assert.ok(h.logs.some((m) => m.startsWith("[FRESH_LANE_SHADOW] operator entry captured WINSTON-SOL (PosOp1")));
  assert.equal(h.store.trades.filter((t) => t.lane === "paper").length, 0);
});

test("operator capture keeps the rank of a fresh list and stamps qualifies_full", async () => {
  const h = harness();
  await h.lane.tick(); // WINSTON on the list at #1 (and a paper entry)
  h.clock.t += 60_000;
  h.lane.noteOperatorAdoption({ position: "PosOp2", pool: WINSTON_POOL, row: clone(WINSTON), owner: "manual" });
  h.clock.t += 45_000; await h.lane.tick();
  const op = h.store.trades.find((t) => t.lane === "operator");
  assert.equal(op.entry.rank, 1);
  assert.equal(op.entry.qualifies_full, true);
  assert.equal(h.store.trades.filter((t) => t.lane === "paper").length, 1, "the operator entry does not open or block a paper entry");
});

test("a restart restores open entries from the store and keeps the episode rule; a failed restore captures nothing and retries every 10 min", async () => {
  const H = 3_600_000;
  const h = harness();
  h.store.loadRecent = async () => [{ id: "paper-3Ey68w4b-1", pool: WINSTON_POOL, base_mint: WINSTON.token_x.address, pair: "WINSTON-SOL", lane: "paper", position: null, entered_at: new Date(NOW - H).toISOString(), track_hours: 6, entry: { quotes: { buy: null, sell_entry: null }, dec_x: 6 }, status: "open" }];
  await h.lane.tick();
  assert.equal(h.store.trades.length, 0, "the restored open entry blocks a second one");
  assert.equal(h.store.ticks.length, 1);
  assert.equal(h.store.ticks[0].trade_id, "paper-3Ey68w4b-1");
  assert.equal(h.calls.quotes.filter((q) => q.input_mint === SOL).length, 0, "no late entry buy quote after a restart");
  assert.ok(h.logs.some((m) => /restored 1 recent lane entry/.test(m)));
  // the store cannot be read (tables absent): nothing is captured, retried after 10 min
  const h2 = harness();
  let loads = 0, ok = false;
  h2.store.loadRecent = async () => { loads++; return ok ? [] : null; };
  await h2.lane.tick();
  h2.clock.t += 45_000; await h2.lane.tick();
  assert.deepEqual([loads, h2.calls.list, h2.store.trades.length], [1, 0, 0]);
  ok = true;
  h2.clock.t = NOW + 10 * 60_000; await h2.lane.tick();
  assert.deepEqual([loads, h2.calls.list, h2.store.trades.length], [2, 1, 1]);
});

test("an operator note survives a restart (pending file) and is processed after the restore", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lane-pend-")), "p.json");
  const h = harness({ rows: [], pendingFile: file });
  await h.lane.tick();
  h.lane.noteOperatorAdoption({ position: "PosOp9", pool: WINSTON_POOL, row: clone(WINSTON), owner: "manual" });
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).PosOp9, "written at once");
  const h2 = harness({ rows: [], pendingFile: file }); // the restart
  h2.clock.t = NOW + 60_000;
  await h2.lane.tick();
  assert.equal(h2.store.trades.filter((t) => t.lane === "operator" && t.position === "PosOp9").length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {}, "cleared once processed");
});
