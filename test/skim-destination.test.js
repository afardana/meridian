// Profit skimmer — the Telegram-set destination (/skim address, 2026-11-27; round 2: the
// journal is the truth, sanitiser, journal-first apply, test transfer). Mocks only: no
// network (a real web3.js Connection runs over a mocked fetch), throwaway keypairs, nothing sent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  parseSkimAddressInput,
  skimAddressHoldHours,
  createSkimAddressChangeStore,
  createSkimAddressCommands,
  skimEntryDestinations,
  skimDestinationLineText,
  journalDestinationState,
  maskAddressLong,
  SKIM_ADDRESS_CODE_ALPHABET,
  SKIM_ADDRESS_CHANGE_HOLD_HOURS,
} from "../skim-destination.js";
import { computeSkimDecision, createSkimProposalStore, skimConfig, skimLedger, reduceSkimJournal, maskAddress, maskAddressesIn, validateSkimSetting, testTransferSolFromEnv, SKIM_TEST_TRANSFER_SOL, SYSTEM_PROGRAM_ID } from "../skim-policy.js";
import { createSkimFlow, skimCommandGate, skimGateKey, isSkimCommandText, skimCommandArgs, skimSafeLogText } from "../skim-flow.js";
import {
  getSkimDestination,
  getEnvSkimDestination,
  verifySkimDestinationOnChain,
  checkSkimAddressCandidate,
  applySkimDestinationChange,
  applySkimDestinationVerified,
  sendSkim,
  appendSkimJournal,
  loadSkimJournal,
  readSkimJournal,
  skimJournalState,
  skimJournalReport,
  operatorResolveSkim,
  operatorAdoptSkim,
  _resetSkimDestinationCache,
} from "../tools/transfer.js";
import { config } from "../config.js";
import { executeTool } from "../tools/executor.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const H = 3_600_000;
const NOW = Date.parse("2026-11-27T05:00:00Z");
const wallet = Keypair.generate();
const W = wallet.publicKey.toBase58();
const ENV_DEST = Keypair.generate().publicKey.toBase58();
const NEW_DEST = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
const ALL_ADDRESSES = [W, ENV_DEST, NEW_DEST, OTHER];
const env = { PIONEX_DEPOSIT_ADDRESS: ENV_DEST };
const SYSTEM_OWNER = { owner: new PublicKey(SYSTEM_PROGRAM_ID), executable: false, lamports: 1 };
const fakeMirror = () => { let doc = { entries: {} }; return { get: () => doc, set: (d) => { doc = d; } }; };

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skimdest-"));
  return { dir, file: path.join(dir, "skim-destination.json"), journal: path.join(dir, "skim-journal.jsonl"), mirror: fakeMirror() };
}
const dest = (sb, over = {}) => getSkimDestination({ env, file: sb.file, journalFile: sb.journal, walletAddress: W, now: NOW, ...over });
const apply = (sb, change, over = {}) => applySkimDestinationChange(change, { file: sb.file, journalFile: sb.journal, mirror: sb.mirror, env, walletAddress: W, now: NOW, ...over });
const verify = (sb, over = {}) => applySkimDestinationVerified({ file: sb.file, journalFile: sb.journal, mirror: sb.mirror, env, walletAddress: W, now: NOW, ...over });
const setChange = (to = NEW_DEST) => ({ kind: "set", to, toMasked: maskAddress(to) });
const landSkimTo = (sb, to, sig = "8".repeat(88)) => {
  appendSkimJournal({ event: "pending", signature: sig, amount_sol: 0.5, at: new Date(NOW).toISOString(), last_valid_block_height: 1, destination: to }, sb.journal, null);
  appendSkimJournal({ event: "landed", signature: sig, amount_sol: 0.5, at: new Date(NOW).toISOString() }, sb.journal, null);
};

function mockConn(over = {}) {
  const calls = { send: [], accountInfo: 0 };
  return {
    calls,
    getAccountInfo: async () => { calls.accountInfo++; return SYSTEM_OWNER; },
    getBalance: async () => 5e9,
    getLatestBlockhash: async () => ({ blockhash: "GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W", lastValidBlockHeight: 1000 }),
    simulateTransaction: async () => ({ value: { err: null } }),
    sendRawTransaction: async (raw) => { calls.send.push(raw); return "sig"; },
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] }),
    getBlockHeight: async () => 900,
    getTransaction: async () => null,
    ...over,
  };
}
/** A real web3.js Connection whose every JSON-RPC call answers with an error (mocked fetch, no network). */
function failingConnection() {
  const fetchMock = async (_url, init) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Internal error" } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return new Connection("http://127.0.0.1:1", { fetch: fetchMock, disableRetryOnRateLimit: true });
}
function parsedTransfer({ from = W, to, lamports }) {
  return {
    meta: { err: null },
    transaction: { message: {
      accountKeys: [{ pubkey: from, signer: true }],
      instructions: [{ program: "system", programId: SYSTEM_PROGRAM_ID, parsed: { type: "transfer", info: { source: from, destination: to, lamports } } }],
    } },
  };
}
/** Captures every log line (logger.js writes to console.error) while fn runs. */
async function captureLogs(fn) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(" ")); };
  try { return { out: await fn(), lines }; } finally { console.error = orig; }
}
const noFullAddress = (texts, label = "") => {
  for (const t of texts) for (const a of ALL_ADDRESSES) assert.equal(String(t).includes(a), false, `${label} full address leaked: ${String(t).slice(0, 160)}`);
};
const sendDeps = (sb, conn, over = {}) => ({
  conn, wallet, env, destinationFile: sb.file, journalFile: sb.journal, mirror: sb.mirror,
  getBaseline: () => ({ total_deposited: 10, withdrawals: [] }), saveBaseline: () => {}, persist: async () => {}, dryRun: false, sleep: async () => {}, ...over,
});
const cfgOn = skimConfig({ enabled: true });
const decide = (d) => computeSkimDecision({ cfg: cfgOn, destination: d, baseline: { total_deposited: 10, total_withdrawn: 0, withdrawals: [] }, skims: [], baselineFresh: true, integrity: { ok: true, toBook: [] }, wallet: { freeSol: 12, valuationComplete: true, positions: [] }, now: NOW });

// ─── the sanitiser (blocker 1) ─────────────────────────────────────
test("maskAddressesIn: every 32–44-char base58 run masked 4…4; signatures, 8…8 and ordinary text untouched", () => {
  const sig = "5".repeat(88);
  const t = `failed to get info about account ${NEW_DEST}: x; balance for ${ENV_DEST.slice(0, 43)}; tx ${sig}; long ${maskAddressLong(NEW_DEST)}`;
  const m = maskAddressesIn(t);
  assert.equal(m.includes(NEW_DEST), false);
  assert.ok(m.includes(maskAddress(NEW_DEST)));
  assert.ok(m.includes(maskAddress(ENV_DEST.slice(0, 43))), "a 43-char address is masked too");
  assert.ok(m.includes(sig), "a transaction signature is not an address");
  assert.ok(m.includes(maskAddressLong(NEW_DEST)), "the deliberate 8…8 survives");
  assert.equal(maskAddressesIn("plain text 123"), "plain text 123");
  assert.equal(maskAddressesIn(null), null);
});

