// Profit skimmer — the one send function, with a mocked connection (no network, nothing is sent).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair, Transaction, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { sendSkim, resolvePendingSkims, operatorResolveSkim, operatorAdoptSkim, readSkimPositions, skimJournalReport, readSkimJournal, loadSkimJournal, appendSkimJournal, getSkims, skimJournalState } from "../tools/transfer.js";
import { maskAddress } from "../skim-policy.js";

const wallet = Keypair.generate();
const DEST = Keypair.generate().publicKey.toBase58();
const destination = { ok: true, address: DEST, masked: maskAddress(DEST), error: null };
const tmpJournal = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "skim-")), "skim-journal.jsonl");
const fakeMirror = () => { let doc = { entries: {} }; return { get: () => doc, set: (d) => { doc = d; } }; };
const hang = () => new Promise(() => {});

function mockConn(over = {}) {
  const calls = { send: [], sim: 0 };
  const conn = {
    calls,
    getBalance: async () => 5e9,
    getLatestBlockhash: async () => ({ blockhash: "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W", lastValidBlockHeight: 1000 }),
    simulateTransaction: async () => { calls.sim++; return { value: { err: null } }; },
    sendRawTransaction: async (raw) => { calls.send.push(raw); return "sig"; },
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] }),
    getBlockHeight: async () => 900,
    getTransaction: async () => null,
    ...over,
  };
  return conn;
}
const baselineStore = (b = { total_deposited: 10, total_withdrawn: 0, withdrawals: [] }) => {
  let saved = 0;
  return { get: () => b, save: () => { saved++; }, b, saves: () => saved };
};
function claimTracker() {
  const t = { claimed: false, acquires: 0, releases: 0 };
  t.acquire = () => { t.acquires++; t.claimed = true; };
  t.release = () => { t.releases++; t.claimed = false; };
  return t;
}
const deps = (conn, journalFile, bs, over = {}) => ({
  conn, wallet, destination, journalFile, mirror: over.mirror ?? fakeMirror(), getBaseline: bs.get, saveBaseline: bs.save,
  persist: async () => {}, dryRun: false, sleep: async () => {}, ...over,
});

test("happy path: journal 'pending' written BEFORE the broadcast; claim released at the broadcast; booked once", async () => {
  const journal = tmpJournal();
  const bs = baselineStore();
  const mirror = fakeMirror();
  const t = claimTracker();
  let atSend = null;
  const conn = mockConn({ sendRawTransaction: async (raw) => { atSend = { journal: readSkimJournal(journal), claimed: t.claimed, mirror: { ...mirror.get().entries } }; conn.calls.send.push(raw); return "x"; } });
  const r = await sendSkim({ amountSol: 0.5, proposalId: "ab12", reserveSol: 0.1, expectedFreeSol: 5 }, deps(conn, journal, bs, { mirror, acquire: t.acquire, release: t.release }));
  assert.equal(r.status, "landed");
  assert.equal(atSend.journal.length, 1);
  assert.equal(atSend.journal[0].event, "pending");
  assert.equal(atSend.claimed, true, "claimed during the pre-broadcast window");
  assert.equal(atSend.mirror[r.signature].status, "pending", "mirrored before the send");
  assert.equal(t.claimed, false);
  assert.equal(t.releases, 1);
  assert.equal(bs.b.withdrawals.length, 1);
  assert.equal(bs.b.withdrawals[0].skim, true);
  assert.equal(mirror.get().entries[r.signature].status, "landed");
  const tx = Transaction.from(conn.calls.send[0]);
  assert.equal(tx.instructions.length, 3);
  assert.ok(tx.instructions[0].programId.equals(ComputeBudgetProgram.programId));
  assert.ok(tx.instructions[1].programId.equals(ComputeBudgetProgram.programId));
  assert.ok(tx.instructions[2].programId.equals(SystemProgram.programId));
  assert.equal(tx.instructions[2].keys[1].pubkey.toBase58(), DEST);
  assert.equal(tx.instructions[2].data.readBigUInt64LE(4), 500_000_000n);
  await resolvePendingSkims({ conn, journalFile: journal, mirror, getBaseline: bs.get, saveBaseline: bs.save });
  assert.equal(bs.b.withdrawals.length, 1);
});

