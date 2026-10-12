process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Group audit (2026-10-12): positions of one token whose lifetimes overlap are audited as a
// group. Everything here is pure or runs against a fake RPC — no store is written.
const G = await import("../close-audit-group.js");
const { CLOSE_AUDIT_VERSION: V } = await import("../close-audit.js");
const { applyGroupVerdict, selectCloseAuditBackfill } = await import("../lessons.js");
const { summarizeLedger, groupNote, untrackedSwapsBetween, untrackedNote } = await import("../ledger-truth.js");
const { classifyTokenSwap } = await import("../tools/wallet.js");
const { config } = await import("../config.js");

const W = "WALLET", MINT = "MINT", ATA = "ATA";
const T0 = Date.parse("2026-10-10T00:00:00Z") / 1000;
const NOW = (T0 + 86400) * 1000;
const iso = (sec) => new Date(sec * 1000).toISOString();
/** A closed record whose exact on-chain window is [t0, t1] (seconds after T0). */
const rec = (position, t0, t1, extra = {}) => ({
  position, base_mint: MINT, pool_name: "TOK-SOL", recorded_at: iso(T0 + t1 + 5), minutes_held: Math.round((t1 - t0) / 60),
  amount_sol: 1, pnl_sol: 0.01, pnl_sol_net: 0.01, tx_window: { t0: T0 + t0, t1: T0 + t1 },
  chain_audit: { status: "incomplete", version: V, why: "another position in this token overlapped" }, ...extra,
});
const applied = (position, t0, t1, wallet, modelled, extra = {}) => rec(position, t0, t1, {
  pnl_sol_net: wallet, pnl_sol_net_modelled: modelled, pnl_sol_net_source: "wallet",
  chain_audit: { status: "ok", version: V, applied: true, net_sol: wallet }, ...extra,
});
const ids = (g) => g.members.map((r) => r.position);

test("grouping: same mint, windows overlapping or chained through the 180 s tail", () => {
  const records = [
    rec("A", 0, 1000),
    rec("B", 900, 2000),                    // overlaps A
    rec("C", 2180, 3000),                   // starts exactly at B's last tx + 180 s → chained
    rec("D", 3181, 4000),                   // 181 s after C's last tx → its own group
    rec("E", 500, 600, { base_mint: "OTHER" }),
    rec("F", 100, 200),                     // inside A
    { position: "nomint", recorded_at: iso(T0), base_mint: null },
  ];
  const groups = G.buildCloseGroups(records);
  assert.deepEqual(groups.map(ids).sort((a, b) => a.length - b.length), [["E"], ["D"], ["A", "F", "B", "C"]]);
  const big = groups.find((g) => g.members.length === 4);
  assert.deepEqual([big.t0, big.t1, big.exact], [T0, T0 + 3000, true]);
  assert.equal(big.id, "MINT:A", "named after the mint and the earliest member");
  // a longer tail joins D as well
  assert.equal(G.buildCloseGroups(records, { tailSec: 181 }).find((g) => g.mint === MINT).members.length, 5);
  // the same record listed twice is one member
  assert.equal(G.buildCloseGroups([rec("A", 0, 10), rec("A", 0, 10)])[0].members.length, 1);
});

test("a record without a stored window is estimated wide (recorded_at − minutes_held − 10 min)", () => {
  const r = { position: "X", base_mint: MINT, recorded_at: iso(T0 + 3600), minutes_held: 30 };
  assert.deepEqual(G.recordWindow(r), { t0: T0 + 3600 - 1800 - 600, t1: T0 + 3600, exact: false });
  assert.deepEqual(G.recordWindow({ ...r, tx_window: { t0: 5, t1: 9 } }), { t0: 5, t1: 9, exact: true });
  assert.equal(G.recordWindow({ position: "X" }), null);
  // the estimate chains two records that the exact windows keep apart
  const a = { position: "A", base_mint: MINT, recorded_at: iso(T0 + 1000), minutes_held: 10 };
  const b = { position: "B", base_mint: MINT, recorded_at: iso(T0 + 2100), minutes_held: 10 };
  assert.equal(G.buildCloseGroups([a, b]).length, 1);
  assert.equal(G.buildCloseGroups([{ ...a, tx_window: { t0: T0 + 400, t1: T0 + 990 } }, { ...b, tx_window: { t0: T0 + 1500, t1: T0 + 2090 } }]).length, 2);
});

test("classification: who waits, and why — decided without a chain read", () => {
  const [g] = G.buildCloseGroups([rec("A", 0, 1000), rec("B", 900, 2000)]);
  const cls = (group, o = {}) => G.classifyGroup(group, { now: NOW, ...o });
  assert.equal(cls(g).state, "audit");
  assert.equal(cls(G.buildCloseGroups([rec("A", 0, 10)])[0]).state, "single");
  assert.equal(cls(G.buildCloseGroups([applied("A", 0, 1000, 0.01, 0.012), applied("B", 900, 2000, 0.02, 0.02)])[0]).state, "all_settled");
  // a member closed less than 10 min ago
  assert.equal(cls(g, { now: (T0 + 2005 + 300) * 1000 }).state, "young");
  // a member whose individual audit is still to come (never audited, stale version, pending, retry)
  const waits = (chain_audit) => cls(G.buildCloseGroups([rec("A", 0, 1000), rec("B", 900, 2000, { chain_audit })])[0]).state;
  assert.equal(waits(undefined), "awaiting");
  assert.equal(waits({ status: "ok", version: V - 1 }), "awaiting");
  assert.equal(waits({ status: "pending", version: V, attempts: 1 }), "awaiting");
  assert.equal(waits({ status: "incomplete", version: V, retry: true, attempts: 1 }), "awaiting");
  assert.equal(waits({ status: "incomplete", version: V, retry: true, attempts: 3 }), "audit", "attempts used up: final");
  assert.equal(waits({ group: { status: "group_pending" } }), "awaiting", "a group stamp alone is not an audit");
  // …but not once the normal queue no longer reaches it (24 h), nor a rebalance leg (never audited)
  assert.equal(G.awaitsIndividualAudit(rec("A", 0, 10, { chain_audit: undefined }), { now: NOW + 2 * 86400_000 }), false);
  assert.equal(G.awaitsIndividualAudit(rec("A", 0, 10, { chain_audit: undefined, rebalance_leg: true }), { now: NOW }), false);
  // an OPEN position in the same token that began before the window ended (+ tail, 10 min wide)
  const open = (deployedSec, extra = {}) => [{ position: "OPEN1", base_mint: MINT, closed: false, deployed_at: iso(T0 + deployedSec), ...extra }];
  assert.deepEqual(cls(g, { openPositions: open(1500) }), { state: "pending", open: ["OPEN1"] });
  assert.equal(cls(g, { openPositions: open(2000 + 180 + 600) }).state, "pending", "inside the tail + slack");
  assert.equal(cls(g, { openPositions: open(2000 + 180 + 601) }).state, "audit", "began after the group ended");
  assert.equal(cls(g, { openPositions: open(1500, { base_mint: "OTHER" }) }).state, "audit");
  assert.equal(cls(g, { openPositions: open(1500, { closed: true }) }).state, "audit");
  assert.equal(cls(g, { openPositions: [{ position: "OPEN1", base_mint: MINT, closed: false }] }).state, "pending", "no start known: wait");
});