test("R1 (repro): an RPC error never carries the full address into the reply, the log, the card or the send refusal", async () => {
  const conn = failingConnection();
  const cand = await checkSkimAddressCandidate(NEW_DEST, { conn, walletAddress: W });
  assert.equal(cand.ok, false);
  assert.match(cand.error, /could not be read/);
  assert.equal(cand.error.includes(NEW_DEST), false, cand.error);
  assert.ok(cand.error.includes(maskAddress(NEW_DEST)));
  const lines = [];
  const cmds = createSkimAddressCommands({
    store: createSkimAddressChangeStore(),
    getDestination: () => ({ ok: true, address: null, masked: null, source: "env" }),
    getEnvDestination: () => ({ ok: false }),
    checkCandidate: (raw) => checkSkimAddressCandidate(raw, { conn, walletAddress: W }),
    apply: () => ({ ok: false }), log: (_c, l) => lines.push(l),
  });
  const replies = await cmds.handle(NEW_DEST);
  noFullAddress([...replies, ...lines], "commands");
  _resetSkimDestinationCache();
  const sb = sandbox();
  const d = await verifySkimDestinationOnChain({ conn, env, walletAddress: W, file: sb.file, journalFile: sb.journal, fresh: true });
  assert.equal(d.ok, false);
  noFullAddress([d.error, skimDestinationLineText(d)], "card");
  const { out: s, lines: sendLines } = await captureLogs(() => sendSkim({ amountSol: 0.5, reserveSol: 0.1, expectedDestination: ENV_DEST }, sendDeps(sb, conn)));
  assert.equal(s.status, "refused");
  noFullAddress([s.error, decide(d).reason, ...sendLines], "send");
});

test("sweep: the whole flow with every RPC failing — no test address in any captured log, reply or result", async () => {
  const conn = failingConnection();
  const sb = sandbox();
  const out = [];
  const { lines } = await captureLogs(async () => {
    const store = createSkimAddressChangeStore({ randomCode: () => "SWP234" });
    const cmds = createSkimAddressCommands({
      store, getDestination: () => dest(sb), getEnvDestination: () => getEnvSkimDestination({ env, walletAddress: W }),
      checkCandidate: (raw) => checkSkimAddressCandidate(raw, { conn, walletAddress: W }),
      apply: (c) => applySkimDestinationChange(c, { file: sb.file, journalFile: sb.journal, mirror: sb.mirror, env, walletAddress: W, now: NOW }),
      verify: () => verify(sb), log: (c, m) => console.error(`[${c}] ${m}`),
    });
    for (const a of ["", NEW_DEST, `confirm SWP234`, "reset", "verified", OTHER]) out.push(...await cmds.handle(a));
    const proposals = createSkimProposalStore({ randomId: () => "aa11" });
    const flow = createSkimFlow({
      proposals,
      evaluate: async () => { const d = await verifySkimDestinationOnChain({ conn, env, file: sb.file, journalFile: sb.journal, walletAddress: W, fresh: true }); return { cfg: cfgOn, destination: d, decision: decide(d) }; },
      scan: async () => true, send: (args, hooks) => sendSkim(args, { ...sendDeps(sb, conn), ...hooks }),
      reasons: () => [], claim: () => {}, unclaim: () => {}, pollerTickActive: () => false,
      resolvePending: async () => ({}), pendingSkims: () => [], deadlineMs: 2000, quietWaitMs: 0, sleep: async () => {}, now: () => NOW,
      log: (c, m) => console.error(`[${c}] ${m}`),
    });
    const p = await flow.propose("command");
    out.push(JSON.stringify(p.ev?.decision ?? p));
    const early = proposals.create({ amountSol: 0.5, destination: ENV_DEST, now: NOW });
    out.push(JSON.stringify(await flow.confirm(early.id, { chat: { type: "private" }, from: { is_bot: false } }, "command")));
    out.push(JSON.stringify(await sendSkim({ amountSol: 0.5, reserveSol: 0.1, expectedDestination: ENV_DEST }, sendDeps(sb, conn))));
    out.push(skimDestinationLineText(dest(sb)));
    out.push(JSON.stringify(skimJournalReport({ journalFile: sb.journal, mirror: sb.mirror, baseline: {} }).destinationChanges));
    out.push(JSON.stringify(await operatorResolveSkim("9".repeat(88), "landed", { conn, journalFile: sb.journal, mirror: null, getBaseline: () => ({}), saveBaseline: () => {}, env, walletAddress: W })));
  });
  assert.ok(lines.length > 0 && out.length > 5);
  noFullAddress([...out, ...lines], "sweep");
});

// ─── parsing / validation ──────────────────────────────────────────
test("parseSkimAddressInput: bad base58, wrong length, not 32 bytes, own wallet, PDA, programs → refused", () => {
  assert.match(parseSkimAddressInput("0".repeat(40)).error, /base58/);
  assert.match(parseSkimAddressInput("1".repeat(31)).error, /32–44/);
  assert.match(parseSkimAddressInput("2".repeat(45)).error, /32–44/);
  assert.match(parseSkimAddressInput("z".repeat(44)).error, /not 32/);
  assert.match(parseSkimAddressInput(W, { walletAddress: W }).error, /bot wallet/);
  const pda = PublicKey.findProgramAddressSync([Buffer.from("x")], new PublicKey(SYSTEM_PROGRAM_ID))[0].toBase58();
  assert.match(parseSkimAddressInput(pda).error, /off-curve/);
  assert.equal(parseSkimAddressInput("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").ok, false);
  const ok = parseSkimAddressInput(NEW_DEST, { walletAddress: W });
  assert.equal(ok.ok, true);
  assert.equal(ok.masked, maskAddress(NEW_DEST));
});

test("checkSkimAddressCandidate: token / program-owned / executable or an RPC failure refuses; reports whether the account exists", async () => {
  const at = (info) => checkSkimAddressCandidate(NEW_DEST, { conn: mockConn({ getAccountInfo: async () => info }), walletAddress: W });
  assert.match((await at({ owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), executable: false })).error, /not the System Program/);
  assert.match((await at({ owner: new PublicKey(SYSTEM_PROGRAM_ID), executable: true })).error, /executable/);
  assert.match((await checkSkimAddressCandidate(NEW_DEST, { conn: mockConn({ getAccountInfo: async () => { throw new Error(`failed to get info about account ${NEW_DEST}`); } }), walletAddress: W })).error, /could not be read/);
  const fresh = await at(null);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.onChain.exists, false);
  assert.equal((await at(SYSTEM_OWNER)).onChain.exists, true);
});

test("hold length: 24 h; .env AUTO_SKIM_ADDRESS_HOLD_HOURS only lengthens it; non-finite → 24", () => {
  assert.equal(SKIM_ADDRESS_CHANGE_HOLD_HOURS, 24);
  for (const v of [undefined, "", "1", "0", "-5", "abc", "Infinity", "NaN", "1e400"]) assert.equal(skimAddressHoldHours({ AUTO_SKIM_ADDRESS_HOLD_HOURS: v }), 24, String(v));
  assert.equal(skimAddressHoldHours({ AUTO_SKIM_ADDRESS_HOLD_HOURS: "48" }), 48);
  const sb1 = sandbox();
  assert.equal(apply(sb1, setChange(), { env: { ...env, AUTO_SKIM_ADDRESS_HOLD_HOURS: "1" } }).holdUntilMs, NOW + 24 * H, "not shortened");
  const sb2 = sandbox();
  assert.equal(apply(sb2, setChange(), { env: { ...env, AUTO_SKIM_ADDRESS_HOLD_HOURS: "48" } }).holdUntilMs, NOW + 48 * H, "lengthened");
  const again = apply(sb2, setChange(OTHER), { now: NOW + H });
  assert.equal(again.ok, true);
  assert.equal(again.holdUntilMs, NOW + 48 * H, "a later change never shortens the hold in force");
});

