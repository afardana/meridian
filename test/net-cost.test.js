process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_CHAT_ID = "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import bs58 from "bs58";

// 2026-10-12: display-only net-of-cost estimate on open positions. Entry cost = the premium a
// two-sided position's base-token purchase paid over the active-bin price (measured from the
// zap transactions, or known at the bot's own straddle buy); exit cost = a slow sell quote.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }), text: async () => "" });

const N = await import("../net-cost.js");
const S = await import("../state.js");
await S.ensureStateInitialized();
const I = await import("../index.js");
const { reportNetCostFields } = N;

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/close-audit-zap.json", import.meta.url), "utf8"));
const EV = JSON.parse(fs.readFileSync(new URL("./fixtures/net-cost-event.json", import.meta.url), "utf8"));
const W = "WALLET", M = "MINT";
const near = (a, b, eps = 2e-6) => Math.abs(a - b) <= eps;
const src = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

test("the DLMM deposit events carry the active bin", () => {
  // CRAWL-SOL CGx8fxL8's opening deposit, event instruction read on chain (the zap's own
  // Rebalancing events, same layout family, reported the same bin).
  const tx = { meta: { innerInstructions: [{ instructions: [{ programId: "11111111111111111111111111111111", data: "3Bxs" }, EV.CGx8fxL8_add_liquidity] }] } };
  const bins = N.decodeDlmmActiveBins(tx);
  assert.equal(bins.length, 1);
  assert.deepEqual([bins[0].event, bins[0].active_bin, bins[0].position], ["AddLiquidity", -377, "CGx8fxL8ZDx72RsiNw2WdSySxgU3JJFErFGTLSrjF4kN"]);
  // Rebalancing (what RebalanceLiquidity and the UI zap emit): tag, discriminator, lb_pair,
  // position, owner, active_bin_id i32 — layout from the SDK's IDL; read live as −377 / −301.
  const buf = new Uint8Array(16 + 96 + 4 + 64);
  buf.set([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d, 0, 109, 117, 179, 61, 91, 199, 200]);
  buf.set(bs58.decode("CGx8fxL8ZDx72RsiNw2WdSySxgU3JJFErFGTLSrjF4kN"), 48);
  new DataView(buf.buffer).setInt32(112, -301, true);
  const reb = N.decodeDlmmActiveBins({ meta: { innerInstructions: [{ instructions: [{ programId: EV.CGx8fxL8_add_liquidity.programId, data: bs58.encode(buf) }] }] } });
  assert.deepEqual(reb, [{ event: "Rebalancing", position: "CGx8fxL8ZDx72RsiNw2WdSySxgU3JJFErFGTLSrjF4kN", active_bin: -301 }]);
  assert.deepEqual(N.decodeDlmmActiveBins({ meta: {} }), []);
  assert.deepEqual(N.decodeDlmmActiveBins({ meta: { innerInstructions: [{ instructions: [{ programId: EV.CGx8fxL8_add_liquidity.programId, data: "not base58 !!" }] }] } }), []);
});

test("bin price: (1 + step)^bin scaled by the decimals", () => {
  assert.ok(near(N.binPriceSolPerToken(0, 100, 9, 9), 1));
  assert.ok(near(N.binPriceSolPerToken(-377, 100, 6, 9), Math.pow(1.01, -377) * 1e-3, 1e-12));
  assert.equal(N.binPriceSolPerToken(null, 100, 6), null);
  assert.equal(N.binPriceSolPerToken(-377, null, 6), null);
});