test("allocation: pro rata by capital, shares sum to the residual", () => {
  const u = [{ position: "A", amount_sol: 1 }, { position: "B", amount_sol: 2 }, { position: "C", amount_sol: 0.5 }];
  const s = G.allocateResidual(u, -0.1);
  assert.deepEqual(s, { A: -0.028571, B: -0.057143, C: -0.014286 });
  assert.equal(Math.round((s.A + s.B + s.C) * 1e6) / 1e6, -0.1);
  // rounding remainder goes to the last member
  const t = G.allocateResidual([{ position: "A", amount_sol: 1 }, { position: "B", amount_sol: 1 }, { position: "C", amount_sol: 1 }], 0.01);
  assert.deepEqual(t, { A: 0.003333, B: 0.003333, C: 0.003334 });
  // no capital figure: equal shares
  assert.deepEqual(G.allocateResidual([{ position: "A" }, { position: "B" }], 0.02), { A: 0.01, B: 0.01 });
  assert.deepEqual(G.allocateResidual([], 0.02), {});
  assert.equal(G.groupApplyBound(0.4), 0.05);
  assert.equal(G.groupApplyBound(10), 0.5);
});

const flowsOf = (net_sol, o = {}) => ({ net_sol, net_tokens: 0, tx_count: 12, unreadable: 0, last_swap_sol_per_token: 1e-6, wallet_bought_tokens: 0, sibling_position_ops: 0, open_account_rent_sol: 0, released_account_rent_sol: 0, tail_cutoff_time: null, history_complete: true, closing_missing: [], rpc_reads: 20, ...o });

test("verdict: applied members keep their wallet figure, the residual lands on the unsettled", () => {
  // S carries its own wallet figure (0.03, modelled 0.05); A and B are unsettled (modelled 0.01 / 0.04).
  const members = [applied("S", 0, 1000, 0.03, 0.05, { amount_sol: 2 }), rec("A", 900, 2000, { amount_sol: 1, pnl_sol_net: 0.01 }), rec("B", 1500, 2500, { amount_sol: 3, pnl_sol_net: 0.04 })];
  const [g] = G.buildCloseGroups(members);
  const v = G.evaluateGroupAudit(g, flowsOf(0.04));
  // ledger = 0.03 (S, wallet) + 0.01 + 0.04; residual = 0.04 − 0.08 = −0.04 over A (1) and B (3)
  assert.equal(v.status, "group_ok");
  assert.deepEqual([v.wallet_sol, v.ledger_sol, v.residual_sol, v.capital_sol, v.unsettled_capital_sol, v.bound_sol], [0.04, 0.08, -0.04, 6, 4, 0.2]);
  assert.deepEqual(v.shares, { A: -0.01, B: -0.03 });
  assert.deepEqual([v.members, v.settled_individually], [["A", "B", "S"], ["S"]]);
  assert.deepEqual([v.version, v.audit_version, v.id], [G.CLOSE_AUDIT_GROUP_VERSION, V, "MINT:S"]);
  // the rent set-asides apply once, at group level
  const rent = G.evaluateGroupAudit(g, flowsOf(0.04, { open_account_rent_sol: 0.001514, released_account_rent_sol: 0 }));
  assert.equal(rent.wallet_sol, 0.041514);
  assert.equal(G.evaluateGroupAudit(g, flowsOf(0.04, { released_account_rent_sol: 0.001514 })).wallet_sol, 0.038486);
  // the bound is on the capital the residual lands on: max(◎0.05, 5 % of ◎4) = ◎0.2
  const far = G.evaluateGroupAudit(g, flowsOf(-0.13));
  assert.deepEqual([far.status, far.residual_sol, far.shares], ["group_mismatch", -0.21, {}]);
  assert.equal(G.evaluateGroupAudit(g, flowsOf(-0.12)).status, "group_ok");
});

test("verdict: what leaves a group without one", () => {
  const [g] = G.buildCloseGroups([rec("A", 0, 1000), rec("B", 900, 2000)]);
  const why = (o) => { const v = G.evaluateGroupAudit(g, flowsOf(0.02, o)); return [v.status, v.why, v.retry === true]; };
  assert.deepEqual(why({ net_tokens: 5000, last_swap_sol_per_token: 1e-5 }), ["group_incomplete", "token flows of the group do not net to zero", false]);
  assert.deepEqual(why({ net_tokens: 5000, last_swap_sol_per_token: 1e-5, tail_cutoff_time: 1 }), ["group_incomplete", "another position in this token started before the group's remainder was sold", false]);
  assert.equal(why({ net_tokens: 100, last_swap_sol_per_token: 1e-5 })[0], "group_ok", "a remainder worth ◎0.001 is under the threshold");
  assert.equal(why({ net_tokens: -5000, last_swap_sol_per_token: 1e-5 })[0], "group_incomplete", "tokens brought from outside");
  assert.equal(why({ net_tokens: 30, last_swap_sol_per_token: null })[0], "group_ok", "unpriced dust, ledger and wallet agree");
  assert.equal(G.evaluateGroupAudit(g, flowsOf(0.5, { net_tokens: 30, last_swap_sol_per_token: null })).status, "group_incomplete");
  assert.deepEqual(why({ wallet_bought_tokens: 10 }), ["group_incomplete", "the wallet acquired this token without depositing it into a member position", false]);
  assert.deepEqual(why({ sibling_position_ops: 1, foreign_positions: [] }), ["group_incomplete", "a position outside the group moved this token inside its window (not a tracked position)", false]);
  assert.deepEqual(why({ sibling_position_ops: 1, foreign_positions: ["ZZZZZZZZ9999"], foreign_known: true }), ["group_incomplete", "a position outside the group moved this token inside its window (ZZZZZZZZ)", true]);
  assert.deepEqual(why({ unreadable: 2 }), ["group_incomplete", "2 position transaction(s) unreadable", true]);
  assert.deepEqual(why({ closing_missing: ["Bxxxxxxxxxxx"] }), ["group_incomplete", "the closing transaction of Bxxxxxxx was not among those read", true]);
  assert.deepEqual(why({ history_complete: false }), ["group_incomplete", "the token account's history was not read back to the group's first transaction", false]);
  assert.equal(G.evaluateGroupAudit(g, null).status, "group_incomplete");
  assert.match(G.evaluateGroupAudit(g, { too_large: true, tx_needed: 3000, tx_limit: 2500 }).why, /needs 3000 transaction reads \(limit 2500\)/);
  // a straddled member: its buy is the group's own even when it was not deposited
  const [s] = G.buildCloseGroups([rec("A", 0, 1000, { straddle_count: 1 }), rec("B", 900, 2000)]);
  assert.equal(G.evaluateGroupAudit(s, flowsOf(0.02, { wallet_bought_tokens: 10 })).status, "group_ok");
});