// ─── the two-step change ───────────────────────────────────────────
test("change store: 6-character CSPRNG code, expiry, 3 wrong codes burn it, cancel, one use, a new request replaces", () => {
  const store = createSkimAddressChangeStore();
  const c = store.create({ kind: "set", to: NEW_DEST, fromMasked: "x", now: NOW });
  assert.equal(c.code.length, 6);
  assert.ok([...c.code].every((ch) => SKIM_ADDRESS_CODE_ALPHABET.includes(ch)));
  assert.equal(c.toLong, maskAddressLong(NEW_DEST));
  assert.equal(store.peek(NOW).code, undefined, "peek never shows the code");
  assert.match(store.confirm("ZZZZZZ", NOW).reason, /2 tries left/);
  assert.match(store.confirm("SHORT", NOW).reason, /1 try left/, "a wrong length counts as a try");
  assert.equal(store.confirm("ZZZZZZ", NOW).burned, true);
  assert.match(store.confirm(c.code, NOW).reason, /no address change is pending/);
  const c2 = store.create({ kind: "set", to: NEW_DEST, now: NOW });
  assert.equal(store.confirm(c2.code.toLowerCase(), NOW + 1000).ok, true, "case-insensitive");
  const c3 = store.create({ kind: "set", to: NEW_DEST, now: NOW });
  assert.match(store.confirm(c3.code, NOW + 10 * 60e3 + 1).reason, /expired/);
  store.create({ kind: "set", to: NEW_DEST, now: NOW });
  assert.equal(store.create({ kind: "reset", to: ENV_DEST, now: NOW }).replaced, true);
  assert.equal(store.cancel(), true);
  assert.equal(store.cancel(), false);
  const codes = new Set(Array.from({ length: 50 }, () => createSkimAddressChangeStore().create({ kind: "set", to: NEW_DEST, now: NOW }).code));
  assert.ok(codes.size > 45, "codes are random");
});

test("gate keys: set / confirm / reset / verified / show need the private chat; cancel does not; /Skim and /skim@Bot are skim commands", () => {
  const group = { chat: { type: "group" }, from: { is_bot: false } };
  const priv = { chat: { type: "private" }, from: { is_bot: false } };
  for (const sub of ["address", `address ${NEW_DEST.toLowerCase()}`, "address confirm abc123", "address reset", "address verified"]) {
    assert.equal(skimGateKey(sub), "address", sub);
    assert.match(skimCommandGate(skimGateKey(sub), group), /private chat/, sub);
    assert.equal(skimCommandGate(skimGateKey(sub), priv), null, sub);
  }
  assert.equal(skimCommandGate(skimGateKey("ADDRESS   Cancel"), group), null);
  for (const t of ["/skim", "/Skim address", "/SKIM", "/skim@MeridianBot address cancel", "/skim@Bot", "/skim\taddress"]) assert.equal(isSkimCommandText(t), true, t);
  for (const t of ["/skimmer", "skim", "/skim-x", "/skims"]) assert.equal(isSkimCommandText(t), false, t);
  assert.equal(skimCommandArgs(`/Skim@MeridianBot address ${NEW_DEST}`), `address ${NEW_DEST}`);
  assert.equal(skimSafeLogText(`/SKIM address ${NEW_DEST}`).includes(NEW_DEST), false);
  assert.equal(skimSafeLogText(`deploy into ${NEW_DEST}`), `deploy into ${NEW_DEST}`, "non-skim text untouched");
  // the generic Telegram lines use it
  const idx = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  for (const needle of ["`Incoming: ${skimSafeLogText(text)}`", "${skimSafeLogText(text).slice(0, 60)}", "`Request: ${skimSafeLogText(text).slice(0, 240)}`"]) assert.ok(idx.includes(needle), needle);
});

// ─── the journal is the truth (blocker 2) ──────────────────────────
test("R2 (repro): a raw write of skim-destination.json with no journal line is refused, the send does not broadcast", async () => {
  const sb = sandbox();
  fs.writeFileSync(sb.file, JSON.stringify({ source: "telegram", address: OTHER, set_at: "2020-01-01T00:00:00Z", hold_until: "2020-01-01T00:00:00Z", verified: true }));
  const d = dest(sb);
  assert.equal(d.ok, false);
  assert.equal(d.address, null);
  assert.equal(d.mismatch, true);
  assert.match(d.error, /destination file does not match the journal/);
  const conn = mockConn();
  const r = await sendSkim({ amountSol: 0.5, reserveSol: 0.1, expectedDestination: OTHER, proposalId: "p1" }, sendDeps(sb, conn));
  assert.equal(r.status, "refused");
  assert.equal(conn.calls.send.length, 0);
  assert.equal((await sendSkim({ amountSol: 0.5, reserveSol: 0.1, expectedDestination: ENV_DEST }, sendDeps(sb, conn))).status, "refused", "no fallback to .env either");
});

test("file vs journal: matching → in force; missing with a journal line, or any differing field → refuse everything", () => {
  const sb = sandbox();
  assert.equal(dest(sb).source, "env", "no lines, no file → .env");
  assert.equal(dest(sb).address, ENV_DEST);
  assert.equal(apply(sb, setChange()).ok, true);
  const good = fs.readFileSync(sb.file, "utf8");
  const after = dest(sb, { now: NOW + 25 * H });
  assert.equal(after.ok, true);
  assert.equal(after.address, NEW_DEST);
  assert.equal(after.verified, false);
  const rec = JSON.parse(good);
  for (const [field, value] of [["address", OTHER], ["hold_until", new Date(NOW + 1 * H).toISOString()], ["set_at", new Date(NOW - H).toISOString()], ["verified", true]]) {
    fs.writeFileSync(sb.file, JSON.stringify({ ...rec, [field]: value }));
    const d = dest(sb, { now: NOW + 25 * H });
    assert.equal(d.ok, false, field);
    assert.match(d.error, new RegExp(`does not match the journal \\(${field} differ`), field);
  }
  fs.unlinkSync(sb.file);
  const gone = dest(sb, { now: NOW + 25 * H });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /missing but the journal has a destination change/);
  assert.equal(gone.address, null, "never the .env address");
  fs.writeFileSync(sb.file, "{garbage");
  assert.match(dest(sb, { now: NOW + 25 * H }).error, /unreadable or invalid/);
  fs.writeFileSync(sb.file, good);
  assert.equal(dest(sb, { now: NOW + 25 * H }).ok, true, "the matching copy is accepted again");
  const conn = mockConn();
  return verifySkimDestinationOnChain({ conn, fresh: true, file: sb.file, journalFile: sb.journal, env, walletAddress: W, now: NOW + 25 * H }).then((v) => assert.equal(v.ok, true));
});