test("entry cost of a recorded UI zap: SOL spent − tokens × the active-bin price", () => {
  // The four-transaction bundle of CRAWL-SOL CGx8fxL8 (close-audit fixture; it is trimmed to
  // balances, so the bin comes from the event decoded above: −377, bin step 100, 6 decimals).
  const purchases = N.findZapPurchases({ posTxs: FX.CGx8fxL8.posTxs, walletTxs: FX.CGx8fxL8.walletTxs, wallet: W, baseMint: M });
  assert.equal(purchases.length, 1, "one purchase; the exit swap and the fee swaps are sales");
  assert.ok(near(purchases[0].tokens, 33755.232935, 1e-6) && near(purchases[0].spent_sol, 0.813085, 2e-6));
  assert.equal(purchases[0].active_bin, null, "the trimmed fixture carries no event");
  const res = N.measureEntryCost({ purchases, binStep: 100, decX: 6, decY: 9, hintBin: -377 });
  // 33,755.23 × 0.0234875e-3 = ◎0.792836 at the bin; ◎0.813085 paid → ◎0.020250 (2.55 % above)
  assert.equal(res.events, 1);
  assert.ok(near(res.cost_sol, 0.02025, 5e-6), `cost ${res.cost_sol}`);
  assert.equal(res.detail[0].premium_pct, 2.55);
  assert.equal(res.detail[0].ref_from, "hint");
  // signed: a purchase that itself pushed the pool's bin up before the deposit landed was
  // booked ABOVE what it cost (darwin-SOL EKJDLcWh: 78,596.77 tokens for ◎0.532971, deposit bin −499)
  const neg = N.measureEntryCost({ purchases: [{ t: 1, slot: 1, tokens: 78596.77342, spent_sol: 0.532971, active_bin: -499 }], binStep: 100, decX: 6 });
  assert.ok(near(neg.cost_sol, -0.015355, 5e-6) && neg.detail[0].premium_pct === -2.8 && neg.detail[0].ref_from === "event");
  // the close audit's unexplained gap on this position was ◎0.0214 (booked − wallet, less rent)
  const patch = N.mergeEntryCost({}, { kind: "measured", cost_sol: res.cost_sol, events: res.events, at: "2026-10-12T00:00:00.000Z" });
  assert.deepEqual([patch.entry_cost_events, patch.entry_cost_source], [1, "measured"]);
  assert.ok(near(patch.entry_cost_sol, 0.02025, 5e-6));
});

test("a purchase the position did not deposit is not its entry; a straddle's own buy is not read twice", () => {
  // TWEETCRAFT-SOL Ebt68po9: a bot straddle (stage B buy → stage C deposit), then the operator's
  // NEXT position zapped in 119 s after the close — that purchase has no deposit here.
  const all = N.findZapPurchases({ posTxs: FX.Ebt68po9.posTxs, walletTxs: FX.Ebt68po9.walletTxs, wallet: W, baseMint: M });
  assert.equal(all.length, 1, "only the straddle's buy is deposited into this position");
  const buy = all[0];
  // recorded at the straddle (recordInPlaceStraddle, a few seconds after the buy) → skipped
  const again = N.findZapPurchases({ posTxs: FX.Ebt68po9.posTxs, walletTxs: FX.Ebt68po9.walletTxs, wallet: W, baseMint: M, skipTimes: [buy.t + 20] });
  assert.equal(again.length, 0);
  assert.deepEqual(N.straddleTimes({ entry_cost_log: [{ kind: "straddle", at: new Date((buy.t + 20) * 1000).toISOString() }, { kind: "measured", at: "2026-10-01T00:00:00Z" }] }), [buy.t + 20]);
});

test("single-sided ladder: no purchase, cost 0, source none", () => {
  for (const k of ["J4oFb2LY", "3B3hSsZo", "CrSMyq9u", "DPcMPkka"]) {
    const purchases = N.findZapPurchases({ posTxs: FX[k].posTxs, walletTxs: FX[k].walletTxs, wallet: W, baseMint: M });
    assert.equal(purchases.length, 0, k);
  }
  const res = N.measureEntryCost({ purchases: [], binStep: 100, decX: 6 });
  assert.deepEqual([res.cost_sol, res.events, res.unmeasured], [0, 0, 0]);
  const patch = N.mergeEntryCost({}, { kind: "measured", cost_sol: 0, events: 0, at: "2026-10-12T00:00:00.000Z" });
  assert.deepEqual([patch.entry_cost_sol, patch.entry_cost_events, patch.entry_cost_source], [0, 0, "none"]);
  assert.equal(patch.entry_cost_log, undefined);
  // a bot ladder that was never re-ranged is settled without any RPC read
  assert.equal(N.entryCostWork({ adopted: false, rebalance_count: 0 }), "none");
});

