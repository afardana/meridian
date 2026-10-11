process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// closeAuditReauditSince (2026-10-11): a one-off wider re-audit window. Everything here is
// pure — no store is written.
const { planCloseAuditCycle, backfillOutcome, backfillSummaryText, normalizeReauditSince, CLOSE_AUDIT_VERSION: V } = await import("../close-audit.js");
const { selectCloseAuditBackfill, stampCloseAuditBackfill, summarizeCloseAuditBackfill } = await import("../lessons.js");
const { config } = await import("../config.js");

const NOW = Date.parse("2026-10-11T12:00:00Z");
const SINCE = "2026-09-27T00:00:00.000Z";
const rec = (position, recorded_at, chain_audit, extra = {}) => ({ position, base_mint: "MINT", pool_name: `${position}-SOL`, recorded_at, amount_sol: 1, pnl_sol: 0.1, pnl_sol_net: 0.1, chain_audit, ...extra });
const RECORDS = [
  rec("before",   "2026-09-26T23:59:00Z", { status: "incomplete", version: 4 }),            // closed before `since`
  rec("old-inc",  "2026-09-28T10:00:00Z", { status: "incomplete", version: 7 }),
  rec("old-ok",   "2026-10-04T05:00:00Z", { status: "ok", version: 4, applied: true }),     // ok / mismatch are taken too
  rec("old-mis",  "2026-10-02T05:00:00Z", { status: "mismatch", version: 5 }),
  rec("current",  "2026-10-05T05:00:00Z", { status: "ok", version: V }),                    // already on the current method
  rec("never",    "2026-10-03T05:00:00Z", undefined),                                       // never audited: not a re-audit
  rec("leg",      "2026-10-03T06:00:00Z", { status: "ok", version: 4 }, { rebalance_leg: true }),
  rec("nomint",   "2026-10-03T07:00:00Z", { status: "ok", version: 4 }, { base_mint: null }),
  rec("checked",  "2026-10-03T08:00:00Z", { status: "incomplete", version: 4, backfill_checked: V }),
  rec("recent",   "2026-10-11T02:00:00Z", { status: "ok", version: V - 1 }),                // last 24 h: the normal queue's
  rec("noversion", "2026-10-01T00:00:00Z", { status: "incomplete" }),                       // pre-version verdict = older
];
const pick = (o = {}) => selectCloseAuditBackfill(RECORDS, { since: SINCE, version: V, now: NOW, limit: 50, ...o }).map((r) => r.position);

test("selection: closed at/after `since`, stale version, oldest first", () => {
  assert.deepEqual(pick(), ["old-inc", "noversion", "old-mis", "old-ok"]);
  assert.deepEqual(pick({ limit: 2 }), ["old-inc", "noversion"]);
  assert.deepEqual(pick({ exclude: ["old-inc"] }), ["noversion", "old-mis", "old-ok"]);
  // the version filter: nothing is stale against an older "current" version
  assert.deepEqual(pick({ version: 4 }), ["noversion"]);
  // ("checked" was only marked unreadable at version V, so another version looks at it again)
  assert.deepEqual(pick({ version: 5 }), ["noversion", "checked", "old-ok"]);
  // unset / unparseable key → nothing
  assert.deepEqual(pick({ since: null }), []);
  assert.deepEqual(pick({ since: "not a date" }), []);
  // a later `since` narrows it
  assert.deepEqual(pick({ since: "2026-10-03T00:00:00Z" }), ["old-ok"]);
});

test("a re-audited record leaves the queue; an unreadable one keeps its verdict and leaves too", () => {
  const records = RECORDS.map((r) => ({ ...r, chain_audit: r.chain_audit ? { ...r.chain_audit } : undefined }));
  const sel = () => selectCloseAuditBackfill(records, { since: SINCE, version: V, now: NOW, limit: 50 }).map((r) => r.position);
  const by = (p) => records.find((r) => r.position === p);
  stampCloseAuditBackfill(by("old-inc"), { status: "ok", net_sol: 0.09, booked_sol: 0.1, version: V, attempts: 1 });
  assert.deepEqual(sel(), ["noversion", "old-mis", "old-ok"]);
  by("noversion").chain_audit.backfill_checked = V;          // markCloseAuditBackfillChecked
  assert.deepEqual(by("noversion").chain_audit.status, "incomplete", "verdict kept");
  assert.deepEqual(sel(), ["old-mis", "old-ok"]);
});