const fresh = () => [
  applied("S", 0, 1000, 0.03, 0.05, { amount_sol: 2 }),
  rec("A", 900, 2000, { amount_sol: 1, pnl_sol_net: 0.01 }),
  rec("B", 1500, 2500, { amount_sol: 3, pnl_sol_net: 0.04 }),
];
const AT = "2026-10-12T00:00:00.000Z";

test("shadow stamps every member and changes no pnl_sol_net", () => {
  const members = fresh();
  const before = JSON.stringify(members.map((r) => [r.pnl_sol_net, r.pnl_sol_net_modelled, r.pnl_sol_net_source, r.chain_audit.status]));
  const [g] = G.buildCloseGroups(members);
  const v = G.evaluateGroupAudit(g, flowsOf(0.04));
  const res = applyGroupVerdict(members, v, { mode: "shadow", at: AT });
  assert.deepEqual(res, { changed: 3, applied: 0, reverted: 0, kept_applied: 0, ledger_delta_sol: 0 });
  assert.equal(JSON.stringify(members.map((r) => [r.pnl_sol_net, r.pnl_sol_net_modelled, r.pnl_sol_net_source, r.chain_audit.status])), before);
  const [S, A, B] = members.map((r) => r.chain_audit.group);
  assert.deepEqual([S.share_sol, A.share_sol, B.share_sol], [0, -0.01, -0.03]);
  assert.deepEqual([S.applied, A.applied, B.applied, A.mode, A.status], [false, false, false, "shadow", "group_ok"]);
  assert.deepEqual([A.id, A.wallet_sol, A.ledger_sol, A.residual_sol, A.capital_sol, A.version], ["MINT:S", 0.04, 0.08, -0.04, 6, G.CLOSE_AUDIT_GROUP_VERSION]);
  assert.equal(A.shares, undefined, "a member stores its own share, not the table");
  // idempotent
  assert.equal(applyGroupVerdict(members, v, { mode: "shadow", at: "2026-10-13T00:00:00.000Z" }).changed, 0);
  assert.equal(A.at, AT);
  // the stored wallet total is enough to classify the group as cached (no chain read) …
  const c = G.classifyGroup(g, { now: NOW });
  assert.equal(c.state, "cached");
  // … and re-allocating from it reproduces the verdict
  const again = G.evaluateGroupAudit(g, { stored: c.stamp });
  assert.deepEqual([again.status, again.shares, again.wallet_sol, again.tx_count], ["group_ok", { A: -0.01, B: -0.03 }, 0.04, 12]);
  // ledger-truth: shown as shadow, not in the net
  const led = summarizeLedger(members);
  assert.deepEqual([Math.round(led.net * 1e6) / 1e6, led.group_settled, led.group_shadow, Math.round(led.group_shadow_sol * 1e6) / 1e6], [0.08, 0, 2, -0.04]);
  assert.equal(groupNote({ group_settled: 0, group_shadow: 2, group_shadow_sol: -0.04 }), ", group shadow: 2 would move ◎-0.040");
});

test("enforce applies: modelled kept, source wallet_group, own status untouched; idempotent", () => {
  const members = fresh();
  const [g] = G.buildCloseGroups(members);
  const v = G.evaluateGroupAudit(g, flowsOf(0.04));
  applyGroupVerdict(members, v, { mode: "shadow", at: AT });           // first deploy: shadow
  const res = applyGroupVerdict(members, v, { mode: "enforce", at: AT }); // then the switch
  assert.deepEqual(res, { changed: 2, applied: 2, reverted: 0, kept_applied: 0, ledger_delta_sol: -0.04 });
  const [S, A, B] = members;
  assert.deepEqual([S.pnl_sol_net, S.pnl_sol_net_modelled, S.pnl_sol_net_source, S.chain_audit.group.applied], [0.03, 0.05, "wallet", false], "an applied member is untouched");
  assert.deepEqual([A.pnl_sol_net, A.pnl_sol_net_modelled, A.pnl_sol_net_source], [0, 0.01, "wallet_group"]);
  assert.deepEqual([B.pnl_sol_net, B.pnl_sol_net_modelled, B.pnl_sol_net_source], [0.01, 0.04, "wallet_group"]);
  assert.deepEqual([A.chain_audit.status, A.chain_audit.why, A.chain_audit.group.applied, A.chain_audit.group.share_sol], ["incomplete", "another position in this token overlapped", true, -0.01]);
  // Σ ledger now equals the group's wallet total
  assert.equal(Math.round((S.pnl_sol_net + A.pnl_sol_net + B.pnl_sol_net) * 1e6) / 1e6, v.wallet_sol);
  // re-running a settled group changes nothing — from the verdict, and from the stored total
  assert.equal(applyGroupVerdict(members, v, { mode: "enforce" }).changed, 0);
  const c = G.classifyGroup(G.buildCloseGroups(members)[0], { now: NOW });
  assert.equal(c.state, "cached");
  assert.equal(applyGroupVerdict(members, G.evaluateGroupAudit(G.buildCloseGroups(members)[0], { stored: c.stamp }), { mode: "enforce" }).changed, 0);
  assert.deepEqual([A.pnl_sol_net, B.pnl_sol_net], [0, 0.01]);
  // back in shadow, an allocation already made is left alone
  assert.deepEqual(applyGroupVerdict(members, { ...v, shares: { A: 0.5, B: 0.5 } }, { mode: "shadow" }), { changed: 0, applied: 0, reverted: 0, kept_applied: 2, ledger_delta_sol: 0 });
  // ledger-truth counts the records and the SOL moved
  const led = summarizeLedger(members);
  assert.deepEqual([led.group_settled, Math.round(led.group_settled_sol * 1e6) / 1e6, led.group_shadow], [2, -0.04, 0]);
  assert.equal(groupNote({ group_settled: 2, group_settled_sol: -0.04 }), ", 2 settled by group ◎-0.040");
});

