// Profit skimmer — orchestration (skim-flow.js) with fakes: flags, deadlines, the
// callback-message shape check and the unattended guard. Nothing is sent.
import test from "node:test";
import assert from "node:assert/strict";
import { createSkimFlow, skimBusyReasons } from "../skim-flow.js";
import { createSkimProposalStore, skimConfig } from "../skim-policy.js";
import { buildCallbackMessage } from "../telegram.js";

const DEST = "DFBHCEdXDCqHWPQDYPcp7RnhiGoM4dm4p2gCfv13QBMT";
const privateMsg = { chat: { type: "private", id: 1 }, from: { id: 1, is_bot: false } };
const hang = () => new Promise(() => {});

function harness(over = {}) {
  const flags = { claimed: false };
  const calls = { send: 0, evaluate: 0, scan: 0, resolve: 0 };
  let n = 0;
  const cfg = over.cfg || { ...skimConfig({ enabled: true }, { env: {} }) };
  const okEval = { cfg, destination: { ok: true, address: DEST, masked: "DFBH…QBMT" }, decision: { ok: true, amountSol: 0.5, figures: { freeSol: 3 } } };
  const flow = createSkimFlow({
    proposals: createSkimProposalStore({ randomId: () => `p${++n}` }),
    evaluate: over.evaluate || (async () => { calls.evaluate++; return okEval; }),
    scan: async () => { calls.scan++; return true; },
    send: over.send || (async (args, hooks) => {
      calls.send++;
      hooks.acquire();
      try { await hooks.waitReady(100); return { status: "landed", amountSol: args.amountSol, signature: "sig" }; } finally { hooks.release(); }
    }),
    reasons: over.reasons || (() => []),
    claim: () => { if (flags.claimed) throw new Error("taken"); flags.claimed = true; },
    unclaim: () => { flags.claimed = false; },
    pollerTickActive: () => false,
    resolvePending: over.resolvePending || (async () => { calls.resolve++; return { landed: [], failed: [], pending: [] }; }),
    pendingSkims: over.pendingSkims || (() => []),
    deadlineMs: 50,
    quietWaitMs: 0,
    sleep: async () => {},
    now: over.now,
  });
  return { flow, flags, calls };
}
const noFlags = (h) => {
  assert.equal(h.flags.claimed, false, "close slot / poller pause released");
  assert.equal(h.flow.state.confirmInFlight, false);
  assert.equal(h.flow.state.proposeInFlight, false);
};

test("skimBusyReasons", () => {
  assert.deepEqual(skimBusyReasons({}), []);
  assert.deepEqual(skimBusyReasons({ managementBusy: true, pollerTick: true }), ["management cycle running", "PnL poller tick running"]);
  assert.deepEqual(skimBusyReasons({ closeInFlight: true }), ["a close is in flight"]);
  assert.deepEqual(skimBusyReasons({ closeInFlight: true, holdingCloseSlot: true }), [], "the skimmer's own claim");
  assert.deepEqual(skimBusyReasons({ positions: [{ pending_flow: { x: 1 } }], deferredSwapPending: true }), ["a straddle / re-range flow is pending", "a deferred exit swap is pending"]);
  assert.deepEqual(skimBusyReasons({ positionsUnreadable: true }), ["position state unreadable"]);
});

test("propose never sends; confirm sends exactly the proposal once", async () => {
  const h = harness();
  const out = await h.flow.propose("command");
  assert.ok(out.proposal);
  assert.equal(h.calls.send, 0);
  const r = await h.flow.confirm(out.proposal.id, privateMsg, "command");
  assert.equal(r.status, "landed");
  assert.equal(h.calls.send, 1);
  const again = await h.flow.confirm(out.proposal.id, privateMsg, "command");
  assert.match(again.refused, /already used/);
  assert.equal(h.calls.send, 1);
  noFlags(h);
});

test("callback-message shape check: a button press in a private chat passes, in a group it does not", async () => {
  const cb = (type) => ({ id: "q", data: "skim:confirm:p1", from: { id: 1, is_bot: false }, message: { message_id: 9, chat: { type, id: 1 } } });
  const priv = buildCallbackMessage(cb("private"));
  assert.equal(priv.isCallback, true);
  assert.equal(priv.callbackData, "skim:confirm:p1");
  const h = harness();
  const p = (await h.flow.propose("button")).proposal;
  assert.match((await h.flow.confirm(p.id, buildCallbackMessage(cb("group")), "button")).refused, /private chat/);
  assert.equal(h.calls.send, 0);
  const p2 = (await h.flow.propose("button")).proposal;
  assert.equal((await h.flow.confirm(p2.id, priv, "button")).status, "landed");
  noFlags(h);
});