test("backfill stamp: how a backfill verdict is told from a normal one, and the ledger effect", () => {
  // incomplete (v7) → ok, wallet figure applied: 0.1 → 0.088
  const a = rec("a", "2026-10-01T00:00:00Z", { status: "incomplete", version: 7 });
  const sa = stampCloseAuditBackfill(a, { status: "ok", net_sol: 0.088, booked_sol: 0.1, version: V, attempts: 1 }, "2026-10-11T12:00:00.000Z");
  assert.deepEqual(sa.backfill, { from_version: 7, from_status: "incomplete", changed: true, ledger_delta_sol: -0.012 });
  assert.deepEqual([a.pnl_sol_net, a.pnl_sol_net_modelled, a.pnl_sol_net_source, sa.applied], [0.088, 0.1, "wallet", true]);
  // ok (v4, contaminated wallet figure applied) → ok: compared against the MODELLED figure
  const b = rec("b", "2026-10-04T05:00:00Z", { status: "ok", version: 4, applied: true, net_sol: 0.1074 }, { pnl_sol_net: 0.1074, pnl_sol_net_modelled: 0.1 });
  const sb = stampCloseAuditBackfill(b, { status: "ok", net_sol: 0.1, booked_sol: 0.1, version: V, attempts: 1 });
  assert.deepEqual([b.pnl_sol_net, b.pnl_sol_net_modelled], [0.1, 0.1]);
  assert.deepEqual([sb.backfill.changed, sb.backfill.ledger_delta_sol], [true, -0.0074]);
  // same status, same figure → unchanged
  const c = rec("c", "2026-10-02T00:00:00Z", { status: "ok", version: 6, applied: true, net_sol: 0.1 }, { pnl_sol_net_modelled: 0.1 });
  const sc = stampCloseAuditBackfill(c, { status: "ok", net_sol: 0.1, booked_sol: 0.1, version: V, attempts: 1 });
  assert.deepEqual([sc.backfill.changed, sc.backfill.ledger_delta_sol], [false, 0]);
  // still incomplete → nothing applied, unchanged
  const d = rec("d", "2026-10-02T00:00:00Z", { status: "incomplete", version: 6 });
  const sd = stampCloseAuditBackfill(d, { status: "incomplete", why: "another position in this token overlapped", version: V, attempts: 1 });
  assert.deepEqual([sd.backfill.changed, d.pnl_sol_net], [false, 0.1]);
  // a mismatch too large to apply: the ledger does not move, but the status change counts
  const e = rec("e", "2026-10-02T00:00:00Z", { status: "incomplete", version: 6 });
  const se = stampCloseAuditBackfill(e, { status: "mismatch", net_sol: -0.4, booked_sol: 0.1, version: V, attempts: 1 });
  assert.deepEqual([se.applied, se.backfill.changed, se.backfill.ledger_delta_sol, e.pnl_sol_net], [false, true, 0, 0.1]);

  const sum = summarizeCloseAuditBackfill([a, b, c, d, e,
    rec("normal", "2026-10-10T00:00:00Z", { status: "ok", version: V }),                    // normal audit: no stamp
    rec("kept", "2026-10-01T00:00:00Z", { status: "incomplete", version: 5, backfill_checked: V }),
    rec("early", "2026-09-01T00:00:00Z", { status: "ok", version: V, backfill: { changed: true, ledger_delta_sol: 9 } }),
  ], { since: SINCE, version: V });
  assert.deepEqual(sum, { reaudited: 5, changed: 3, ledger_delta_sol: -0.0194, kept: 1 });
  const text = backfillSummaryText(SINCE, sum);
  assert.match(text, /5 re-audited, 3 changed, 1 kept/);
  assert.match(text, /Net effect on the ledger: ◎−0\.019400\./);
});

test("unreadable wallet history keeps the stored verdict", () => {
  const ok = { status: "ok" };
  assert.equal(backfillOutcome({ wallet_history_complete: true }, ok), "store");
  assert.equal(backfillOutcome({ wallet_history_complete: true }, { status: "mismatch" }), "store");
  assert.equal(backfillOutcome({ wallet_history_complete: true }, { status: "incomplete", why: "another position in this token overlapped" }), "store");
  assert.equal(backfillOutcome({ wallet_history_complete: false }, { status: "incomplete" }), "keep");
  assert.equal(backfillOutcome(null, { status: "no_data" }), "keep");
  assert.equal(backfillOutcome({ wallet_history_complete: true }, { status: "no_data" }), "keep");
  // a short read is retried, then kept
  const short = { status: "incomplete", retry: true };
  assert.equal(backfillOutcome({ wallet_history_complete: true }, short, 1), "retry");
  assert.equal(backfillOutcome({ wallet_history_complete: true }, short, 2), "retry");
  assert.equal(backfillOutcome({ wallet_history_complete: true }, short, 3), "keep");
});

test("priority: fresh closes first, the backfill only fills what is left of the cycle", () => {
  const calls = [];
  const pickBackfill = (limit, exclude) => { calls.push({ limit, exclude }); return ["b1", "b2", "b3"].slice(0, limit).map((position) => ({ position })); };
  const plan = (freshQueue, doneKey = null, since = SINCE) => planCloseAuditCycle({ freshQueue, since, version: V, doneKey, perCycle: 2, pickBackfill });
  const shape = (p) => p.items.map((i) => `${i.rec.position}:${i.isBackfill ? "backfill" : "fresh"}`);

  // two fresh closes: the backfill is not even asked
  let p = plan([{ position: "f1" }, { position: "f2" }]);
  assert.deepEqual(shape(p), ["f1:fresh", "f2:fresh"]);
  assert.equal(calls.length, 0);
  assert.equal(p.complete, false, "a full cycle is not a completion");
  // one fresh close: one backfill record behind it
  p = plan([{ position: "f1" }]);
  assert.deepEqual(shape(p), ["f1:fresh", "b1:backfill"]);
  assert.deepEqual(calls.pop(), { limit: 1, exclude: ["f1"] });
  // none: the existing pace, 2 per cycle
  p = plan([]);
  assert.deepEqual(shape(p), ["b1:backfill", "b2:backfill"]);
  assert.deepEqual(calls.pop(), { limit: 2, exclude: [] });
  // key unset: the normal queue only
  p = plan([{ position: "f1" }], null, null);
  assert.deepEqual([shape(p), p.backfillKey, p.complete, calls.length], [["f1:fresh"], null, false, 0]);
});