test("DRY_RUN stops after the simulation: no broadcast, no journal", async () => {
  const journal = tmpJournal();
  const conn = mockConn();
  const r = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(conn, journal, baselineStore(), { dryRun: true }));
  assert.equal(r.status, "dry_run");
  assert.equal(conn.calls.sim, 1);
  assert.equal(conn.calls.send.length, 0);
  assert.equal(readSkimJournal(journal).length, 0);
});

test("simulation error or a simulation that cannot run: refused, nothing sent", async () => {
  for (const simulateTransaction of [async () => ({ value: { err: { InsufficientFundsForRent: 0 } } }), async () => { throw new Error("rpc down"); }]) {
    const journal = tmpJournal();
    const conn = mockConn({ simulateTransaction });
    const r = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(conn, journal, baselineStore()));
    assert.equal(r.status, "refused");
    assert.equal(conn.calls.send.length, 0);
    assert.equal(readSkimJournal(journal).length, 0);
  }
});

test("refusals before signing: destination, reserve, amount, pending skim, busy, balance moved, close slot taken", async () => {
  const conn = mockConn({ getBalance: async () => 0.55e9 });
  assert.equal((await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(conn, tmpJournal(), baselineStore()))).status, "refused", "reserve");
  assert.equal((await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(mockConn(), tmpJournal(), baselineStore(), { destination: { ok: false, error: "x" } }))).status, "refused");
  assert.equal((await sendSkim({ amountSol: 0.001, reserveSol: 0.1 }, deps(mockConn(), tmpJournal(), baselineStore()))).status, "refused");
  assert.equal((await sendSkim({ amountSol: 0.5 }, deps(mockConn(), tmpJournal(), baselineStore()))).status, "refused", "no reserve given");
  const busy = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(mockConn(), tmpJournal(), baselineStore(), { preSendCheck: () => ["management cycle running"] }));
  assert.match(busy.error, /busy: management/);
  const moved = await sendSkim({ amountSol: 0.5, reserveSol: 0.1, expectedFreeSol: 4.9 }, deps(mockConn(), tmpJournal(), baselineStore()));
  assert.match(moved.error, /no longer matches/);
  const taken = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(mockConn(), tmpJournal(), baselineStore(), { acquire: () => { throw new Error("a close is in flight"); } }));
  assert.match(taken.error, /close is in flight/);
  const journal = tmpJournal();
  appendSkimJournal({ event: "pending", signature: "old", amount_sol: 1, at: "t", last_valid_block_height: 5 }, journal, null);
  const c = mockConn();
  const m = fakeMirror();
  assert.equal((await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(c, journal, baselineStore(), { mirror: m }))).status, "refused");
  assert.equal(c.calls.send.length, 0);
});

test("M1: a hang at every pre-broadcast await → refused within the deadline, claim released, lock free, nothing sent", async () => {
  const steps = {
    waitReady: { waitReady: hang },
    getBalance: { conn: { getBalance: hang } },
    getLatestBlockhash: { conn: { getLatestBlockhash: hang } },
    simulateTransaction: { conn: { simulateTransaction: hang } },
    persist: { persist: hang },
  };
  for (const [name, over] of Object.entries(steps)) {
    const journal = tmpJournal();
    const conn = mockConn(over.conn || {});
    const t = claimTracker();
    const started = Date.now();
    const r = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(conn, journal, baselineStore(), { ...over, conn, acquire: t.acquire, release: t.release, deadlineMs: 60 }));
    assert.equal(r.status, "refused", name);
    assert.ok(Date.now() - started < 2000, `${name}: bounded`);
    assert.equal(t.claimed, false, `${name}: claim released`);
    assert.equal(conn.calls.send.length, 0, `${name}: nothing broadcast`);
    if (name === "persist") assert.equal(getSkims(journal)[0].status, "failed", "a journaled intent is closed when the flush times out");
    else assert.equal(readSkimJournal(journal).length, 0);
    // the lock is free again: a normal send goes through
    const ok = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(mockConn(), tmpJournal(), baselineStore()));
    assert.equal(ok.status, "landed", `${name}: lock released`);
  }
});