test("repair path: /skim address and reset work on a mismatched / missing / corrupt file; the hold in force is never shortened", () => {
  const sb = sandbox();
  assert.equal(apply(sb, setChange(), { env: { ...env, AUTO_SKIM_ADDRESS_HOLD_HOURS: "72" } }).ok, true);
  fs.unlinkSync(sb.file);
  assert.equal(dest(sb).mismatch, true);
  const r = apply(sb, setChange(NEW_DEST), { now: NOW + H });
  assert.equal(r.ok, true, "re-sending the same address repairs");
  assert.equal(r.holdUntilMs, NOW + 72 * H, "max(hold in force, fresh 24 h)");
  assert.equal(dest(sb, { now: NOW + 73 * H }).address, NEW_DEST);
  fs.writeFileSync(sb.file, "{not json");
  const reset = apply(sb, { kind: "reset", to: ENV_DEST }, { now: NOW + 2 * H });
  assert.equal(reset.ok, true, "reset repairs too");
  const d = dest(sb, { now: NOW + 73 * H });
  assert.equal(d.source, "env");
  assert.equal(d.address, ENV_DEST);
  assert.equal(d.verified, true, ".env counts as verified");
  assert.equal(JSON.parse(fs.readFileSync(sb.file, "utf8")).address, null);
  assert.equal(dest(sb, { now: NOW + 71 * H }).holdActive, true);
  assert.match(apply(sb, { kind: "reset", to: ENV_DEST }, { now: NOW + 3 * H }).error, /no Telegram-set destination/);
});

test("journal-first: a journal failure changes nothing; a file failure after the line refuses and says so; never rolled back", () => {
  // journal append fails outright → nothing journalled, no file
  const sb = sandbox();
  let cancelled = 0;
  const r = apply({ ...sb, journal: path.join(sb.dir, "nope", "j.jsonl") }, setChange(), { cancelProposal: () => { cancelled++; } });
  assert.equal(r.ok, false);
  assert.equal(r.journalled, false);
  assert.match(r.error, /nothing changed/);
  assert.equal(fs.existsSync(sb.file), false);
  assert.equal(cancelled, 0);
  // the file cannot be written (its directory is missing) → journalled, refuse, truthful error
  const sb2 = sandbox();
  const badFile = path.join(sb2.dir, "missing-dir", "skim-destination.json");
  const r2 = apply({ ...sb2, file: badFile }, setChange(), { cancelProposal: () => { cancelled++; } });
  assert.equal(r2.ok, false);
  assert.equal(r2.journalled, true);
  assert.match(r2.error, /change journalled but the file could not be written .* the skimmer refuses until you re-send the command/);
  assert.equal(cancelled, 1, "the open proposal is cancelled once the line is in");
  assert.equal(journalDestinationState(readSkimJournal(sb2.journal)).newest.to, NEW_DEST, "the line stays");
  assert.equal(dest({ ...sb2, file: badFile }).mismatch, true);
  fs.mkdirSync(path.dirname(badFile));
  assert.equal(apply({ ...sb2, file: badFile }, setChange(), { now: NOW + 60e3 }).ok, true, "re-sending repairs");
  assert.equal(fs.readdirSync(path.dirname(badFile)).filter((f) => f.endsWith(".tmp")).length, 0, "no temp file left");
});

test("R3 (repro): a directory fsync failure after the rename is a warning; a journal fsync failure is reported as journalled, not 'nothing changed'", () => {
  const origOpen = fs.openSync;
  const origFsync = fs.fsyncSync;
  // (a) dir fsync EIO after a successful rename
  const sb = sandbox();
  fs.openSync = (p, flags, ...rest) => { if (p === sb.dir && flags === "r") { const e = new Error("EIO: i/o error"); e.code = "EIO"; throw e; } return origOpen(p, flags, ...rest); };
  let ra;
  try { ra = apply(sb, setChange()); } finally { fs.openSync = origOpen; }
  assert.equal(ra.ok, true, JSON.stringify(ra));
  assert.match(ra.warning, /not confirmed durable|directory could not be synced/);
  assert.doesNotMatch(JSON.stringify(ra), /nothing changed/);
  assert.equal(dest(sb).address, NEW_DEST);
  // (b) the journal line lands, its fsync fails
  const sb2 = sandbox();
  let jfd = null;
  fs.openSync = (p, flags, ...rest) => { const fd = origOpen(p, flags, ...rest); if (p === sb2.journal && flags === "a") jfd = fd; return fd; };
  // only the journal's own fsync fails (once — the fd number is reused by later opens)
  fs.fsyncSync = (fd) => { if (fd === jfd) { jfd = null; const e = new Error("EIO"); e.code = "EIO"; throw e; } return origFsync(fd); };
  let rb;
  try { rb = apply(sb2, setChange()); } finally { fs.openSync = origOpen; fs.fsyncSync = origFsync; }
  // the line is in the journal: it decides, the file follows it, and the result says the write was not confirmed
  assert.equal(rb.journalled, true);
  assert.equal(rb.ok, true, JSON.stringify(rb));
  assert.match(rb.warning, /journal write was not confirmed durable/);
  assert.ok(fs.readFileSync(sb2.journal, "utf8").includes(NEW_DEST), "the line is in the journal");
  const d = dest(sb2);
  assert.equal(d.address, NEW_DEST, "what the journal says — never a silent .env");
  assert.equal(d.holdActive, true);
  // and had the line been lost later (crash before the data reached the disk), the file no longer matches → refuse
  fs.writeFileSync(sb2.journal, "");
  assert.equal(dest(sb2).mismatch, true);
});

test("write: a stale temp file is replaced, a pre-placed symlink at the temp path is not followed", () => {
  const sb = sandbox();
  const target = path.join(sb.dir, "victim.txt");
  fs.writeFileSync(target, "keep");
  fs.symlinkSync(target, `${sb.file}.${process.pid}.tmp`);
  assert.equal(apply(sb, setChange()).ok, true);
  assert.equal(fs.readFileSync(target, "utf8"), "keep", "the symlink target is untouched");
  assert.equal(JSON.parse(fs.readFileSync(sb.file, "utf8")).address, NEW_DEST);
  assert.equal(fs.lstatSync(sb.file).isSymbolicLink(), false);
});

// ─── apply / refusals ──────────────────────────────────────────────
test("apply: journal line, then the file from it; proposal cancelled; masked log; the hold survives a restart; never enables the skimmer", async () => {
  const sb = sandbox();
  const proposals = createSkimProposalStore({ randomId: () => "p1" });
  proposals.create({ amountSol: 0.5, destination: ENV_DEST, now: NOW });
  const enabledBefore = config.autoSkim.enabled;
  const { out: r, lines } = await captureLogs(() => apply(sb, setChange(), { cancelProposal: () => proposals.clear() }));
  assert.equal(r.ok, true);
  assert.equal(proposals.peek(NOW), null);
  const ev = readSkimJournal(sb.journal);
  assert.equal(ev.length, 1);
  assert.deepEqual(Object.keys(ev[0]).sort(), ["at", "from_masked", "hold_until", "kind", "set_at", "source", "to", "to_masked", "type"]);
  assert.equal(ev[0].to, NEW_DEST);
  const file = JSON.parse(fs.readFileSync(sb.file, "utf8"));
  assert.deepEqual(file, { address: NEW_DEST, set_at: ev[0].set_at, source: "telegram", previous_masked: maskAddress(ENV_DEST), hold_until: ev[0].hold_until, verified: false });
  assert.ok(lines.some((l) => l.includes(`[SKIM] destination changed ${maskAddress(ENV_DEST)} → ${maskAddress(NEW_DEST)} (telegram), hold until`)));
  noFullAddress(lines, "apply log");
  assert.equal(dest(sb).holdActive, true);
  _resetSkimDestinationCache();
  assert.equal(dest(sb, { now: NOW + 23 * H }).holdActive, true, "restart: the hold is in the journal");
  assert.equal(dest(sb, { now: NOW + 24 * H + 1 }).ok, true);
  assert.equal(config.autoSkim.enabled, enabledBefore, "an address change never touches the enabled state");
  assert.equal("destination" in config.autoSkim || "destinationAddress" in config.autoSkim, false);
});