test("a late member re-opens the group: the allocation is redone from the modelled figures", () => {
  const members = fresh();
  let [g] = G.buildCloseGroups(members);
  applyGroupVerdict(members, G.evaluateGroupAudit(g, flowsOf(0.04)), { mode: "enforce", at: AT });
  // an external-reconcile record written later, overlapping the window (capital 4, modelled −0.02)
  members.push(rec("L", 2400, 2600, { amount_sol: 4, pnl_sol_net: -0.02, chain_audit: { status: "incomplete", version: V } }));
  [g] = G.buildCloseGroups(members);
  assert.equal(g.members.length, 4);
  assert.equal(G.currentGroupStamp(g), null, "the stored stamp describes three members");
  assert.equal(G.classifyGroup(g, { now: NOW }).state, "audit", "a new member means a new chain read");
  // the group's wallet total with L's flows: 0.03; ledger = 0.03 + 0.01 + 0.04 − 0.02 = 0.06 (modelled, not the old allocation)
  const v = G.evaluateGroupAudit(g, flowsOf(0.03));
  assert.deepEqual([v.ledger_sol, v.residual_sol, v.shares], [0.06, -0.03, { A: -0.00375, B: -0.01125, L: -0.015 }]);
  const res = applyGroupVerdict(members, v, { mode: "enforce", at: AT });
  assert.deepEqual([res.changed, res.applied], [4, 3]);
  const by = Object.fromEntries(members.map((r) => [r.position, r]));
  assert.deepEqual([by.A.pnl_sol_net, by.B.pnl_sol_net, by.L.pnl_sol_net], [0.00625, 0.02875, -0.035]);
  assert.deepEqual([by.A.pnl_sol_net_modelled, by.B.pnl_sol_net_modelled, by.L.pnl_sol_net_modelled], [0.01, 0.04, -0.02]);
  assert.equal(Math.round(members.reduce((s, r) => s + r.pnl_sol_net, 0) * 1e6) / 1e6, 0.03);
  assert.equal(applyGroupVerdict(members, v, { mode: "enforce" }).changed, 0);
});

test("a member that gets its own wallet figure later: the rest is re-allocated without a read", () => {
  const members = fresh();
  let [g] = G.buildCloseGroups(members);
  applyGroupVerdict(members, G.evaluateGroupAudit(g, flowsOf(0.04)), { mode: "enforce", at: AT });
  // B's individual re-audit now applies (wallet 0.015); applyWalletNet leaves the group stamp in place
  const B = members[2];
  Object.assign(B, { pnl_sol_net: 0.015, pnl_sol_net_source: "wallet" });
  B.chain_audit = { ...B.chain_audit, status: "ok", applied: true, net_sol: 0.015 };
  [g] = G.buildCloseGroups(members);
  const c = G.classifyGroup(g, { now: NOW });
  assert.equal(c.state, "cached");
  const v = G.evaluateGroupAudit(g, { stored: c.stamp });
  // ledger = 0.03 + 0.015 + 0.01 (A modelled); residual −0.015, all of it on A
  assert.deepEqual([v.settled_individually, v.ledger_sol, v.residual_sol, v.shares], [["B", "S"], 0.055, -0.015, { A: -0.015 }]);
  applyGroupVerdict(members, v, { mode: "enforce", at: AT });
  assert.deepEqual([members[1].pnl_sol_net, B.pnl_sol_net, B.pnl_sol_net_source, B.chain_audit.group.share_sol], [-0.005, 0.015, "wallet", 0]);
  assert.equal(Math.round(members.reduce((s, r) => s + r.pnl_sol_net, 0) * 1e6) / 1e6, 0.04);
});

test("a mismatch or an incomplete verdict applies nothing; a stale allocation is taken back", () => {
  const members = fresh();
  const [g] = G.buildCloseGroups(members);
  applyGroupVerdict(members, G.evaluateGroupAudit(g, flowsOf(0.04)), { mode: "enforce", at: AT });
  const far = G.evaluateGroupAudit(g, flowsOf(-0.5));
  const res = applyGroupVerdict(members, far, { mode: "enforce", at: AT });
  assert.deepEqual([res.applied, res.reverted, res.ledger_delta_sol], [0, 2, 0.04]);
  assert.deepEqual(members.map((r) => [r.pnl_sol_net, r.pnl_sol_net_source]), [[0.03, "wallet"], [0.01, undefined], [0.04, undefined]]);
  assert.deepEqual(members.map((r) => [r.chain_audit.group.status, r.chain_audit.group.applied]), [["group_mismatch", false], ["group_mismatch", false], ["group_mismatch", false]]);
  const inc = G.evaluateGroupAudit(g, flowsOf(0.04, { unreadable: 1 }));
  applyGroupVerdict(members, { ...inc, attempts: 1 }, { mode: "enforce", at: AT });
  assert.deepEqual([members[1].chain_audit.group.status, members[1].chain_audit.group.retry, members[1].pnl_sol_net], ["group_incomplete", true, 0.01]);
  const [g2] = G.buildCloseGroups(members);
  // retried, 30 min apart, three times; a verdict that cannot change is final
  assert.equal(G.classifyGroup(g2, { now: Date.parse(AT) + 10 * 60_000 }).state, "retry_later");
  assert.deepEqual(G.classifyGroup(g2, { now: Date.parse(AT) + 31 * 60_000 }), { state: "audit", attempts: 2 });
  applyGroupVerdict(members, { ...inc, attempts: 3 }, { mode: "enforce", at: AT });
  assert.equal(G.classifyGroup(g2, { now: Date.parse(AT) + 3600_000 }).state, "final");
  applyGroupVerdict(members, G.evaluateGroupAudit(g, flowsOf(0.04, { wallet_bought_tokens: 5 })), { mode: "enforce", at: AT });
  assert.equal(G.classifyGroup(g2, { now: NOW }).state, "final");
});