test("M1: an exception at every pre-broadcast await → refused, claim released", async () => {
  const boom = async () => { throw new Error("boom"); };
  for (const over of [{ waitReady: boom }, { conn: { getBalance: boom } }, { conn: { getLatestBlockhash: boom } }, { persist: boom }, { preSendCheck: () => { throw new Error("boom"); } }]) {
    const conn = mockConn(over.conn || {});
    const t = claimTracker();
    const r = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(conn, tmpJournal(), baselineStore(), { ...over, conn, acquire: t.acquire, release: t.release }));
    assert.equal(r.status, "refused");
    assert.equal(t.claimed, false);
    assert.equal(conn.calls.send.length, 0);
  }
});

test("send throws and the blockhash expires unseen (primary has no tx) → failed; L1: primary has it → landed", async () => {
  const journal = tmpJournal();
  const conn = mockConn({ sendRawTransaction: async () => { throw new Error("socket hang up"); }, getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 1200 });
  const r = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(conn, journal, baselineStore()));
  assert.equal(r.status, "failed");
  assert.equal(getSkims(journal)[0].status, "failed");
  const j2 = tmpJournal();
  const bs = baselineStore();
  const c2 = mockConn({ getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 1200, getTransaction: async () => ({ meta: { err: null } }) });
  const r2 = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(c2, j2, bs));
  assert.equal(r2.status, "landed", "a backend's null status past expiry is not trusted when the primary has the transaction");
  assert.equal(bs.b.withdrawals.length, 1);
  const j3 = tmpJournal();
  let t = 0;
  const c3 = mockConn({ getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 1200, getTransaction: async () => { throw new Error("rpc"); } });
  const r3 = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(c3, j3, baselineStore(), { now: () => (t += 10_000) }));
  assert.equal(r3.status, "unknown", "lookup failure keeps it pending");
});

test("unconfirmed within the window → unknown, stays pending, blocks the next skim until resolved", async () => {
  const journal = tmpJournal();
  const mirror = fakeMirror();
  const bs = baselineStore();
  let t = 0;
  const conn = mockConn({ getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 950 });
  const r = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(conn, journal, bs, { mirror, now: () => (t += 10_000) }));
  assert.equal(r.status, "unknown");
  assert.equal(getSkims(journal)[0].status, "pending");
  assert.equal((await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(mockConn(), journal, bs, { mirror }))).status, "refused");
  const later = mockConn({ getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "finalized", err: null }] }) });
  const res = await resolvePendingSkims({ conn: later, journalFile: journal, mirror, getBaseline: bs.get, saveBaseline: bs.save });
  assert.equal(res.landed.length, 1);
  assert.equal(bs.b.withdrawals.length, 1);
  assert.equal(getSkims(journal)[0].status, "landed");
});

test("resolution: a skim the deposit scan already booked is not booked again; a landed journal skim missing from the baseline is booked", async () => {
  const journal = tmpJournal();
  appendSkimJournal({ event: "pending", signature: "S1", amount_sol: 0.5, at: "2026-11-25T00:00:00Z", last_valid_block_height: 5 }, journal, null);
  const bs = baselineStore({ total_deposited: 10, total_withdrawn: 0.5, withdrawals: [{ signature: "S1", amount: 0.5 }] });
  await resolvePendingSkims({ conn: mockConn(), journalFile: journal, mirror: null, getBaseline: bs.get, saveBaseline: bs.save });
  assert.equal(bs.b.withdrawals.length, 1);
  assert.equal(bs.b.total_withdrawn, 0.5);
  const j2 = tmpJournal();
  appendSkimJournal({ event: "pending", signature: "S2", amount_sol: 0.4, at: "2026-11-25T00:00:00Z", last_valid_block_height: 5 }, j2, null);
  appendSkimJournal({ event: "landed", signature: "S2", amount_sol: 0.4, at: "2026-11-25T00:00:05Z" }, j2, null);
  const b2 = baselineStore();
  await resolvePendingSkims({ conn: mockConn(), journalFile: j2, mirror: null, getBaseline: b2.get, saveBaseline: b2.save });
  assert.equal(b2.b.withdrawals.length, 1);
  assert.equal(b2.b.withdrawals[0].skim, true);
});