test("unavailable: a purchase with no bin cannot be priced; attempts run out", () => {
  const res = N.measureEntryCost({ purchases: [{ t: 1, slot: 1, tokens: 100, spent_sol: 0.5, active_bin: null }], binStep: 100, decX: 6 });
  assert.deepEqual([res.events, res.unmeasured, res.cost_sol], [0, 1, 0]);
  const now = Date.parse("2026-10-12T02:00:00Z");
  const adopted = { adopted: true, adopted_at: "2026-10-12T01:59:50Z" };
  assert.equal(N.entryCostWork(adopted, { nowMs: now }), null, "10 s after adoption: let the RPC index it");
  assert.equal(N.entryCostWork(adopted, { nowMs: now + 60_000 }), "scan");
  assert.equal(N.entryCostWork({ ...adopted, entry_cost_attempts: 3 }, { nowMs: now + 60_000 }), "giveup");
  assert.equal(N.entryCostWork({ ...adopted, entry_cost_source: "measured", entry_cost_rebalances_seen: 0 }, { nowMs: now + 60_000 }), null, "measured once");
  assert.equal(N.entryCostWork({ ...adopted, entry_cost_source: "measured", rebalance_count: 1, entry_cost_rebalances_seen: 0, last_rebalanced_at: "2026-10-12T01:00:00Z" }, { nowMs: now }), "scan", "a re-range is read again");
  assert.equal(N.entryCostWork({ adopted: false, rebalance_count: 1, deployed_at: "2026-10-11T00:00:00Z", last_rebalanced_at: "2026-10-12T01:00:00Z" }, { nowMs: now }), "scan", "a bot ladder the operator re-ranged");
  assert.equal(N.entryCostWork({ closed: true }), null);
  // exposed: the entry side is unknown, the exit side alone is a partial estimate
  const f = N.netCostCardFields(
    { amount_sol: 1, entry_cost_source: "unavailable", active_bin_at_deploy: -300, bin_range: { min: -330, max: -270 }, exit_cost_est_impact_pct: 2, exit_cost_est_gas_sol: 0.0001, exit_cost_est_at: "2026-10-12T01:00:00Z" },
    { pnl_pct: 1.06, liq_x_amount: 1000, fee_x_amount: 0, price_active: 0.0005, token_y_mint: "So11111111111111111111111111111111111111112" }, {});
  assert.deepEqual([f.entry_cost_sol, f.entry_cost_pct, f.entry_cost_source], [null, null, "unavailable"]);
  assert.equal(f.exit_cost_est_sol, 0.0101);        // 0.5 SOL of base × 2 % + gas
  assert.deepEqual([f.net_cost_est_pct, f.net_cost_partial, f.pnl_net_est_pct], [1.01, true, 0.05]);
});