test("a group stamp does not make a never-audited record a backfill re-audit", () => {
  const r = { position: "n", base_mint: MINT, recorded_at: "2026-10-03T05:00:00Z", chain_audit: { group: { status: "group_ok" } } };
  assert.deepEqual(selectCloseAuditBackfill([r], { since: "2026-09-27T00:00:00.000Z", version: V, now: NOW }), []);
});

// ── transactions ────────────────────────────────────────────────────────────────────────
const OP = { deploy: "InitializePosition", close: "ClosePositionIfEmpty", claim: "ClaimFee2", add: "AddLiquidityByStrategy2" };
/** One wallet transaction: SOL and token deltas of the wallet, optionally on a position account. */
const tx = (signature, t, { sol = 0, tok = 0, pos = null, op = null, rent = 0 } = {}) => ({
  signature, slot: 1000 + t, blockTime: T0 + t,
  transaction: { message: { accountKeys: [W, pos || `other-${signature}`, ATA] } },
  meta: {
    err: null,
    preBalances: [10e9, 0, rent < 0 ? -rent * 1e9 : 0], postBalances: [10e9 + Math.round(sol * 1e9), 0, rent > 0 ? rent * 1e9 : 0],
    preTokenBalances: [{ accountIndex: 2, mint: MINT, owner: W, uiTokenAmount: { uiAmountString: "1000" } }],
    postTokenBalances: [{ accountIndex: 2, mint: MINT, owner: W, uiTokenAmount: { uiAmountString: String(1000 + tok) } }],
    logMessages: op ? [`Program log: Instruction: ${OP[op]}`] : ["Program log: Instruction: Route"],
  },
});
// Two overlapping positions and the swaps nobody can attribute to one of them.
const CHAIN = {
  P1: [tx("p1-open", 0, { sol: -1, pos: "P1", op: "deploy" }), tx("p1-close", 1000, { sol: 0.6, tok: 4000, pos: "P1", op: "close" })],
  P2: [tx("p2-open", 500, { sol: -2, pos: "P2", op: "deploy" }), tx("p2-claim", 800, { sol: 0.01, tok: 100, pos: "P2", op: "claim" }), tx("p2-close", 2000, { sol: 1.5, tok: 6000, pos: "P2", op: "close" })],
  token: [tx("swap-fee", 810, { sol: 0.009, tok: -100 }), tx("swap-1", 1010, { sol: 0.38, tok: -4000 }), tx("swap-2", 2010, { sol: 0.55, tok: -6000 })],
};
const groupOf = () => G.buildCloseGroups([rec("P1", 0, 1000, { amount_sol: 1, pnl_sol_net: 0 }), rec("P2", 500, 2000, { amount_sol: 2, pnl_sol_net: 0.08 })])[0];

test("flows of the union: each transaction once, by signature", () => {
  const g = groupOf();
  const memberTxs = new Map([["P1", CHAIN.P1], ["P2", CHAIN.P2]]);
  // the token account lists the position transactions too (they touch it): not counted twice
  const tokenTxs = [...CHAIN.token, ...CHAIN.P1, ...CHAIN.P2, CHAIN.token[1]];
  const f = G.summarizeGroupFlows({ members: g.members, memberTxs, tokenTxs, wallet: W, baseMint: MINT });
  assert.equal(f.tx_count, 8);
  assert.equal(Math.round(f.net_sol * 1e9) / 1e9, 0.049); // −1 +0.6 −2 +0.01 +1.5 +0.009 +0.38 +0.55
  assert.equal(f.net_tokens, 0);
  assert.deepEqual(f.windows, { P1: { t0: T0, t1: T0 + 1000 }, P2: { t0: T0 + 500, t1: T0 + 2000 } });
  assert.deepEqual([f.closing_missing, f.sibling_position_ops, f.foreign_positions], [[], 0, []]);
  const v = G.evaluateGroupAudit(g, { ...f, history_complete: true });
  // ledger 0 + 0.08; wallet 0.049; residual −0.031 over capital 1 : 2
  assert.deepEqual([v.status, v.wallet_sol, v.ledger_sol, v.residual_sol, v.shares], ["group_ok", 0.049, 0.08, -0.031, { P1: -0.010333, P2: -0.020667 }]);
  // a member alone cannot be audited: the other one's claim and close move the token inside its window
  const alone = G.summarizeGroupFlows({ members: [g.members[0]], memberTxs: new Map([["P1", CHAIN.P1]]), tokenTxs: [...CHAIN.token, ...CHAIN.P2], wallet: W, baseMint: MINT, knownAddresses: ["P1", "P2"] });
  assert.equal(alone.sibling_position_ops, 1);
  assert.deepEqual([alone.foreign_positions, alone.foreign_known], [["P2"], true]);
  // a member whose closing transaction is missing from the listing
  const short = G.summarizeGroupFlows({ members: g.members, memberTxs: new Map([["P1", CHAIN.P1], ["P2", CHAIN.P2.slice(0, 2)]]), tokenTxs: CHAIN.token, wallet: W, baseMint: MINT });
  assert.deepEqual(short.closing_missing, ["P2"]);
});

/** A fake read pool over CHAIN, counting calls. */
function fakeRpc(log, { fail = new Set() } = {}) {
  const all = new Map([...CHAIN.P1, ...CHAIN.P2, ...CHAIN.token].map((t) => [t.signature, t]));
  const sigsOf = { P1: CHAIN.P1, P2: CHAIN.P2, [`ata-${"TokenkegQ"}`]: [...CHAIN.token, ...CHAIN.P1, ...CHAIN.P2].sort((a, b) => a.blockTime - b.blockTime) };
  const conn = {
    getSignaturesForAddress: async (pk) => { log.push(`sigs:${pk.addr}`); return (sigsOf[pk.addr] || []).map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: null })).reverse(); },
    getParsedTransaction: async (sig) => { log.push(`tx:${sig}`); return fail.has(sig) ? null : all.get(sig); },
  };
  return (fn) => fn(conn);
}
class FakeKey {
  constructor(addr) { this.addr = addr; }
  toBuffer() { return Buffer.from(String(this.addr)); }
  toBase58() { return this.addr; }
  static findProgramAddressSync(seeds) { return [new FakeKey(`ata-${seeds[1].toString().slice(0, 9)}`)]; }
}