test("H1: torn last line is closed with a newline before the next append; the torn line refuses every skim", async () => {
  const journal = tmpJournal();
  fs.writeFileSync(journal, `${JSON.stringify({ event: "pending", signature: "A", amount_sol: 1, at: "t" })}\n{"event":"pending","signat`);
  appendSkimJournal({ event: "pending", signature: "B", amount_sol: 0.5, at: "t2", last_valid_block_height: 1 }, journal, null);
  const text = fs.readFileSync(journal, "utf8");
  assert.ok(text.includes('"signat\n{"event":"pending","signature":"B"'), "B is on its own line");
  const loaded = loadSkimJournal(journal);
  assert.equal(loaded.corrupt, 1);
  assert.deepEqual(loaded.events.map((e) => e.signature), ["A", "B"]);
  const js = skimJournalState({ journalFile: journal, mirror: null, baseline: {} });
  assert.equal(js.integrity.ok, false);
  const c = mockConn();
  const r = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(c, journal, baselineStore()));
  assert.match(r.error, /unreadable line/);
  assert.equal(c.calls.send.length, 0);
});

test("H1: a missing journal with mirror entries, or a baseline skim the journal does not know, refuses the send", async () => {
  const c = mockConn();
  const mirror = fakeMirror();
  mirror.set({ entries: { OLD: { status: "landed", amount_sol: 1 } } });
  const r = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(c, tmpJournal(), baselineStore(), { mirror }));
  assert.match(r.error, /missing but the Postgres mirror/);
  const bs = baselineStore({ total_deposited: 10, total_withdrawn: 1, withdrawals: [{ signature: "Z", amount: 1, skim: true }] });
  const r2 = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(c, tmpJournal(), bs));
  assert.match(r2.error, /does not know/);
  assert.equal(c.calls.send.length, 0);
});

test("L2: /skim resolve writes only what the chain shows", async () => {
  const journal = tmpJournal();
  const sig = "5".repeat(88);
  appendSkimJournal({ event: "pending", signature: sig, amount_sol: 0.5, at: "2026-11-25T00:00:00Z", last_valid_block_height: 1000 }, journal, null);
  const bs = baselineStore();
  const landedChain = mockConn({ getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "finalized", err: null }] }) });
  const no = await operatorResolveSkim(sig, "failed", { conn: landedChain, journalFile: journal, mirror: null, getBaseline: bs.get, saveBaseline: bs.save });
  assert.equal(no.ok, false, "cannot mark a landed transfer failed");
  assert.equal(getSkims(journal)[0].status, "pending");
  const pendingChain = mockConn({ getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 1001, getTransaction: async () => null });
  assert.equal((await operatorResolveSkim(sig, "failed", { conn: pendingChain, journalFile: journal, mirror: null, getBaseline: bs.get, saveBaseline: bs.save })).ok, false, "not expired yet");
  const yes = await operatorResolveSkim(sig, "landed", { conn: landedChain, journalFile: journal, mirror: null, getBaseline: bs.get, saveBaseline: bs.save });
  assert.equal(yes.ok, true);
  assert.equal(getSkims(journal)[0].status, "landed");
  assert.equal(bs.b.withdrawals.length, 1);
});