test("the bot's own straddles accumulate; a later measured zap makes the source measured", () => {
  assert.equal(N.straddleEntryCost({ swapSol: 0.2, boughtTokens: 1000, solPerBase: 0.000196 }), 0.2 - 0.196);
  assert.ok(near(N.straddleEntryCost({ swapSol: 0.2, boughtTokens: 1100, solPerBase: 0.000196 }), -0.0156, 1e-12), "signed: filled below the bin price");
  assert.equal(N.straddleEntryCost({ swapSol: 0.2, boughtTokens: 0, solPerBase: 0.000196 }), null);
  const addr = "TEST_NET_COST_STRADDLE_" + Date.now();
  S.trackPosition({ position: addr, pool: "POOL_NC", pool_name: "NC-SOL", amount_sol: 0.4, strategy: "spot" });
  const pos = () => S.getTrackedPosition(addr);
  S.recordInPlaceStraddle(addr, { bin_range: { min: -10, max: 58 }, strategy: "spot", amount_x: 1000, swapped_sol: 0.2, buy_premium_sol: 0.004 });
  assert.deepEqual([pos().entry_cost_sol, pos().entry_cost_events, pos().entry_cost_source], [0.004, 1, "straddle"]);
  S.recordInPlaceStraddle(addr, { bin_range: { min: 0, max: 68 }, strategy: "spot", amount_x: 900, swapped_sol: 0.2, buy_premium_sol: 0.0025 });
  assert.deepEqual([pos().entry_cost_sol, pos().entry_cost_events, pos().entry_cost_source], [0.0065, 2, "straddle"]);
  assert.equal(pos().entry_cost_log.length, 2);
  assert.equal(N.isTwoSided(pos()), true);
  // a straddle without a known premium leaves the cost alone
  S.recordInPlaceStraddle(addr, { bin_range: { min: 0, max: 68 }, strategy: "spot", amount_x: 1, swapped_sol: 0.1 });
  assert.deepEqual([pos().entry_cost_sol, pos().entry_cost_events], [0.0065, 2]);
  // the operator then re-ranges it from the UI: the zap is measured and added
  assert.equal(S.recordNetCostTracking(addr, N.mergeEntryCost(pos(), { kind: "measured", cost_sol: 0.003, events: 1, at: "2026-10-12T03:00:00.000Z" })), true);
  assert.deepEqual([pos().entry_cost_sol, pos().entry_cost_events, pos().entry_cost_source], [0.0095, 3, "measured"]);
  // a scan that finds nothing new keeps what was measured
  const keep = N.mergeEntryCost(pos(), { kind: "measured", cost_sol: 0, events: 0, at: "2026-10-12T04:00:00.000Z" });
  assert.deepEqual([keep.entry_cost_sol, keep.entry_cost_events, keep.entry_cost_source], [0.0095, 3, "measured"]);
  // only the known display keys can be written
  assert.equal(S.recordNetCostTracking(addr, { peak_pnl_pct: 99, hold_mode: true, amount_sol: 5 }), false);
  assert.equal(pos().amount_sol, 0.4);
  S.recordClose(addr, "test");
});

test("two_sided: a base-token leg from a purchase, or a range above the price at entry / the last re-range", () => {
  assert.equal(N.isTwoSided({ active_bin_at_deploy: -378, bin_range: { min: -441, max: -378 } }), false, "bot SOL ladder");
  assert.equal(N.isTwoSided({ adopted: true, active_bin_at_deploy: -302, bin_range: { min: -336, max: -267 } }), true, "UI two-sided open");
  assert.equal(N.isTwoSided({ adopted: true, active_bin_at_deploy: -302, bin_range: { min: -370, max: -302 } }), false, "operator's SOL ladder");
  assert.equal(N.isTwoSided({ entry_cost_events: 1 }), true);
  assert.equal(N.isTwoSided({ straddle_count: 1 }), true);
  assert.equal(N.isTwoSided({ rebalance_count: 1, rebalance_events: [{ new_bins_above: 0, new_bins_below: 69 }] }), false, "re-ranged to a ladder under the price");
  assert.equal(N.isTwoSided({ rebalance_count: 1, rebalance_events: [{ new_bins_above: 34, new_bins_below: 35 }], active_bin_at_deploy: -300, bin_range: { max: -300 } }), true);
  assert.equal(N.isTwoSided({ rebalance_count: 1, active_bin_at_deploy: -300, bin_range: { max: -250 } }), false, "re-ranged, shape unknown: the deploy bin no longer says anything");
  assert.equal(N.isTwoSided(null), false);
});

test("exit estimate: one position's quote per cycle, stalest first, not before the interval", () => {
  const now = Date.parse("2026-10-12T02:00:00Z");
  const at = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
  const tracked = {
    A: { exit_cost_est_tried_at: at(20) },
    B: { exit_cost_est_tried_at: at(5) },          // tried 5 min ago: not due at 900 s
    C: {},                                         // never tried: first
    D: { exit_cost_est_tried_at: at(40), hold_mode: true }, // held positions take part
    E: { closed: true },
  };
  const rows = ["A", "B", "C", "D", "E", "F"].map((position) => ({ position }));
  const q = (extra = {}) => N.exitQuoteQueue(rows, (id) => tracked[id] ?? null, { nowMs: now, minIntervalSec: 900, ...extra });
  assert.deepEqual(q(), ["C", "D", "A"]);
  // the cycle quotes the head only; once stamped it goes to the back and the next one leads
  tracked.C.exit_cost_est_tried_at = at(0);
  assert.deepEqual(q(), ["D", "A"]);
  tracked.D.exit_cost_est_tried_at = at(0);
  assert.deepEqual(q(), ["A"]);
  tracked.A.exit_cost_est_tried_at = at(0);
  assert.deepEqual(q(), [], "everything quoted within the interval: no quote this cycle");
  assert.equal(q({ nowMs: now + 15 * 60_000 + 1000 })[0], "B", "B was tried longest ago");
  assert.deepEqual(q({ minIntervalSec: 60, nowMs: now + 61_000 }).sort(), ["A", "B", "C", "D"]);
});