test("fetch: one listing per member and per token account, each transaction read once, resumable", async () => {
  const g = groupOf();
  const log = [];
  const session = {};
  const part = await G.fetchGroupFlows({ rpc: fakeRpc(log), PublicKey: FakeKey, wallet: W, group: g, session, maxReads: 3, sleepMs: 0 });
  assert.deepEqual(part, { partial: true, read: 3, total: 8, rpc_reads: 7 });
  assert.deepEqual(log.filter((l) => l.startsWith("sigs:")), ["sigs:P1", "sigs:P2", "sigs:ata-TokenkegQ", "sigs:ata-TokenzQdB"]);
  // the next cycle continues from the session: no listing again, no transaction twice
  const flows = await G.fetchGroupFlows({ rpc: fakeRpc(log), PublicKey: FakeKey, wallet: W, group: g, session, maxReads: 250, sleepMs: 0 });
  assert.equal(log.filter((l) => l.startsWith("sigs:")).length, 4);
  const txReads = log.filter((l) => l.startsWith("tx:"));
  assert.equal(txReads.length, 8);
  assert.equal(new Set(txReads).size, 8);
  assert.deepEqual([flows.tx_count, flows.rpc_reads, flows.history_complete, Math.round(flows.net_sol * 1e9) / 1e9, flows.net_tokens], [8, 12, true, 0.049, 0]);
  assert.equal(G.evaluateGroupAudit(g, flows).status, "group_ok");
  assert.equal(G.evaluateGroupAudit(g, flows).rpc_reads, 12);
  // a different member set starts a new session
  const other = G.buildCloseGroups([rec("P1", 0, 1000)])[0];
  other.members.push(rec("P2", 500, 2000)); other.members.push(rec("P3", 600, 700));
  const n = log.filter((l) => l.startsWith("sigs:")).length;
  const next = await G.fetchGroupFlows({ rpc: fakeRpc(log), PublicKey: FakeKey, wallet: W, group: other, session, maxReads: 0, sleepMs: 0 });
  assert.equal(log.filter((l) => l.startsWith("sigs:")).length, n + 5, "the listings are read again (3 members + 2 token accounts)");
  assert.equal(log.filter((l) => l.startsWith("tx:")).length, 8, "transactions already read are kept");
  assert.equal(next.tx_count, 8);
  // an unreadable position transaction: no verdict, retried
  const bad = await G.fetchGroupFlows({ rpc: fakeRpc([], { fail: new Set(["p2-claim"]) }), PublicKey: FakeKey, wallet: W, group: g, session: {}, sleepMs: 0 });
  assert.deepEqual([bad.unreadable, G.evaluateGroupAudit(g, bad).status, G.evaluateGroupAudit(g, bad).retry], [1, "group_incomplete", true]);
  // the read budget: a group that needs more than the limit gets no verdict and reads nothing
  const big = [];
  const huge = await G.fetchGroupFlows({ rpc: fakeRpc(big), PublicKey: FakeKey, wallet: W, group: g, session: {}, maxTxTotal: 5, sleepMs: 0 });
  assert.deepEqual([huge.too_large, huge.tx_needed, huge.tx_limit, big.filter((l) => l.startsWith("tx:")).length], [true, 8, 5, 0]);
});

/** The lessons.js store functions over a plain array (the real applyGroupVerdict). */
function memStore(records) {
  const find = (p) => records.find((r) => r.position === p);
  return {
    recordGroup: (verdict, opts) => applyGroupVerdict(verdict.members.map(find), verdict, opts),
    notePending: (group, open, { version, auditVersion }) => {
      let n = 0;
      for (const r of group.members) {
        const prev = r.chain_audit?.group;
        if (prev?.status === "group_pending" && JSON.stringify(prev.open) === JSON.stringify(open)) continue;
        r.chain_audit = { ...(r.chain_audit || {}), group: { id: group.id, status: "group_pending", members: ids(group).sort(), open, version, audit_version: auditVersion, applied: false } };
        n++;
      }
      return n;
    },
    noteWindows: (w) => { for (const [p, x] of Object.entries(w)) if (find(p)) find(p).tx_window = x; },
    clearGroup: (p) => { const r = find(p); if (!r?.chain_audit?.group) return false; if (r.pnl_sol_net_source === "wallet_group") { r.pnl_sol_net = r.pnl_sol_net_modelled; delete r.pnl_sol_net_source; } delete r.chain_audit.group; return true; },
  };
}