test("apply refused while a skim is pending, being sent, confirming or proposing, or the journal is unreadable — nothing written", () => {
  const cases = {
    pending: (sb) => { appendSkimJournal({ event: "pending", signature: "S1", amount_sol: 0.5, at: "t", last_valid_block_height: 1 }, sb.journal, null); return {}; },
    sending: () => ({ busy: { sendInFlight: true } }),
    confirming: () => ({ busy: { confirmInFlight: true } }),
    proposing: () => ({ busy: { proposeInFlight: true } }),
    corruptJournal: (sb) => { fs.writeFileSync(sb.journal, '{"event":"pending","sig\n'); return {}; },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const sb = sandbox();
    const over = setup(sb);
    let cancelled = 0;
    const before = fs.existsSync(sb.journal) ? fs.readFileSync(sb.journal, "utf8") : null;
    const r = apply(sb, setChange(), { ...over, cancelProposal: () => { cancelled++; } });
    assert.equal(r.ok, false, name);
    assert.equal(fs.existsSync(sb.file), false, `${name}: no file`);
    assert.equal(fs.existsSync(sb.journal) ? fs.readFileSync(sb.journal, "utf8") : null, before, `${name}: no journal line`);
    assert.equal(cancelled, 0, name);
  }
});

test("the hold refuses propose, confirm and send", async () => {
  const sb = sandbox();
  assert.equal(decide(dest(sb)).ok, true, "before: a skim would be proposed");
  const proposals = createSkimProposalStore({ randomId: () => "c0ffee" });
  const early = proposals.create({ amountSol: 0.5, destination: ENV_DEST, now: NOW });
  assert.equal(apply(sb, setChange()).ok, true);
  assert.match(decide(dest(sb)).reason, /destination refused: the destination was changed — on hold until/);
  let sends = 0;
  const flow = createSkimFlow({
    proposals,
    evaluate: async () => { const d = dest(sb); return { cfg: cfgOn, destination: d, decision: decide(d) }; },
    scan: async () => true, send: async () => { sends++; return { status: "landed" }; },
    reasons: () => [], claim: () => {}, unclaim: () => {}, pollerTickActive: () => false,
    resolvePending: async () => ({}), pendingSkims: () => [], deadlineMs: 500, quietWaitMs: 0, sleep: async () => {}, now: () => NOW,
  });
  assert.equal((await flow.propose("command")).proposal, undefined);
  assert.match((await flow.confirm(early.id, { chat: { type: "private" }, from: { is_bot: false } }, "command")).refused, /on hold/);
  assert.equal(sends, 0);
  const conn = mockConn();
  const s = await sendSkim({ amountSol: 0.5, reserveSol: 0.1, expectedDestination: NEW_DEST }, sendDeps(sb, conn));
  assert.equal(s.status, "refused");
  assert.match(s.error, /on hold/);
  assert.equal(conn.calls.send.length, 0);
});

// ─── send ──────────────────────────────────────────────────────────
test("send: the proposal's destination must be the effective one before and inside the claim (journal + file re-read, fresh account check)", async () => {
  const sb = sandbox();
  const c1 = mockConn();
  assert.match((await sendSkim({ amountSol: 0.5, reserveSol: 0.1, expectedDestination: NEW_DEST }, sendDeps(sb, c1))).error, /destination changed since the proposal/);
  assert.match((await sendSkim({ amountSol: 0.5, reserveSol: 0.1 }, sendDeps(sb, c1))).error, /no proposal destination/);
  // a change lands (journal + matching file) while the send waits inside its claim
  const c2 = mockConn();
  let claimed = false;
  let claimedAtChange = null;
  const r2 = await sendSkim({ amountSol: 0.5, reserveSol: 0.1, expectedDestination: ENV_DEST }, sendDeps(sb, c2, {
    acquire: () => { claimed = true; }, release: () => { claimed = false; },
    waitReady: async () => {
      claimedAtChange = claimed;
      const line = { type: "destination_change", kind: "set", at: "2020-01-01T00:00:00.000Z", set_at: "2020-01-01T00:00:00.000Z", from_masked: "x", to: OTHER, to_masked: maskAddress(OTHER), source: "telegram", hold_until: "2020-01-02T00:00:00.000Z" };
      appendSkimJournal(line, sb.journal, null);
      fs.writeFileSync(sb.file, JSON.stringify({ address: OTHER, set_at: line.set_at, source: "telegram", previous_masked: "x", hold_until: line.hold_until, verified: false }));
    },
  }));
  assert.equal(claimedAtChange, true);
  assert.equal(r2.status, "refused");
  assert.match(r2.error, /destination changed since the proposal/);
  assert.equal(c2.calls.send.length, 0);
  // a token account inside the window refuses (the account check is fresh)
  const sb3 = sandbox();
  let n = 0;
  const c3 = mockConn({ getAccountInfo: async () => (++n === 1 ? SYSTEM_OWNER : { owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), executable: false }) });
  assert.match((await sendSkim({ amountSol: 0.5, reserveSol: 0.1, expectedDestination: ENV_DEST }, sendDeps(sb3, c3))).error, /not the System Program/);
  assert.equal(c3.calls.send.length, 0);
  // happy path: the pending line records the destination; the mirror only the mask
  const sb4 = sandbox();
  const ok = await sendSkim({ amountSol: 0.5, reserveSol: 0.1, expectedDestination: ENV_DEST }, sendDeps(sb4, mockConn()));
  assert.equal(ok.status, "landed");
  const pending = readSkimJournal(sb4.journal).find((e) => e.event === "pending");
  assert.equal(pending.destination, ENV_DEST);
  assert.equal(pending.destination_source, "env");
  assert.equal(JSON.stringify(sb4.mirror.get()).includes(ENV_DEST), false);
  const src = fs.readFileSync(path.join(ROOT, "tools/transfer.js"), "utf8");
  const sendSrc = src.slice(src.indexOf("export async function sendSkim("), src.indexOf("// ─── inputs for the decision"));
  assert.equal(/destination:\s*destinationDep|resolveDestination\s*=/.test(sendSrc.split("} = deps;")[0]), false, "no injectable destination that skips the re-check");
});