test("exit impact: the sell quote against the active-bin price", () => {
  assert.ok(near(N.exitImpactFromQuote({ tokens: 1000, solPerToken: 0.0005, solOut: 0.49 }), 2, 1e-9));
  assert.equal(N.exitImpactFromQuote({ tokens: 1000, solPerToken: 0.0005, solOut: 0.51 }), 0, "a quote above the pool price is no cost");
  assert.equal(N.exitImpactFromQuote({ tokens: 0, solPerToken: 0.0005, solOut: 0 }), null);
  assert.equal(N.exitImpactFromQuote({ tokens: 1000, solPerToken: 0.0005, solOut: NaN }), null);
  assert.deepEqual(N.baseSideOf({ liq_x_amount: 900, fee_x_amount: 100, price_active: 0.0005 }), { tokens: 1000, sol_per_token: 0.0005, value_sol: 0.5 });
  assert.equal(N.baseSideOf({ liq_x_amount: 900, price_active: 0.0005, token_y_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }), null, "SOL-quoted pools only");
  assert.equal(N.baseSideOf({ liq_x_amount: 900, price_active: null }), null);
});

test("exposed fields: names, units (% of capital), nulls and the partial flag", () => {
  const SOL = "So11111111111111111111111111111111111111112";
  const row = { pnl_pct: 1.06, liq_x_amount: 4000, fee_x_amount: 0, price_active: 0.00005, token_y_mint: SOL };
  // PQC-like: ◎0.5 capital, entry premium ◎0.0019, 0.2 SOL of base at 1.4 % sell cost + gas
  const pos = {
    amount_sol: 0.5, adopted: true, active_bin_at_deploy: -300, bin_range: { min: -334, max: -266 },
    entry_cost_sol: 0.0019, entry_cost_events: 1, entry_cost_source: "measured",
    exit_cost_est_impact_pct: 1.4, exit_cost_est_gas_sol: 0.0002, exit_cost_est_at: "2026-10-12T01:00:00.000Z",
  };
  const f = N.netCostCardFields(pos, row, { netCostEstimateEnabled: true });
  assert.deepEqual(Object.keys(f).sort(), ["entry_cost_pct", "entry_cost_sol", "entry_cost_source", "exit_cost_est_at", "exit_cost_est_pct", "exit_cost_est_sol", "net_cost_est_pct", "net_cost_partial", "pnl_net_est_pct", "two_sided"]);
  assert.deepEqual(f, {
    two_sided: true,
    entry_cost_sol: 0.0019, entry_cost_pct: 0.38, entry_cost_source: "measured",
    exit_cost_est_sol: 0.003, exit_cost_est_pct: 0.6, exit_cost_est_at: "2026-10-12T01:00:00.000Z",
    net_cost_est_pct: 0.98, net_cost_partial: false, pnl_net_est_pct: 0.08,
  });
  // entry known, no exit quote yet → partial
  const noExit = N.netCostCardFields({ ...pos, exit_cost_est_impact_pct: undefined, exit_cost_est_at: undefined }, row, {});
  assert.deepEqual([noExit.exit_cost_est_sol, noExit.exit_cost_est_pct, noExit.exit_cost_est_at], [null, null, null]);
  assert.deepEqual([noExit.net_cost_est_pct, noExit.net_cost_partial, noExit.pnl_net_est_pct], [0.38, true, 0.68]);
  // nothing known yet → nulls, not zeros
  const fresh = N.netCostCardFields({ amount_sol: 0.5, adopted: true }, row, {});
  assert.deepEqual([fresh.entry_cost_sol, fresh.entry_cost_source, fresh.net_cost_est_pct, fresh.net_cost_partial, fresh.pnl_net_est_pct], [null, null, null, false, null]);
  // a bot SOL ladder: entry 0 / "none"; after the price fell into it the exit estimate still applies
  const ladder = N.netCostCardFields({ amount_sol: 0.4, entry_cost_sol: 0, entry_cost_events: 0, entry_cost_source: "none", active_bin_at_deploy: -378, bin_range: { min: -441, max: -378 }, exit_cost_est_impact_pct: 0, exit_cost_est_gas_sol: 0.0002, exit_cost_est_at: "2026-10-12T01:00:00.000Z" }, { pnl_pct: 0.5, liq_x_amount: 0, price_active: 0.00002, token_y_mint: SOL }, {});
  assert.deepEqual([ladder.two_sided, ladder.entry_cost_sol, ladder.entry_cost_pct, ladder.entry_cost_source], [false, 0, 0, "none"]);
  assert.deepEqual([ladder.exit_cost_est_sol, ladder.exit_cost_est_pct, ladder.net_cost_est_pct, ladder.net_cost_partial, ladder.pnl_net_est_pct], [0.0002, 0.05, 0.05, false, 0.45]);
  // switched off: every estimate null, two_sided still told
  const off = N.netCostCardFields(pos, row, { netCostEstimateEnabled: false });
  assert.deepEqual([off.two_sided, off.entry_cost_sol, off.exit_cost_est_sol, off.net_cost_est_pct, off.pnl_net_est_pct], [true, null, null, null, null]);
  // report doc and tick pass-through
  assert.deepEqual(reportNetCostFields(f), f);
  assert.deepEqual(reportNetCostFields({}), { two_sided: false, entry_cost_sol: null, entry_cost_pct: null, entry_cost_source: null, exit_cost_est_sol: null, exit_cost_est_pct: null, exit_cost_est_at: null, net_cost_est_pct: null, net_cost_partial: false, pnl_net_est_pct: null });
  assert.deepEqual(N.tickNetCostFields(f), { two_sided: true, entry_cost_pct: 0.38, exit_cost_est_pct: 0.6 });
  assert.ok(JSON.stringify(N.tickNetCostFields(f)).length < 80, "the tick stays small");
});