test("the cycle: pending without a read, shadow stamps, enforce applies from the stored total", async () => {
  // estimated windows only (no tx_window): the read stores the exact ones
  const mk = (position, closeSec, held, extra) => ({ position, base_mint: MINT, pool_name: "TOK-SOL", recorded_at: iso(T0 + closeSec + 5), minutes_held: held, pnl_sol: 0, chain_audit: { status: "incomplete", version: V }, ...extra });
  const records = [mk("P1", 1000, 16, { amount_sol: 1, pnl_sol_net: 0 }), mk("P2", 2000, 25, { amount_sol: 2, pnl_sol_net: 0.08 })];
  const rpcLog = [], lines = [], sent = [];
  const session = {};
  const run = (o = {}) => G.runGroupAuditCycle({
    mode: "shadow", now: NOW, session, getRecords: () => records, getPositions: () => [], store: memStore(records),
    chain: async () => ({ rpc: fakeRpc(rpcLog), PublicKey: FakeKey, wallet: W }),
    log: (l) => lines.push(l), send: (h) => sent.push(h), sleepMs: 0, ...o,
  });
  // an open position in the token: the group waits — no chain read, one log line, once
  const openPos = [{ position: "OPEN1", base_mint: MINT, closed: false, deployed_at: iso(T0 + 1500) }];
  let out = await run({ getPositions: () => openPos });
  assert.deepEqual([out.pending, out.read, rpcLog.length], [1, null, 0]);
  assert.match(lines[0], /^\[CLOSE_AUDIT_GROUP\] pending TOK-SOL MINT:P1: 2 closed positions wait for 1 open position\(s\) in the token \(OPEN1\)$/);
  assert.equal(records[0].chain_audit.group.status, "group_pending");
  await run({ getPositions: () => openPos });
  assert.deepEqual([lines.length, rpcLog.length], [1, 0], "a waiting group is not re-read or re-logged every cycle");
  // the open position is gone: one group read, in shadow
  out = await run();
  assert.deepEqual([out.read.status, out.read.rpc_reads, out.applied], ["group_ok", 12, 0]);
  assert.match(lines[1], /^\[CLOSE_AUDIT_GROUP\] would-apply TOK-SOL MINT:P1 \(2 positions, 2 unsettled\): wallet ◎\+0\.049000 vs ledger ◎\+0\.080000, residual ◎-0\.031000 \(bound ◎0\.15\) → P1 ◎-0\.010333, P2 ◎-0\.020667; ledger effect ◎-0\.031000; 12 RPC reads$/);
  assert.deepEqual(records.map((r) => [r.pnl_sol_net, r.pnl_sol_net_source, r.chain_audit.group.applied, r.chain_audit.group.share_sol]), [[0, undefined, false, -0.010333], [0.08, undefined, false, -0.020667]]);
  assert.deepEqual(records.map((r) => r.tx_window), [{ t0: T0, t1: T0 + 1000 }, { t0: T0 + 500, t1: T0 + 2000 }], "exact windows stored");
  assert.equal(sent.length, 0, "shadow sends nothing");
  // settled in shadow: the next cycles read nothing and write nothing
  const reads = rpcLog.length;
  out = await run();
  assert.deepEqual([out.read, out.rewritten, rpcLog.length, lines.length], [null, 0, reads, 2]);
  // the switch to enforce applies the stored verdict — still no chain read — and says so once
  out = await run({ mode: "enforce" });
  assert.deepEqual([out.read, out.rewritten, out.applied, rpcLog.length], [null, 1, 2, reads]);
  assert.deepEqual(records.map((r) => [r.pnl_sol_net, r.pnl_sol_net_modelled, r.pnl_sol_net_source]), [[-0.010333, 0, "wallet_group"], [0.059333, 0.08, "wallet_group"]]);
  assert.match(lines[2], /^\[CLOSE_AUDIT_GROUP\] applied .*ledger effect ◎-0\.031000/);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^🧾 <b>Group audit<\/b> TOK-SOL: 2 positions \(2 settled by the group\), wallet ◎\+0\.049000 vs ledger ◎\+0\.080000\. Residual ◎−0\.031000 spread pro rata by capital\.$/);
  out = await run({ mode: "enforce" });
  assert.deepEqual([out.rewritten, out.applied, sent.length, lines.length], [0, 0, 1, 3], "idempotent");
  // off does nothing; a group outside the window (last close > 24 h ago) is not taken
  assert.deepEqual(await run({ mode: "off" }), { groups: 0, pending: 0, rewritten: 0, read: null, applied: 0 });
  assert.equal((await run({ now: NOW + 3 * 86400_000 })).groups, 0);
  assert.equal((await run({ now: NOW + 3 * 86400_000, since: iso(T0) })).groups, 1, "closeAuditGroupSince widens it");
});

test("the cycle: a member whose close was not read gets no verdict and is retried 30 min apart", async () => {
  // Q's record chains it to P1/P2 by its estimated window, but the listing of its account
  // comes back empty (rate-limited): the close is missing, so the group has no verdict yet.
  const mk = (position, closeSec, held, extra) => ({ position, base_mint: MINT, pool_name: "TOK-SOL", recorded_at: iso(T0 + closeSec + 5), minutes_held: held, pnl_sol: 0, pnl_sol_net: 0, amount_sol: 1, chain_audit: { status: "incomplete", version: V }, ...extra });
  const records = [mk("P1", 1000, 16), mk("P2", 2000, 25), mk("Q", 2600, 20)];
  const lines = [];
  const session = {};
  const run = () => G.runGroupAuditCycle({ mode: "shadow", now: NOW, session, getRecords: () => records, store: memStore(records), chain: async () => ({ rpc: fakeRpc([]), PublicKey: FakeKey, wallet: W }), log: (l) => lines.push(l), sleepMs: 0 });
  let out = await run();
  assert.equal(out.read.members, 3);
  // P1/P2 are exact now (they end at 2000); Q's estimate starts at 2600 − 1200 − 600 = 800 → still chained
  assert.equal(out.read.status, "group_incomplete");
  assert.deepEqual(records.map((r) => !!r.tx_window), [true, true, false]);
  assert.match(lines.at(-1), /the closing transaction of Q was not among those read \(attempt 1\/3\)/);
  assert.equal(records[2].chain_audit.group.retry, true);
  // not retried before 30 min
  out = await run();
  assert.equal(out.read, null);
});

test("the cycle: exact windows that split an estimated group — no verdict on the wrong set", async () => {
  // P3 closed 900 s after P2's last transaction; its record says it was held 20 min, so the
  // estimate (start = close − 20 min − 10 min) chains it to P1/P2. On chain it lived 100 s.
  const mk = (position, closeSec, held, extra) => ({ position, base_mint: MINT, pool_name: "TOK-SOL", recorded_at: iso(T0 + closeSec + 5), minutes_held: held, pnl_sol: 0, pnl_sol_net: 0, amount_sol: 1, chain_audit: { status: "incomplete", version: V }, ...extra });
  const records = [mk("P1", 1000, 16), mk("P2", 2000, 25, { pnl_sol_net: 0.08, amount_sol: 2 }), mk("P3", 2900, 20)];
  const p3 = [tx("p3-open", 2800, { sol: -1, pos: "P3", op: "deploy" }), tx("p3-close", 2900, { sol: 1.001, pos: "P3", op: "close" })];
  const chainWithP3 = (log) => {
    const base = fakeRpc(log);
    return (fn) => fn({
      getSignaturesForAddress: async (pk) => (pk.addr === "P3" ? p3.map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: null })).reverse() : base((c) => c.getSignaturesForAddress(pk))),
      getParsedTransaction: async (sig) => p3.find((t) => t.signature === sig) || base((c) => c.getParsedTransaction(sig)),
    });
  };
  const lines = [], log = [];
  const session = {};
  const run = () => G.runGroupAuditCycle({ mode: "enforce", now: NOW, session, getRecords: () => records, store: memStore(records), chain: async () => ({ rpc: chainWithP3(log), PublicKey: FakeKey, wallet: W }), log: (l) => lines.push(l), sleepMs: 0 });
  let out = await run();
  assert.deepEqual([out.read.members, out.read.status, out.applied], [3, "regrouped", 0]);
  assert.match(lines[0], /exact windows regroup 3 → 2 positions — redone next cycle$/);
  assert.equal(records.some((r) => r.chain_audit.group), false, "nothing stamped on the wrong set");
  const txReads = log.filter((l) => l.startsWith("tx:")).length;
  // next cycle: the corrected group (P1, P2); the transactions already read are not read again
  out = await run();
  assert.deepEqual([out.read.members, out.read.status, out.applied], [2, "group_ok", 2]);
  assert.equal(log.filter((l) => l.startsWith("tx:")).length, txReads);
  assert.deepEqual(records.map((r) => r.pnl_sol_net_source), ["wallet_group", "wallet_group", undefined]);
  assert.equal((await run()).read, null);
});