// ─── test-transfer rule ────────────────────────────────────────────
test("test transfer: a fixed ◎0.05 (env only within 0.01–0.1), not the configurable minimum; under the profit / reserve / cap rules", () => {
  const sb = sandbox();
  assert.equal(apply(sb, setChange()).ok, true);
  const later = NOW + 25 * H;
  const d = dest(sb, { now: later });
  assert.equal(d.verified, false);
  const dec = decide(d);
  assert.equal(dec.ok, true);
  assert.equal(dec.amountSol, SKIM_TEST_TRANSFER_SOL);
  assert.equal(SKIM_TEST_TRANSFER_SOL, 0.05);
  assert.equal(dec.testTransfer, true);
  assert.match(skimDestinationLineText(d, later), /one test transfer of ◎0\.05/);
  // /skim set min 5 does not change the test amount
  assert.equal(validateSkimSetting("min", "5", { maxPerSkimSol: 5, maxDailyTransferSol: 10 }).ok, true);
  const big = skimConfig({ enabled: true, minTransferAmountSol: 5, maxPerSkimSol: 5, maxDailyTransferSol: 10, targetWorkingCapitalSol: 0 });
  const decBig = computeSkimDecision({ cfg: big, destination: d, baseline: { total_deposited: 1, withdrawals: [] }, skims: [], baselineFresh: true, integrity: { ok: true }, wallet: { freeSol: 30, valuationComplete: true, positions: [] }, now: later });
  assert.equal(decBig.amountSol, 0.05, "min 5 → still ◎0.05");
  // the env range
  for (const [v, want] of [["0.08", 0.08], ["0.01", 0.01], ["0.1", 0.1], ["0.2", 0.05], ["0.005", 0.05], ["5", 0.05], ["abc", 0.05], ["Infinity", 0.05], [undefined, 0.05]]) assert.equal(testTransferSolFromEnv({ AUTO_SKIM_TEST_TRANSFER_SOL: v }), want, String(v));
  const env08 = skimConfig({ enabled: true }, { env: { AUTO_SKIM_TEST_TRANSFER_SOL: "0.08" } });
  assert.equal(computeSkimDecision({ cfg: env08, destination: d, baseline: { total_deposited: 10, withdrawals: [] }, skims: [], baselineFresh: true, integrity: { ok: true }, wallet: { freeSol: 12, valuationComplete: true, positions: [] }, now: later }).amountSol, 0.08);
  // less than the test amount skimmable → a clear refusal
  const thin = computeSkimDecision({ cfg: cfgOn, destination: d, baseline: { total_deposited: 10, withdrawals: [] }, skims: [], baselineFresh: true, integrity: { ok: true }, wallet: { freeSol: 10.03, valuationComplete: true, positions: [] }, now: later });
  assert.equal(thin.ok, false);
  assert.match(thin.reason, /less than the ◎0\.05 test transfer to the unverified destination is skimmable/);
  // a verified destination keeps the configured minimum
  assert.equal(decide(dest(sandbox())).amountSol, 1);
});

test("one test transfer per unverified destination: refused after a pending or a landed one since the change, allowed again after a failed one", () => {
  const sb = sandbox();
  assert.equal(apply(sb, setChange()).ok, true);
  const later = NOW + 25 * H;
  const d = dest(sb, { now: later });
  const at = (ms) => new Date(ms).toISOString();
  const sk = (status, created, to = NEW_DEST) => ({ signature: `${status}${created}`, amount_sol: 0.05, status, created_at: at(created), destination: to });
  const run = (skims) => computeSkimDecision({ cfg: cfgOn, destination: d, baseline: { total_deposited: 10, withdrawals: [] }, skims, baselineFresh: true, integrity: { ok: true }, wallet: { freeSol: 12, valuationComplete: true, positions: [] }, now: later });
  assert.equal(run([sk("pending", later - H)]).ok, false, "pending");
  const landedR = run([sk("landed", later - 3 * H)]);
  assert.equal(landedR.ok, false);
  assert.match(landedR.reason, /test transfer already sent — check it arrived, then \/skim address verified/);
  assert.equal(run([sk("failed", later - 3 * H)]).ok, true, "a failed one does not count");
  assert.equal(run([sk("landed", NOW - H)]).ok, true, "a landed skim from before the change does not count");
  assert.equal(run([sk("landed", later - 3 * H, OTHER)]).ok, true, "a skim to another address does not count");
});

test("send: computes the test cap itself (a caller or env cannot inflate it) and sends only one test transfer", async () => {
  const sb = sandbox();
  apply(sb, setChange(), { now: Date.now() - 25 * H }); // sendSkim resolves on the real clock: a change whose hold is over
  const big = await sendSkim({ amountSol: 1, reserveSol: 0.1, expectedDestination: NEW_DEST, testTransferCapSol: 5 }, sendDeps(sb, mockConn()));
  assert.match(big.error, /only one test transfer of ◎0\.05/);
  const envInflated = await sendSkim({ amountSol: 1, reserveSol: 0.1, expectedDestination: NEW_DEST }, sendDeps(sb, mockConn(), { env: { ...env, AUTO_SKIM_TEST_TRANSFER_SOL: "5" } }));
  assert.match(envInflated.error, /only one test transfer of ◎0\.05/, "an env value outside 0.01–0.1 is ignored");
  const src = fs.readFileSync(path.join(ROOT, "tools/transfer.js"), "utf8");
  assert.equal(/testTransferCapSol/.test(src), false, "no caller-supplied cap in the signature");
  const ok = await sendSkim({ amountSol: 0.05, reserveSol: 0.1, expectedDestination: NEW_DEST }, sendDeps(sb, mockConn()));
  assert.equal(ok.status, "landed");
  const second = await sendSkim({ amountSol: 0.05, reserveSol: 0.1, expectedDestination: NEW_DEST }, sendDeps(sb, mockConn()));
  assert.match(second.error, /test transfer already sent/);
  // a pending one blocks too; a failed one does not
  const sb2 = sandbox();
  apply(sb2, setChange(), { now: Date.now() - 25 * H });
  appendSkimJournal({ event: "pending", signature: "F".repeat(88), amount_sol: 0.05, at: new Date().toISOString(), last_valid_block_height: 1, destination: NEW_DEST }, sb2.journal, null);
  assert.equal((await sendSkim({ amountSol: 0.05, reserveSol: 0.1, expectedDestination: NEW_DEST }, sendDeps(sb2, mockConn()))).status, "refused", "pending");
  appendSkimJournal({ event: "failed", signature: "F".repeat(88), amount_sol: 0.05, at: new Date().toISOString() }, sb2.journal, null);
  assert.equal((await sendSkim({ amountSol: 0.05, reserveSol: 0.1, expectedDestination: NEW_DEST }, sendDeps(sb2, mockConn()))).status, "landed", "after a failed one it may go again");
});

test("verified: refused in the hold and without a landed skim since the change (A → reset → A needs a new test transfer)", () => {
  const sb3 = sandbox();
  const later = NOW + 25 * H;
  assert.equal(apply(sb3, setChange()).ok, true);
  assert.match(verify(sb3).error, /on hold/);
  assert.match(verify(sb3, { now: later }).error, /no skim to this address has landed since the change/);
  landSkimTo(sb3, OTHER);
  assert.match(verify(sb3, { now: later }).error, /no skim to this address has landed since the change/, "a skim to another address does not count");
  landSkimTo(sb3, NEW_DEST, "7".repeat(88));
  const v = verify(sb3, { now: later });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.stillRefused, null);
  const ev = readSkimJournal(sb3.journal).filter((e) => e.type === "destination_verified");
  assert.equal(ev.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(sb3.file, "utf8")).verified, true);
  const dv = dest(sb3, { now: later });
  assert.equal(dv.verified, true);
  assert.equal(decide(dv).testTransfer, false);
  assert.equal(decide(dv).amountSol, 1, "no longer capped");
  assert.match(verify(sb3, { now: later }).error, /already verified/);
  // A → reset → A: the old landed skim was before the new change
  assert.equal(apply(sb3, { kind: "reset", to: ENV_DEST }, { now: later + H }).ok, true);
  assert.equal(apply(sb3, setChange(), { now: later + 2 * H }).ok, true);
  const again = later + 30 * H;
  assert.equal(dest(sb3, { now: again }).verified, false);
  assert.match(verify(sb3, { now: again }).error, /no skim to this address has landed since the change/);
  // the verified flag must match the journal
  const sb4 = sandbox();
  assert.equal(apply(sb4, setChange()).ok, true);
  const rec = JSON.parse(fs.readFileSync(sb4.file, "utf8"));
  fs.writeFileSync(sb4.file, JSON.stringify({ ...rec, verified: true }));
  assert.match(dest(sb4, { now: later }).error, /verified differ/);
  assert.match(verify(sandbox()).error, /\.env address/);
});