test("config: on by default, 900 s between quotes, both tunable", async () => {
  const { config } = await import("../config.js");
  assert.equal(config.management.netCostEstimateEnabled, true);
  assert.equal(config.management.netCostQuoteMinIntervalSec, 900);
  const ex = src("tools/executor.js");
  assert.match(ex, /netCostEstimateEnabled: \["management", "netCostEstimateEnabled"\]/);
  assert.match(ex, /netCostQuoteMinIntervalSec: \["management", "netCostQuoteMinIntervalSec"\]/);
});

test("Telegram: the net suffix only on two-sided positions with an estimate", () => {
  assert.equal(N.netPnlSuffix({ two_sided: true, pnl_net_est_pct: 1.23 }), " (net ≈ +1.2%)");
  assert.equal(N.netPnlSuffix({ two_sided: true, pnl_net_est_pct: -0.44 }), " (net ≈ -0.4%)");
  assert.equal(N.netPnlSuffix({ two_sided: true, pnl_net_est_pct: null }), "");
  assert.equal(N.netPnlSuffix({ two_sided: false, pnl_net_est_pct: 1.23 }), "");
  assert.equal(N.netPnlSuffix({ pnl_net_est_pct: 1.23 }), "");
  const row = { position: "P1", pair: "PQC-SOL", pool: "POOL", pnl_usd: 0.0053, pnl_pct: 1.06, total_value_usd: 0.5053, unclaimed_fees_usd: 0.001, age_minutes: 42, in_range: true, adopted: true };
  const two = I.renderPositionsListRow({ ...row, two_sided: true, pnl_net_est_pct: 0.01 }, 0, { solMode: true });
  assert.match(two, /PnL: <code>\+◎0\.0053 \(\+1\.06%\) \(net ≈ \+0\.0%\)<\/code>/);
  const single = I.renderPositionsListRow({ ...row, two_sided: false, pnl_net_est_pct: 0.9 }, 0, { solMode: true });
  assert.ok(!single.includes("net ≈"));
  assert.match(single, /PnL: <code>\+◎0\.0053 \(\+1\.06%\)<\/code>/);
  assert.ok(!I.renderPositionsListRow({ ...row, two_sided: true }, 0, { solMode: true }).includes("net ≈"));
  // the rolling management message appends the same suffix after the gross PnL
  assert.match(src("index.js"), /pnlStr \+= netPnlSuffix\(p\);/);
});