test("M1: exception or timeout at each await of confirm leaves no flag set", async () => {
  const cases = {
    evaluateThrows: { evaluate: async () => { throw new Error("rpc"); } },
    evaluateHangs: { evaluate: hang },
    sendThrows: { send: async (a, hooks) => { hooks.acquire(); throw new Error("boom"); } },
    reasonsThrow: { reasons: () => { throw new Error("state"); } },
  };
  for (const [name, over] of Object.entries(cases)) {
    if (!over) continue;
    // propose with a working flow, then confirm with one whose step fails (same proposal store)
    const store = createSkimProposalStore({ randomId: () => `id-${name}` });
    const flags = { claimed: false };
    const mk = (o = {}) => createSkimFlow({
      proposals: store,
      evaluate: o.evaluate || (async () => ({ cfg: skimConfig({ enabled: true }), destination: { ok: true, address: DEST, masked: "m" }, decision: { ok: true, amountSol: 0.5, figures: {} } })),
      scan: async () => true,
      send: o.send || (async () => ({ status: "landed", amountSol: 0.5 })),
      reasons: o.reasons || (() => []),
      claim: () => { flags.claimed = true; },
      unclaim: () => { flags.claimed = false; },
      pollerTickActive: () => false,
      resolvePending: async () => ({}),
      pendingSkims: () => [],
      deadlineMs: 40, quietWaitMs: 0, sleep: async () => {},
    });
    const good = mk();
    const proposal = (await good.propose("x")).proposal;
    const bad = mk(over);
    const started = Date.now();
    const r = await bad.confirm(proposal.id, privateMsg, "x");
    assert.ok(r.refused, `${name}: refused`);
    assert.ok(Date.now() - started < 2000, `${name}: bounded`);
    assert.equal(flags.claimed, false, `${name}: no claim left`);
    assert.equal(bad.state.confirmInFlight, false, `${name}: confirm flag reset`);
  }
});

test("M1: propose with a hung evaluation returns within the deadline and resets its flag", async () => {
  const h = harness({ evaluate: hang });
  const started = Date.now();
  const out = await h.flow.propose("command");
  assert.match(out.error, /longer than/);
  assert.ok(Date.now() - started < 2000);
  noFlags(h);
});

test("serialised: a second confirm while one is running is refused", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = harness({ send: async () => { await gate; return { status: "landed", amountSol: 0.5 }; } });
  const p = (await h.flow.propose("x")).proposal;
  const first = h.flow.confirm(p.id, privateMsg, "x");
  await new Promise((r) => setImmediate(r));
  const second = await h.flow.confirm("other", privateMsg, "x");
  assert.match(second.refused, /confirmation is running/);
  release();
  assert.equal((await first).status, "landed");
  noFlags(h);
});

test("unattended guard: with the confirmation required the cron only proposes, never sends", async () => {
  const h = harness();
  const r = await h.flow.cronTick({ enabled: true });
  assert.equal(r.action, "proposal");
  assert.equal(h.calls.send, 0);
  const again = await h.flow.cronTick({ enabled: true });
  assert.equal(again.action, "none", "at most one proposal per 6 h");
  noFlags(h);
});

test("unattended path only with the .env waiver, through the same confirm", async () => {
  const cfg = skimConfig({ enabled: true }, { env: { AUTO_SKIM_REQUIRE_CONFIRMATION: "false" } });
  assert.equal(cfg.requireConfirmation, false);
  const h = harness({ cfg });
  const r = await h.flow.cronTick({ enabled: true });
  assert.equal(r.action, "unattended");
  assert.equal(r.result.status, "landed");
  assert.equal(h.calls.send, 1);
  const strict = harness({ cfg: skimConfig({ enabled: true }, { env: { AUTO_SKIM_REQUIRE_CONFIRMATION: " false" } }) });
  assert.equal((await strict.flow.cronTick({ enabled: true })).action, "proposal");
  assert.equal(strict.calls.send, 0);
});

test("L2: disabled cron still resolves pending skims and alerts once per 6 h", async () => {
  let t = Date.parse("2026-11-25T12:00:00Z");
  const pending = [{ signature: "S", amount_sol: 0.5, status: "pending", created_at: new Date(t - 11 * 60e3).toISOString() }];
  const h = harness({ pendingSkims: () => pending, now: () => t });
  const r1 = await h.flow.cronTick({ enabled: false });
  assert.equal(h.calls.resolve, 1);
  assert.equal(h.calls.evaluate, 0, "no decision while disabled");
  assert.equal(r1.alerts.length, 1);
  t += 30 * 60e3;
  assert.equal((await h.flow.cronTick({ enabled: false })).alerts.length, 0);
  t += 6 * 3600e3;
  assert.equal((await h.flow.cronTick({ enabled: false })).alerts.length, 1);
  const young = harness({ pendingSkims: () => [{ ...pending[0], created_at: new Date(t - 5 * 60e3).toISOString() }], now: () => t });
  assert.equal((await young.flow.cronTick({ enabled: false })).alerts.length, 0, "not before 10 min");
});