test("integrity still failing after an apply: the reply says journalled but still refused, and why (journal lost while the mirror lists changes)", async () => {
  const sb = sandbox();
  assert.equal(apply(sb, setChange()).ok, true);
  fs.unlinkSync(sb.file);
  fs.unlinkSync(sb.journal);
  const r = apply(sb, setChange(), { now: NOW + H, getBaseline: () => ({}) });
  assert.equal(r.ok, true);
  assert.match(r.stillRefused, /destination change\(s\) the journal does not/);
  const { cmds } = commands(sb, { randomCode: () => "INT234", now: () => NOW + 2 * H });
  await cmds.handle(OTHER);
  const [reply, alert] = await cmds.handle("confirm INT234");
  assert.match(reply, /journalled, but the skimmer still refuses/);
  assert.match(reply, /Why: .*journal does not/);
  assert.doesNotMatch(reply, /✅/);
  assert.match(alert, /Skim destination changed/);
  noFullAddress([reply, alert]);
});

test("verified: a failed file write after the line refuses; re-sending /skim address verified rewrites the file", () => {
  const sb = sandbox();
  const later = NOW + 25 * H;
  assert.equal(apply(sb, setChange()).ok, true);
  landSkimTo(sb, NEW_DEST);
  const orig = fs.renameSync;
  fs.renameSync = () => { const e = new Error("EROFS"); e.code = "EROFS"; throw e; };
  let r;
  try { r = verify(sb, { now: later }); } finally { fs.renameSync = orig; }
  assert.equal(r.ok, false);
  assert.match(r.error, /verification journalled but the file could not be written/);
  assert.equal(dest(sb, { now: later }).mismatch, true);
  const again = verify(sb, { now: later });
  assert.equal(again.ok, true);
  assert.equal(readSkimJournal(sb.journal).filter((e) => e.type === "destination_verified").length, 1, "no second line");
  assert.equal(dest(sb, { now: later }).verified, true);
});

// ─── journal ───────────────────────────────────────────────────────
test("destination lines: ignored by the skim counters, mirrored masked, checked by the integrity rule, listed by the journal check", () => {
  const sb = sandbox();
  assert.equal(apply(sb, setChange()).ok, true);
  assert.equal(apply(sb, { kind: "reset", to: ENV_DEST }, { now: NOW + 60e3 }).ok, true);
  const loaded = loadSkimJournal(sb.journal);
  assert.deepEqual(reduceSkimJournal(loaded.events), []);
  const l = skimLedger({ total_deposited: 10, total_withdrawn: 0, withdrawals: [] }, [], NOW);
  assert.equal(l.skimmedTotal, 0);
  assert.equal(journalDestinationState(loaded.events).newest.to, null, "a reset line carries to: null");
  const js = skimJournalState({ journalFile: sb.journal, mirror: sb.mirror, baseline: {} });
  assert.equal(js.integrity.ok, true);
  const mc = sb.mirror.get().destination_changes;
  assert.deepEqual(mc.map((c) => c.to_masked), [maskAddress(NEW_DEST), "env"]);
  assert.equal(JSON.stringify(sb.mirror.get()).includes(NEW_DEST), false);
  const rep = skimJournalReport({ journalFile: sb.journal, mirror: sb.mirror, baseline: {} });
  assert.equal(rep.skims.length, 0);
  assert.equal(rep.destinationChanges.length, 2);
  noFullAddress([JSON.stringify(rep.destinationChanges)]);
  assert.match(skimJournalState({ journalFile: path.join(sb.dir, "gone.jsonl"), mirror: sb.mirror, baseline: {} }).integrity.reason, /missing but the Postgres mirror lists 2 destination change/);
  fs.writeFileSync(sb.journal, "");
  assert.match(skimJournalState({ journalFile: sb.journal, mirror: sb.mirror, baseline: {} }).integrity.reason, /destination change\(s\) the journal does not/);
});

test("resolve / adopt check the transfer against the entry's own destination; without one, .env or a journalled change", async () => {
  const sb = sandbox();
  assert.equal(apply(sb, setChange()).ok, true);
  const sig = "5".repeat(88);
  appendSkimJournal({ event: "pending", signature: sig, amount_sol: 0.5, at: "2026-11-27T00:00:00Z", last_valid_block_height: 1000, destination: NEW_DEST }, sb.journal, null);
  const landed = (to) => mockConn({ getSignatureStatuses: async () => ({ value: [{ confirmationStatus: "finalized", err: null }] }), getParsedTransaction: async () => parsedTransfer({ to, lamports: 5e8 }) });
  const deps = (conn) => ({ conn, journalFile: sb.journal, mirror: null, getBaseline: () => ({ withdrawals: [] }), saveBaseline: () => {}, env, walletAddress: W });
  const wrong = await operatorResolveSkim(sig, "landed", deps(landed(ENV_DEST)));
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /not the configured destination/);
  assert.equal((await operatorResolveSkim(sig, "landed", deps(landed(NEW_DEST)))).ok, true);
  const sig2 = "6".repeat(88);
  appendSkimJournal({ event: "pending", signature: sig2, amount_sol: 0.5, at: "2026-11-27T00:00:00Z", last_valid_block_height: 1000, destination_masked: maskAddress(ENV_DEST) }, sb.journal, null);
  assert.equal((await operatorResolveSkim(sig2, "landed", deps(landed(NEW_DEST)))).ok, false, "journalled, but not the recorded mask");
  assert.equal((await operatorResolveSkim(sig2, "landed", deps(landed(ENV_DEST)))).ok, true);
  assert.deepEqual(skimEntryDestinations({}, { envAddress: ENV_DEST, journalEvents: loadSkimJournal(sb.journal).events }).sort(), [ENV_DEST, NEW_DEST].sort());
  const sig3 = "4".repeat(88);
  const baseline = { withdrawals: [{ signature: sig3, amount: 0.5, reason: "manual_telegram_skim", timestamp: "2026-11-20T00:00:00Z" }] };
  const adopt = (to) => operatorAdoptSkim(sig3, { conn: mockConn({ getParsedTransaction: async () => parsedTransfer({ to, lamports: 5e8 }) }), journalFile: sb.journal, mirror: null, baseline, walletAddress: W, env });
  assert.match((await adopt(OTHER)).error, /not the configured destination/);
  assert.equal((await adopt(NEW_DEST)).ok, true);
});

// ─── the commands, end to end with the real apply ─────────────────
function commands(sb, over = {}) {
  const store = createSkimAddressChangeStore({ randomCode: over.randomCode });
  let cancelled = 0;
  const now = over.now ?? (() => NOW);
  const cmds = createSkimAddressCommands({
    store,
    getDestination: () => dest(sb, { now: now() }),
    getEnvDestination: () => getEnvSkimDestination({ env: over.env ?? env, walletAddress: W }),
    checkCandidate: (raw) => checkSkimAddressCandidate(raw, { conn: over.conn ?? mockConn(), walletAddress: W }),
    apply: (change) => applySkimDestinationChange(change, { file: sb.file, journalFile: sb.journal, mirror: sb.mirror, env: over.env ?? env, walletAddress: W, now: now(), busy: over.busy?.() ?? {}, cancelProposal: () => { cancelled++; } }),
    verify: () => verify(sb, { now: now() }),
    now,
  });
  return { cmds, store, cancelled: () => cancelled };
}