test("completion latch: complete once, then the scan stops", () => {
  let scans = 0;
  const empty = () => { scans++; return []; };
  const first = planCloseAuditCycle({ freshQueue: [], since: SINCE, version: V, doneKey: null, pickBackfill: empty });
  assert.deepEqual([first.complete, first.items.length, first.backfillKey, scans], [true, 0, `${SINCE}|${V}`, 1]);
  // latched (the caller stores backfillKey): no scan, no second completion; fresh closes still flow
  const again = planCloseAuditCycle({ freshQueue: [{ position: "f1" }], since: SINCE, version: V, doneKey: first.backfillKey, pickBackfill: empty });
  assert.deepEqual([again.complete, again.items.length, scans], [false, 1, 1]);
  // a different `since` (or a later version bump) is a new backfill
  const moved = planCloseAuditCycle({ freshQueue: [], since: "2026-09-20T00:00:00.000Z", version: V, doneKey: first.backfillKey, pickBackfill: empty });
  assert.deepEqual([moved.complete, scans], [true, 2]);
  assert.equal(planCloseAuditCycle({ freshQueue: [], since: SINCE, version: V + 1, doneKey: first.backfillKey, pickBackfill: empty }).complete, true);
});

test("wiring: the config key, and no per-record Telegram alert on a backfill re-audit", () => {
  assert.equal(config.management.closeAuditReauditSince, null, "default: unset");
  assert.equal(normalizeReauditSince("2026-09-27"), "2026-09-27T00:00:00.000Z");
  assert.equal(normalizeReauditSince("2026-09-27T05:00:00+07:00"), "2026-09-26T22:00:00.000Z");
  for (const bad of [null, undefined, "", "soon", true, false]) assert.equal(normalizeReauditSince(bad), null);
  const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exec, /closeAuditReauditSince: \["management", "closeAuditReauditSince"\]/);
  assert.match(exec, /if \(match\[0\] === "closeAuditReauditSince"\) \{[\s\S]{0,200}normalizeReauditSince\(val\)[\s\S]{0,120}unknown\.push\(key\); continue;/);
  const cfg = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(cfg, /closeAuditReauditSince: normalizeReauditSince\(u\.closeAuditReauditSince\),/);
  assert.match(cfg, /if \(fresh\.closeAuditReauditSince !== undefined\) config\.management\.closeAuditReauditSince = normalizeReauditSince\(/);

  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const fn = idx.slice(idx.indexOf("async function runCloseAudits()"), idx.indexOf("async function runPostCloseMaintenance("));
  // the fresh queue feeds the planner; the latch is stored on completion
  assert.match(fn, /planCloseAuditCycle\(\{\s+freshQueue: getCloseAuditQueue\(\{ minAgeMin: 10, maxAgeHours: 24, limit: 2, version: CLOSE_AUDIT_VERSION \}\),/);
  assert.match(fn, /if \(plan\.complete\) \{[\s\S]{0,200}_closeAuditBackfillDoneKey = plan\.backfillKey;/);
  assert.match(fn, /\[CLOSE_AUDIT\] backfill since \$\{since\} complete \(\$\{sum\.reaudited\} re-audited, \$\{sum\.changed\} changed\)/);
  // the backfill branch ends with `continue` before the normal alert path and sends nothing itself
  const branch = fn.slice(fn.indexOf("if (isBackfill) {"), fn.indexOf("const repeat = isRepeatVerdict("));
  assert.ok(branch.length > 200 && /continue;\s+\}\s+$/.test(branch), "backfill branch returns before the alert");
  assert.ok(!branch.includes("sendHTML"), "no per-record alert during a backfill");
  assert.match(branch, /recordCloseAuditBackfill\(rec\.position,/);
  assert.match(branch, /markCloseAuditBackfillChecked\(rec\.position, CLOSE_AUDIT_VERSION\)/);
  // exactly two sends in the whole pass: the normal mismatch alert and the one backfill summary
  assert.equal((fn.match(/sendHTML\(/g) || []).length, 2);
  assert.match(fn, /if \(_closeAuditBackfillProcessed > 0\) sendHTML\(backfillSummaryText\(/);
  // an RPC failure during a backfill never overwrites the stored verdict
  const catchBlock = fn.slice(fn.indexOf("} catch (e) {"));
  assert.match(catchBlock, /if \(isBackfill\) \{[\s\S]{0,500}continue;\s+\}\s+recordCloseAudit\(/);
});
