// db/lane-paper-store.js — the fresh-lane paper capture storage: json JSONL round trip, pg
// ordered queue with batched ticks, and a missing table (migration 008 not applied) that is
// logged once and never throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const S = await import("../db/lane-paper-store.js");

test("json backend: trades merge insert + updates by id, ticks append; loadRecent filters by entry time", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lane-store-"));
  const st = S.createLanePaperStore({ backend: "json", dir });
  st.insertTrade({ id: "a", pool: "P", lane: "paper", entered_at: "2026-11-27T10:00:00.000Z", track_hours: 6, entry: { rank: 1 }, status: "open" });
  st.insertTrade({ id: "b", pool: "Q", lane: "operator", entered_at: "2026-11-26T10:00:00.000Z", track_hours: 6, entry: {}, status: "open" });
  st.updateTrade("a", { entry: { rank: 1, quotes: { buy: { out_raw: 5 } } } });
  st.updateTrade("a", { status: "ended", ended_at: "2026-11-27T16:00:00.000Z" });
  st.insertTick({ trade_id: "a", at: "2026-11-27T10:00:45.000Z", active_bin: -624 });
  st.insertTick({ trade_id: "a", at: "2026-11-27T10:01:30.000Z", active_bin: -625 });
  const all = S.readJsonTrades(path.join(dir, S.TRADES_FILE));
  assert.deepEqual(all.map((t) => t.id), ["b", "a"]);
  const a = all.find((t) => t.id === "a");
  assert.deepEqual([a.status, a.ended_at, a.entry.quotes.buy.out_raw], ["ended", "2026-11-27T16:00:00.000Z", 5]);
  assert.deepEqual((await st.loadRecent(Date.parse("2026-11-27T00:00:00Z"))).map((t) => t.id), ["a"]);
  assert.equal(S.readJsonTicks(path.join(dir, S.TICKS_FILE)).length, 2);
  await st.flush();
});

test("pg backend: writes go out in order, consecutive ticks as one multi-row insert", async () => {
  const sql = [];
  const st = S.createLanePaperStore({ backend: "pg", query: async (q, p) => { sql.push({ q, p }); return { rows: [] }; } });
  st.insertTrade({ id: "a", pool: "P", lane: "paper", entered_at: "2026-11-27T10:00:00.000Z", track_hours: 6, entry: {}, status: "open" });
  st.insertTick({ trade_id: "a", at: "2026-11-27T10:00:45.000Z", active_bin: -624.4, sell_quote: { ratio: 0.02 } });
  st.insertTick({ trade_id: "a", at: "2026-11-27T10:01:30.000Z", active_bin: -625, seen: false });
  st.updateTrade("a", { status: "ended", ended_at: "2026-11-27T16:00:00.000Z" });
  await st.flush();
  st.stop();
  assert.deepEqual(sql.map((x) => x.q.split(" ").slice(0, 3).join(" ")), ["INSERT INTO lane_paper_trades", "INSERT INTO lane_paper_ticks", "UPDATE lane_paper_trades SET"]);
  const ticks = sql[1].p;
  const W = 18;
  assert.equal(ticks.length, 2 * W, "2 rows × 18 columns");
  assert.equal(ticks[3], -624, "active bin stored as an integer");
  assert.equal(ticks[W - 1], JSON.stringify({ ratio: 0.02 }));
  assert.equal(ticks[W + 2], false, "unseen tick");
});

test("pg backend: a missing table is logged once per 10 min, the batch is dropped and nothing throws", async () => {
  const logs = [];
  let t = 0;
  const err = Object.assign(new Error('relation "lane_paper_ticks" does not exist'), { code: "42P01" });
  const st = S.createLanePaperStore({ backend: "pg", query: async () => { throw err; }, log: (c, m) => logs.push(m), now: () => t });
  for (let i = 0; i < 3; i++) { st.insertTick({ trade_id: "a", at: new Date().toISOString() }); await st.flush(); t += 60_000; }
  st.stop();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /run npm run db:migrate/);
  assert.equal(st._queueLength(), 0);
  assert.equal(await st.loadRecent(0), null, "a failed load is null (the runtime retries), never []");
  // nothing reaches the caller even for bad input
  assert.doesNotThrow(() => { st.insertTick(null); st.insertTrade(undefined); st.updateTrade(null); });
});

test("pg backend: the backlog (queue + chain) is bounded — oldest ticks dropped, trades kept; a hung write times out", async () => {
  const logs = [];
  let release;
  const hang = new Promise((r) => { release = r; });
  let calls = 0;
  const st = S.createLanePaperStore({ backend: "pg", maxPending: 60, writeTimeoutMs: 50, log: (c, m) => logs.push(m), query: async () => { calls++; if (calls === 1) await hang; return { rows: [] }; } });
  st.insertTrade({ id: "a", pool: "P", lane: "paper", entered_at: "2026-11-27T10:00:00.000Z", track_hours: 6, entry: {}, status: "open" });
  for (let i = 0; i < 49; i++) st.insertTick({ trade_id: "a", at: new Date(i).toISOString() }); // 50 → drained to the chain
  for (let i = 0; i < 40; i++) st.insertTick({ trade_id: "a", at: new Date(1000 + i).toISOString() });
  assert.ok(st._pending() <= 60, `pending ${st._pending()}`);
  assert.ok(logs.some((m) => /backlog failed: .* tick\(s\) dropped/.test(m)));
  // the hung first query times out after 50 ms and the chain moves on
  await st.flush();
  assert.ok(logs.some((m) => /timed out after 50 ms/.test(m)));
  assert.equal(st._pending(), 0);
  assert.equal(st.isFailed("a"), true, "its insert timed out → its ticks are dropped from here on");
  release();
  st.stop();
});

test("a trade whose insert failed gets no ticks or updates", async () => {
  const sql = [];
  let n = 0;
  const st = S.createLanePaperStore({ backend: "pg", query: async (q, p) => { n++; if (n === 1) throw new Error("boom"); sql.push(q); return { rows: [] }; } });
  st.insertTrade({ id: "x", pool: "P", lane: "paper", entered_at: "2026-11-27T10:00:00.000Z", track_hours: 6, entry: {}, status: "open" });
  st.insertTick({ trade_id: "x", at: "2026-11-27T10:00:45.000Z" });
  await st.flush();
  assert.equal(st.isFailed("x"), true);
  assert.deepEqual(sql, [], "the tick queued behind the failed insert was dropped");
  st.insertTick({ trade_id: "x", at: "2026-11-27T10:01:30.000Z" });
  st.updateTrade("x", { status: "ended" });
  await st.flush();
  assert.deepEqual(sql, []);
  st.stop();
  // json: an append failure marks the trade failed too
  const bad = S.createLanePaperStore({ backend: "json", dir: "/nonexistent-dir-for-test" });
  bad.insertTrade({ id: "y", pool: "P", lane: "paper", entered_at: "2026-11-27T10:00:00.000Z" });
  assert.equal(bad.isFailed("y"), true);
});