test("commands: set → code → confirm (8…8 + on-chain state in the two replies, 4…4 in the alert); reset; no full address anywhere", async () => {
  const sb = sandbox();
  const texts = [];
  let t = NOW;
  const { cmds, cancelled } = commands(sb, { randomCode: () => "ABC234", now: () => t, conn: mockConn({ getAccountInfo: async () => null }) });
  const say = async (arg) => { const r = await cmds.handle(arg); texts.push(...r); return r; };
  const { lines } = await captureLogs(async () => {
    assert.match((await say(""))[0], /Skim destination[\s\S]*\(\.env\)/);
    assert.match((await say(ENV_DEST))[0], /already is the destination/);
    const [pending] = await say(NEW_DEST);
    assert.ok(pending.includes(maskAddressLong(NEW_DEST)), "8…8 in the request reply");
    assert.match(pending, /does not exist on chain yet \(never received SOL\) — check the address character by character/);
    assert.match(pending, /\/skim address confirm ABC234/);
    assert.equal(fs.existsSync(sb.file), false);
    assert.match((await say("confirm WRONG1"))[0], /wrong code \(2 tries left\)/);
    const [confirmed, alert] = await say("confirm abc234");
    assert.ok(confirmed.includes(maskAddressLong(NEW_DEST)), "8…8 in the confirm reply");
    assert.match(confirmed, /does not exist on chain yet/);
    assert.match(alert, /⚠️ <b>Skim destination changed<\/b>/);
    assert.ok(alert.includes(maskAddress(NEW_DEST)) && !alert.includes(maskAddressLong(NEW_DEST)), "the alert stays 4…4");
    assert.match(alert, /If this was not you: <code>\/skim off<\/code>, then <code>\/skim address reset<\/code>/);
    assert.equal(cancelled(), 1);
    const [st] = await say("");
    assert.ok(!st.includes(maskAddressLong(NEW_DEST)), "status stays 4…4");
    assert.match(st, /on hold until[\s\S]*unverified/);
    t = NOW + 2 * H;
    await say("reset");
    assert.match((await say("confirm ABC234"))[1], /Skim destination changed/);
    const d = dest(sb, { now: t });
    assert.equal(d.source, "env");
    assert.equal(d.holdActive, true);
    assert.match((await say("reset"))[0], /no Telegram-set destination/);
  });
  noFullAddress([...texts, ...lines], "commands");
});

test("commands: expiry, three wrong codes, a busy skim at confirm, an RPC failure, the repair path from a corrupt file", async () => {
  let t = NOW;
  const sb = sandbox();
  const { cmds } = commands(sb, { randomCode: () => "QWE234", now: () => t });
  await cmds.handle(NEW_DEST);
  t += 10 * 60e3 + 1;
  assert.match((await cmds.handle("confirm QWE234"))[0], /expired/);
  await cmds.handle(NEW_DEST);
  await cmds.handle("confirm AAAAAA");
  await cmds.handle("confirm AAAAAA");
  assert.match((await cmds.handle("confirm AAAAAA"))[0], /3 wrong codes/);
  assert.equal(fs.existsSync(sb.file), false);
  const sb2 = sandbox();
  const busy = commands(sb2, { randomCode: () => "ZXC234", busy: () => ({ sendInFlight: true }) });
  await busy.cmds.handle(NEW_DEST);
  assert.match((await busy.cmds.handle("confirm ZXC234"))[0], /a skim is being sent/);
  assert.equal(busy.cancelled(), 0);
  const down = commands(sandbox(), { conn: failingConnection() });
  const [refused] = await down.cmds.handle(NEW_DEST);
  assert.match(refused, /could not be read/);
  noFullAddress([refused]);
  // a file without any journal line (mismatch) → /skim address repairs it
  const sb3 = sandbox();
  fs.writeFileSync(sb3.file, "{junk");
  const rep = commands(sb3, { randomCode: () => "RPR234" });
  assert.match((await rep.cmds.handle(NEW_DEST))[0], /not applied yet/);
  assert.match((await rep.cmds.handle("confirm RPR234"))[0], /applied/);
  assert.equal(dest(sb3).address, NEW_DEST);
  // reset is a repair too, even from a mismatch
  fs.unlinkSync(sb3.file);
  const rep2 = commands(sb3, { randomCode: () => "RST234" });
  assert.match((await rep2.cmds.handle("reset"))[0], /reset — not applied yet/);
  assert.match((await rep2.cmds.handle("confirm RST234"))[0], /applied/);
  assert.equal(dest(sb3).source, "env");
});

// ─── surface ───────────────────────────────────────────────────────
test("no LLM tool, update_config / CONFIG_MAP key or dashboard endpoint can reach the destination; the report carries it masked", async () => {
  const defs = fs.readFileSync(path.join(ROOT, "tools/definitions.js"), "utf8");
  assert.equal(/skim|PIONEX|skim-destination|skimDestination|destination_change/i.test(defs), false);
  const executor = fs.readFileSync(path.join(ROOT, "tools/executor.js"), "utf8");
  assert.equal(/PIONEX|skim-destination|skimDestination|SkimDestination|destinationAddress|autoSkim/.test(executor), false);
  for (const k of ["skimDestination", "skimDestinationAddress", "autoSkimDestination", "destinationAddress", "pionexDepositAddress", "PIONEX_DEPOSIT_ADDRESS", "skimAddress", "autoSkimAddressHoldHours", "skimAddressVerified"]) {
    const r = await executeTool("update_config", { changes: { [k]: NEW_DEST }, reason: "test" });
    assert.equal(r.success, false, k);
    assert.deepEqual(r.unknown, [k], k);
  }
  const importers = [];
  const users = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".") || e.name === "test") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") || e.name.endsWith(".cjs")) {
        const src = fs.readFileSync(p, "utf8");
        if (/from\s+["'][./]*skim-destination\.js["']/.test(src)) importers.push(path.relative(ROOT, p));
        if (/applySkimDestination(Change|Verified)/.test(src) && e.name !== "skim-destination.js") users.push(path.relative(ROOT, p));
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(importers.sort(), ["index.js", "tools/transfer.js"]);
  assert.deepEqual(users.sort(), ["index.js", "tools/transfer.js"]);
  const idx = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  assert.equal((idx.match(/applySkimDestinationChange\(/g) || []).length, 1);
  assert.equal((idx.match(/applySkimDestinationVerified\(/g) || []).length, 1);
  assert.equal(/\/command\/[a-z-]*(skim|destination|address)/i.test(idx), false);
  const report = fs.readFileSync(path.join(ROOT, "report.js"), "utf8");
  assert.ok(/skim_destination:/.test(report));
  assert.ok(/skimDestination: skimDestinationReportField\(\)/.test(idx));
  const field = idx.slice(idx.indexOf("function skimDestinationReportField("), idx.indexOf("// Exit/peak confirmation"));
  assert.equal(/\.address\b/.test(field), false, "the report field never reads the full address");
});
