// /skim address through index.js's real text handler (handleSkimTextCommand): the private-chat
// gate for request / confirm / reset / verified, /Skim and /skim@Bot routing, /skim off dropping
// a pending change, and no full address in any reply or log line. Mocks only: the replies go to
// a capture hook, the address check to a stub connection, the data dir is a temp dir.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.MERIDIAN_DATA_DIR) process.env.MERIDIAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "skim-e2e-"));
const { Keypair, PublicKey } = await import("@solana/web3.js");
const ENV_DEST = Keypair.generate().publicKey.toBase58();
const NEW_DEST = Keypair.generate().publicKey.toBase58();
const OTHER = Keypair.generate().publicKey.toBase58();
process.env.PIONEX_DEPOSIT_ADDRESS = ENV_DEST;
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
process.env.OPENROUTER_API_KEY ??= "mock-key";

const { _skimTestApi } = await import("../index.js");
const { maskAddress } = await import("../skim-policy.js");
const { maskAddressLong } = await import("../skim-destination.js");
const { getSkimDestination, readSkimJournal, skimJournalPath, skimDestinationFile } = await import("../tools/transfer.js");

const replies = [];
_skimTestApi.setHooks({
  send: (t) => { replies.push(t); },
  conn: { getAccountInfo: async () => ({ owner: new PublicKey("11111111111111111111111111111111"), executable: false, lamports: 5 }) },
});
const priv = { chat: { type: "private", id: 1 }, from: { id: 1, is_bot: false } };
const group = { chat: { type: "group", id: 2 }, from: { id: 1, is_bot: false } };
const forwarded = { ...priv, forward_origin: { type: "user" } };
const botSender = { chat: { type: "private", id: 1 }, from: { id: 9, is_bot: true } };

async function run(text, msg) {
  const before = replies.length;
  const lines = [];
  const orig = console.error;
  console.error = (...a) => { lines.push(a.map(String).join(" ")); };
  let handled;
  try {
    handled = await _skimTestApi.handleSkimTextCommand(text, msg);
    const p = _skimTestApi.lastAddressRun();
    if (p) await p;
  } finally { console.error = orig; }
  return { handled, out: replies.slice(before), lines };
}
const journalLines = () => (fs.existsSync(skimJournalPath()) ? readSkimJournal().filter((e) => e.type) : []);
const noFull = (texts) => { for (const t of texts) for (const a of [ENV_DEST, NEW_DEST, OTHER]) assert.equal(String(t).includes(a), false, `leak: ${String(t).slice(0, 160)}`); };

test("the gate: request / confirm / reset / verified / show refused in a group, forwarded or from a bot — nothing changes", async () => {
  for (const [name, msg, re] of [["group", group, /private chat/], ["forwarded", forwarded, /forwarded/], ["bot", botSender, /bot/]]) {
    for (const cmd of [`/skim address ${NEW_DEST}`, "/skim address confirm ABC234", "/skim address reset", "/skim address verified", "/skim address", `/Skim@MeridianBot address ${NEW_DEST}`]) {
      const r = await run(cmd, msg);
      assert.equal(r.handled, true, `${name} ${cmd}`);
      assert.equal(r.out.length, 1, `${name} ${cmd}`);
      assert.match(r.out[0], re, `${name} ${cmd}`);
      noFull([...r.out, ...r.lines]);
    }
  }
  assert.equal(_skimTestApi.addressChanges.peek(), null);
  assert.equal(fs.existsSync(skimDestinationFile()), false);
  assert.equal(journalLines().length, 0);
  assert.equal(getSkimDestination().address, ENV_DEST);
});

test("R6: the gate log names a known subcommand or \"other\" — never the raw input (not even lowercased)", async () => {
  const r = await run(`/skim ${NEW_DEST}`, forwarded);
  const gl = r.lines.find((l) => l.includes("refused")) || "";
  assert.match(gl, /\[SKIM\] \/skim other refused: a forwarded message/);
  for (const t of [...r.lines, ...r.out]) {
    assert.equal(t.toLowerCase().includes(NEW_DEST.toLowerCase()), false, t);
  }
  const r2 = await run(`/skim address ${NEW_DEST}`, group);
  assert.ok(r2.lines.some((l) => /\[SKIM\] \/skim address refused/.test(l)));
  noFull([...r2.lines, ...r2.out]);
});

test("routing: /Skim, /SKIM and /skim@Bot are skim commands; cancel works in any chat; /skimmer is not one", async () => {
  const r = await run("/Skim@MeridianBot address cancel", group);
  assert.equal(r.handled, true);
  assert.match(r.out[0], /Nothing pending/);
  assert.equal((await run("/skimmer hello", priv)).handled, false);
});

test("private chat: request (8…8 + on-chain state) → confirm → journal line + file; replies and logs never hold a full address", async () => {
  const req = await run(`/SKIM address ${NEW_DEST}`, priv);
  assert.equal(req.handled, true);
  assert.ok(req.out[0].includes(maskAddressLong(NEW_DEST)));
  assert.match(req.out[0], /exists, holds SOL/);
  const code = /\/skim address confirm ([A-Z0-9]{6})/.exec(req.out[0])[1];
  const done = await run(`/skim@MeridianBot address confirm ${code.toLowerCase()}`, priv);
  assert.equal(done.out.length, 2);
  assert.match(done.out[0], /applied/);
  assert.ok(done.out[0].includes(maskAddressLong(NEW_DEST)));
  assert.match(done.out[1], /Skim destination changed/);
  assert.ok(done.out[1].includes(maskAddress(NEW_DEST)));
  const lines = journalLines().filter((e) => e.type === "destination_change");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].to, NEW_DEST);
  const d = getSkimDestination();
  assert.equal(d.address, NEW_DEST);
  assert.equal(d.holdActive, true);
  assert.equal(d.verified, false);
  const st = await run("/skim address", priv);
  assert.match(st.out[0], /on hold until/);
  noFull([...req.out, ...req.lines, ...done.out, ...done.lines, ...st.out, ...st.lines]);
});

test("verified is refused during the hold (through the handler)", async () => {
  const r = await run("/skim address verified", priv);
  assert.match(r.out[0], /Not verified.*on hold/s);
});

test("/skim off drops a pending address change", async () => {
  await run(`/skim address ${OTHER}`, priv);
  assert.notEqual(_skimTestApi.addressChanges.peek(), null);
  const r = await run("/skim off", group);
  assert.equal(_skimTestApi.addressChanges.peek(), null);
  assert.match(r.out[0], /pending destination change was dropped/);
  noFull([...r.out, ...r.lines]);
});