test("no rule reads the cost fields", () => {
  const FIELD = /entry_cost|exit_cost_est|net_cost|netCost|pnl_net_est|netPnlSuffix|NetCost/;
  // the single exit evaluator
  const state = src("state.js");
  const a = state.indexOf("export function updatePnlAndCheckExits(");
  const b = state.indexOf("\nexport function getLastBriefingDate(");
  assert.ok(a > 0 && b > a);
  assert.ok(!FIELD.test(state.slice(a, b)), "updatePnlAndCheckExits must not reference the cost fields");
  assert.ok(!/two_sided/.test(state.slice(a, b)));
  // every other rule in state.js: the only references are the straddle bookkeeping and the store
  const stateHits = state.split("\n").filter((l) => FIELD.test(l) && !/^\s*(\/\/|\*)/.test(l));
  for (const l of stateHits) {
    assert.ok(/mergeEntryCost|recordNetCostTracking|NET_COST_FIELDS|^\s*"(entry_cost|exit_cost_est)[a-z_]*",$/.test(l), `unexpected state.js reference: ${l.trim()}`);
  }
  // the rule modules: the hold limit, the TVL exit, the crash paths, the valuation guard, the straddle decision
  for (const f of ["hold-thin-limit.js", "tvl-floor-exit.js", "crash-regime.js", "valuation-jump.js", "harvest-straddle.js", "position-cap.js"]) {
    const s = src(f);
    assert.ok(!FIELD.test(s) && !/two_sided/.test(s), `${f} must not reference the cost fields`);
  }
  // index.js: the poller (fast paths, hold limit, TVL exit, exit confirmation) up to the dashboard tick
  const idx = src("index.js");
  const p0 = idx.indexOf("const pnlPollInterval = setInterval(async () => {");
  const p1 = idx.indexOf("// Lightweight real-time tick for the dashboard", p0);
  assert.ok(p0 > 0 && p1 > p0);
  assert.ok(!FIELD.test(idx.slice(p0, p1)) && !/two_sided/.test(idx.slice(p0, p1)), "the PnL poller's rule section must not reference the cost fields");
  // …and everywhere else in index.js the references are the maintenance block, the display
  // helpers (tick, Telegram) and the adoption kick — never a comparison feeding an exit
  const n0 = idx.indexOf("// ─── Net-of-cost estimates on open positions");
  const n1 = idx.indexOf("async function evaluateCloseEfficiencyGate(");
  assert.ok(n0 > 0 && n1 > n0);
  const outside = (idx.slice(0, n0) + idx.slice(n1)).split("\n").filter((l) => FIELD.test(l) && !/^\s*(\/\/|\*)/.test(l));
  for (const l of outside) {
    assert.ok(/^import |scheduleEntryCostMeasure\(positionAddress\)|await runNetCostMaintenance\(|log\("net_cost"|\.\.\.tickNetCostFields\(p\)|netPnlSuffix\(p\)/.test(l.trim()), `unexpected index.js reference: ${l.trim()}`);
  }
  // the functions that turn a reading into an exit
  for (const fn of ["async function applyExitGates(", "async function buildExitAction(", "async function evaluateCloseEfficiencyGate("]) {
    const s0 = idx.indexOf(fn);
    assert.ok(s0 > 0, fn);
    const body = idx.slice(s0, idx.indexOf("\n}\n", s0));
    assert.ok(!FIELD.test(body), `${fn} must not reference the cost fields`);
  }
  // the executor's close/deploy safety checks
  const exHits = src("tools/executor.js").split("\n").filter((l) => FIELD.test(l) && !/^\s*(\/\/|\*)/.test(l));
  assert.equal(exHits.length, 2, "executor: the two update_config keys only");
});