test("two concurrent sends: the second is refused by the lock", async () => {
  const journal = tmpJournal();
  const mirror = fakeMirror();
  let release;
  const gate = new Promise((r) => { release = r; });
  const conn = mockConn({ getBalance: async () => { await gate; return 5e9; } });
  const first = sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(conn, journal, baselineStore(), { mirror }));
  const second = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(conn, journal, baselineStore(), { mirror }));
  assert.equal(second.status, "refused");
  release();
  assert.equal((await first).status, "landed");
  assert.equal(conn.calls.send.length, 1);
});

test("N1: finalCheck runs inside the claim right before the journal write; onBroadcast after the send", async () => {
  const journal = tmpJournal();
  const conn = mockConn();
  const t = claimTracker();
  let claimedAtFinal = null;
  const r = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(conn, journal, baselineStore(), {
    acquire: t.acquire, release: t.release,
    finalCheck: () => { claimedAtFinal = t.claimed; return ["the skimmer was turned off"]; },
  }));
  assert.equal(claimedAtFinal, true);
  assert.match(r.error, /turned off/);
  assert.equal(readSkimJournal(journal).length, 0);
  assert.equal(conn.calls.send.length, 0);
  assert.equal(t.claimed, false);
  let broadcastSig = null;
  const ok = await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, deps(mockConn(), tmpJournal(), baselineStore(), { onBroadcast: (sig) => { broadcastSig = sig; } }));
  assert.equal(ok.status, "landed");
  assert.equal(broadcastSig, ok.signature);
});

test("N2: the skim's position read discards a possibly shared read and checks every account still exists", async () => {
  const P1 = Keypair.generate().publicKey.toBase58();
  const P2 = Keypair.generate().publicKey.toBase58();
  const reads = [];
  const stale = { source: "rpc", positions: [{ position: P1, total_value_usd: 1 }, { position: P2, total_value_usd: 1 }] };
  const fresh = { source: "rpc", positions: [{ position: P1, total_value_usd: 1.2 }] };
  const getPositions = async () => { reads.push(reads.length); return reads.length === 1 ? stale : fresh; };
  const conn = mockConn({ getMultipleAccountsInfo: async (keys) => keys.map(() => ({ lamports: 1 })) });
  const r = await readSkimPositions({ conn, getPositions, getTracked: () => ({ amount_sol: 1 }) });
  assert.equal(reads.length, 2, "the first (possibly shared) read is discarded");
  assert.deepEqual(r.positions.map((p) => p.position), [P1]);
  const gone = await readSkimPositions({ conn: mockConn({ getMultipleAccountsInfo: async (keys) => keys.map(() => null) }), getPositions: async () => fresh, getTracked: () => ({ amount_sol: 1 }) });
  assert.equal(gone.valuationComplete, false);
  assert.match(gone.invalidReason, /no longer exists/);
});

function parsedTransfer({ from, to, lamports, err = null, signer = true, extra = [] }) {
  return {
    meta: { err },
    transaction: { message: {
      accountKeys: [{ pubkey: from, signer }],
      instructions: [{ program: "compute-budget", programId: "ComputeBudget111111111111111111111111111111" }, { program: "system", programId: "11111111111111111111111111111111", parsed: { type: "transfer", info: { source: from, destination: to, lamports } } }, ...extra],
    } },
  };
}