test("known truth (fixtures): group wallet total = Σ of the members' own applied wallet figures", () => {
  const fx = JSON.parse(fs.readFileSync(new URL("./fixtures/close-audit-group.json", import.meta.url), "utf8"));
  for (const [name, f] of Object.entries(fx.groups)) {
    const members = f.records;
    const [g, ...rest] = G.buildCloseGroups(members);
    assert.equal(rest.length, 0, `${name}: one group`);
    assert.equal(g.members.length, members.length);
    const flows = G.summarizeGroupFlows({ members: g.members, memberTxs: new Map(Object.entries(f.memberTxs)), tokenTxs: f.tokenTxs, wallet: fx.wallet, baseMint: g.mint });
    const v = G.evaluateGroupAudit(g, { ...flows, history_complete: true });
    assert.equal(v.tx_count, f.expect.tx_count, `${name}: tx count`);
    assert.equal(v.wallet_sol, f.expect.wallet_sol, `${name}: wallet`);
    if (f.expect.all_applied) {
      // every member already carries its own wallet figure: the group must agree with their sum
      const sum = members.reduce((s, r) => s + r.pnl_sol_net, 0);
      assert.ok(Math.abs(v.wallet_sol - sum) <= 0.0076, `${name}: |group ${v.wallet_sol} − Σ applied ${sum}| ≤ ◎0.0076`);
      assert.deepEqual(v.shares, {}, "nothing to allocate");
    } else {
      assert.equal(v.status, f.expect.status, `${name}: status`);
      assert.deepEqual([v.ledger_sol, v.residual_sol], [f.expect.ledger_sol, f.expect.residual_sol], name);
      assert.deepEqual(v.shares, f.expect.shares, `${name}: shares`);
      // shadow: nothing moves; enforce: Σ ledger of the group = the group's wallet total
      const copy = JSON.parse(JSON.stringify(members));
      applyGroupVerdict(copy, v, { mode: "shadow" });
      assert.deepEqual(copy.map((r) => r.pnl_sol_net), members.map((r) => r.pnl_sol_net));
      applyGroupVerdict(copy, v, { mode: "enforce" });
      if (v.status === "group_ok") assert.ok(Math.abs(copy.reduce((s, r) => s + r.pnl_sol_net, 0) - v.wallet_sol) < 2e-6, `${name}: Σ ledger = wallet`);
    }
  }
});

test("config: shadow by default, off | shadow | enforce", () => {
  assert.equal(config.management.closeAuditGroupMode, "shadow");
  assert.equal(config.management.closeAuditGroupSince, null);
  assert.equal(G.normalizeGroupMode("enforce"), "enforce");
  assert.equal(G.normalizeGroupMode("on"), "shadow");
});

// ── untracked token swaps (ledger-truth line item) ─────────────────────────────────────
test("untracked token swaps: SOL ↔ one token, of a token no position uses", () => {
  const swap = (sol, tok, mint = "HhcfXb", logs = ["Program log: Instruction: Route"]) => ({
    meta: {
      err: null, preBalances: [5e9, 0], postBalances: [5e9 + Math.round(sol * 1e9), 0], logMessages: logs,
      preTokenBalances: [{ accountIndex: 1, mint, owner: W, uiTokenAmount: { uiAmountString: "0" } }],
      postTokenBalances: [{ accountIndex: 1, mint, owner: W, uiTokenAmount: { uiAmountString: String(tok) } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: { toString: () => W } }, { pubkey: { toString: () => "acct" } }] } },
  });
  assert.deepEqual(classifyTokenSwap(swap(-1.7586, 50000), W), { mint: "HhcfXb", sol: -1.7586, tokens: 50000 });
  assert.equal(classifyTokenSwap(swap(-1, 50000, "HhcfXb", ["Program log: Instruction: AddLiquidityByStrategy2"]), W), null, "a liquidity operation");
  assert.equal(classifyTokenSwap(swap(-0.00001, 50000), W), null, "fee only: an airdrop / account opening");
  assert.equal(classifyTokenSwap(swap(1, 50000), W), null, "SOL and token the same way");
  assert.equal(classifyTokenSwap({ meta: { err: "x" } }, W), null);
  const swaps = [
    { signature: "a", timestamp: "2026-10-04T14:36:00Z", mint: "HhcfXb", sol: -1.7586, tokens: 50000 },
    { signature: "b", timestamp: "2026-10-04T15:10:00Z", mint: "HhcfXb", sol: 1.6871, tokens: -50000 },
    { signature: "c", timestamp: "2026-10-04T16:00:00Z", mint: "POSMINT", sol: -0.5, tokens: 10 },   // a position's token by now
    { signature: "d", timestamp: "2026-10-06T00:00:00Z", mint: "LATER", sol: -0.2, tokens: 7 },      // outside the window
  ];
  const win = [Date.parse("2026-10-04T00:00:00Z"), Date.parse("2026-10-05T00:00:00Z")];
  const u = untrackedSwapsBetween(swaps, new Set(["POSMINT"]), ...win);
  assert.deepEqual([Math.round(u.sol * 1e4) / 1e4, u.count, u.mints, u.unbalanced], [-0.0715, 2, 1, 0]);
  // only the purchase inside the window: the SOL figure is not a result yet
  const half = untrackedSwapsBetween(swaps, [], win[0], Date.parse("2026-10-04T15:00:00Z"));
  assert.deepEqual([half.sol, half.unbalanced], [-1.7586, 1]);
  assert.equal(untrackedNote({ untracked_token_swaps: 2, untracked_token_swaps_sol: -0.0715, untracked_token_swaps_unbalanced: 0 }), ", untracked token swaps ◎-0.071");
  assert.equal(untrackedNote({ untracked_token_swaps: 0 }), "");
});