test("N4: /skim adopt journals a legacy baseline skim only when the chain shows the transfer", async () => {
  const W = wallet.publicKey.toBase58();
  const sig = "4".repeat(88);
  const base = { total_deposited: 10, total_withdrawn: 0.5, withdrawals: [{ signature: sig, amount: 0.5, reason: "manual_telegram_skim", timestamp: "2026-09-21T00:00:00Z" }] };
  const run = (parsed) => operatorAdoptSkim(sig, { conn: mockConn({ getParsedTransaction: async () => parsed }), journalFile: tmpJournal(), mirror: null, baseline: base, walletAddress: W, destination });
  assert.match((await run(null)).error, /does not have/);
  assert.match((await run(parsedTransfer({ from: W, to: W, lamports: 5e8 }))).error, /not the configured destination/);
  assert.match((await run(parsedTransfer({ from: W, to: DEST, lamports: 4e8 }))).error, /booked withdrawal/);
  assert.match((await run(parsedTransfer({ from: W, to: DEST, lamports: 5e8, err: { x: 1 } }))).error, /failed on chain/);
  assert.match((await run(parsedTransfer({ from: W, to: DEST, lamports: 5e8, signer: false }))).error, /did not sign/);
  assert.match((await run(parsedTransfer({ from: W, to: DEST, lamports: 5e8, extra: [{ program: "spl-token", programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }] }))).error, /more than a SOL transfer/);
  const journal = tmpJournal();
  const ok = await operatorAdoptSkim(sig, { conn: mockConn({ getParsedTransaction: async () => parsedTransfer({ from: W, to: DEST, lamports: 5e8 }) }), journalFile: journal, mirror: null, baseline: base, walletAddress: W, destination });
  assert.equal(ok.ok, true);
  assert.equal(getSkims(journal)[0].status, "landed");
  assert.equal(skimJournalState({ journalFile: journal, mirror: null, baseline: base }).integrity.ok, true, "the block is lifted");
  assert.match((await operatorAdoptSkim(sig, { conn: mockConn(), journalFile: journal, mirror: null, baseline: base, walletAddress: W, destination })).error, /already has/);
  assert.match((await operatorAdoptSkim("3".repeat(88), { conn: mockConn(), journalFile: tmpJournal(), mirror: null, baseline: base, walletAddress: W, destination })).error, /neither/);
});

test("N4: a mirror-only signature is adopted with the chain's verdict (landed or failed), never pending", async () => {
  const W = wallet.publicKey.toBase58();
  const sig = "6".repeat(88);
  const mirror = fakeMirror();
  mirror.set({ entries: { [sig]: { status: "pending", amount_sol: 0.5, last_valid_block_height: 1000 } } });
  const notYet = await operatorAdoptSkim(sig, { conn: mockConn({ getParsedTransaction: async () => null, getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 1001 }), journalFile: tmpJournal(), mirror, baseline: {}, walletAddress: W, destination });
  assert.match(notYet.error, /chain says pending/);
  const j = tmpJournal();
  const failed = await operatorAdoptSkim(sig, { conn: mockConn({ getParsedTransaction: async () => null, getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 1200 }), journalFile: j, mirror, baseline: {}, walletAddress: W, destination });
  assert.equal(failed.verdict, "failed");
  assert.equal(getSkims(j)[0].status, "failed");
  const j2 = tmpJournal();
  const landed = await operatorAdoptSkim(sig, { conn: mockConn({ getParsedTransaction: async () => parsedTransfer({ from: W, to: DEST, lamports: 5e8 }) }), journalFile: j2, mirror, baseline: {}, walletAddress: W, destination });
  assert.equal(landed.verdict, "landed");
});

test("N4: /skim journal check names the unreadable line and what the mirror holds; repairs nothing", () => {
  const journal = tmpJournal();
  fs.writeFileSync(journal, `${JSON.stringify({ event: "pending", signature: "A", amount_sol: 1, at: "t" })}\n{"torn\n`);
  const before = fs.readFileSync(journal, "utf8");
  const mirror = fakeMirror();
  mirror.set({ entries: { A: { status: "pending" }, B: { status: "landed", amount_sol: 0.5 } } });
  const r = skimJournalReport({ journalFile: journal, mirror, baseline: { withdrawals: [{ signature: "C", amount: 1, skim: true }] } });
  assert.deepEqual(r.badLines, [{ line: 2, preview: '{"torn' }]);
  assert.deepEqual(r.mirrorEntries.filter((m) => !m.inJournal).map((m) => m.signature), ["B"]);
  assert.deepEqual(r.unknownBooked.map((w) => w.signature), ["C"]);
  assert.equal(r.integrity.ok, false);
  assert.equal(fs.readFileSync(journal, "utf8"), before, "read-only");
});
