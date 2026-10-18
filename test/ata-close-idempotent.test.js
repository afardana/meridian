// A token account is closed at most once per sweep (2026-10-18): the dust sweep closed a swept
// mint's account, then its janitor pass acted on a listing from before that close and sent a
// second CloseAccount that failed on chain (IncorrectProgramId) and logged a WALLET_ERROR.
import { Keypair, Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from "@solana/spl-token";
import bs58 from "bs58";

const keypair = Keypair.generate();
process.env.OPENAI_API_KEY = "mock-key";
process.env.PERSIST_BACKEND = "json";
process.env.DRY_RUN = "false";
process.env.RPC_URL = "http://127.0.0.1:1";
process.env.WALLET_PRIVATE_KEY = bs58.encode(keypair.secretKey);

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { closeEmptyTokenAccount, listEmptyTokenAccounts, sweepEmptyTokenAccounts } = await import("../tools/wallet.js");
const { closedAccounts, createClosedAccountLedger } = await import("../ata-close-ledger.js");

const mintA = Keypair.generate().publicKey;
const mintB = Keypair.generate().publicKey;
const ataOf = (mint) => getAssociatedTokenAddress(mint, keypair.publicKey, false, TOKEN_PROGRAM_ID);

// Fake chain. `onChain` is the truth; reads served from `snapshot` model an RPC that still shows
// an account for a moment after the close landed (the stale listing / balance read in the log).
let onChain, snapshot, sends;
const proto = Connection.prototype;
const real = {};
for (const m of ["getAccountInfo", "getTokenAccountBalance", "getParsedTokenAccountsByOwner", "getParsedAccountInfo", "getLatestBlockhash", "sendTransaction", "confirmTransaction"]) real[m] = proto[m];

function installFakeChain() {
  const mints = new Set([mintA.toString(), mintB.toString()]);
  proto.getAccountInfo = async (pk) => {
    const k = pk.toString();
    if (mints.has(k)) return { owner: TOKEN_PROGRAM_ID, lamports: 1, data: Buffer.alloc(0) };
    return snapshot.has(k) ? { owner: TOKEN_PROGRAM_ID, lamports: 2039280, data: Buffer.alloc(0) } : null;
  };
  // getAccountInfo for the ata is the post-failure existence re-read: it sees the truth
  const staleInfo = proto.getAccountInfo;
  proto.getAccountInfo = async (pk, c) => (mints.has(pk.toString()) ? staleInfo(pk) : (onChain.has(pk.toString()) ? { owner: TOKEN_PROGRAM_ID } : null));
  proto.getTokenAccountBalance = async (pk) => {
    if (!snapshot.has(pk.toString())) throw new Error("could not find account");
    return { value: { amount: "0", uiAmount: 0 } };
  };
  proto.getParsedTokenAccountsByOwner = async (_o, { programId }) => ({
    value: programId.equals(TOKEN_PROGRAM_ID)
      ? [...snapshot.entries()].map(([addr, mint]) => ({
          pubkey: new PublicKey(addr),
          account: { lamports: 2039280, data: { parsed: { info: { mint, tokenAmount: { amount: "0", uiAmount: 0 } } } } },
        }))
      : [],
  });
  proto.getParsedAccountInfo = async () => ({ value: null });
  proto.getLatestBlockhash = async () => ({ blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 1 });
  proto.sendTransaction = async (tx) => {
    // every close instruction's first account is the token account being closed
    const accts = tx.instructions.map((ix) => ix.keys[0].pubkey.toString());
    for (const a of accts) {
      sends.push(a);
      if (!onChain.has(a)) throw new Error('Transaction failed: {"InstructionError":[0,"IncorrectProgramId"]}');
    }
    accts.forEach((a) => onChain.delete(a)); // snapshot (the RPC's view) is left stale on purpose
    return "sig" + sends.length;
  };
  proto.confirmTransaction = async () => ({ value: { err: null } });
}

beforeEach(async () => {
  closedAccounts.clear();
  const a = (await ataOf(mintA)).toString();
  const b = (await ataOf(mintB)).toString();
  onChain = new Map([[a, mintA.toString()], [b, mintB.toString()]]);
  snapshot = new Map(onChain);
  sends = [];
  installFakeChain();
});

test("the janitor pass does not close the account the dust sweep just closed", async () => {
  const a = (await ataOf(mintA)).toString();
  // dust sweep step: reclaim the swept mint's account
  const first = await closeEmptyTokenAccount(mintA.toString());
  assert.equal(first.success, true);
  assert.deepEqual(sends, [a]);
  // janitor step, from a listing that still shows it (stale RPC view)
  const empties = await listEmptyTokenAccounts();
  assert.ok(!empties.some((e) => e.ata === a), "stale listing must not offer the just-closed account");
  for (const e of empties) await closeEmptyTokenAccount(e.mint);
  assert.equal(sends.filter((x) => x === a).length, 1, "closed at most once");
});

test("a direct second close of the same mint is skipped without a transaction", async () => {
  await closeEmptyTokenAccount(mintA.toString());
  const again = await closeEmptyTokenAccount(mintA.toString());
  assert.equal(again.success, false);
  assert.equal(again.reason, "Account already closed");
  assert.equal(again.error, undefined);
  assert.equal(sends.length, 1);
});

test("the batch sweep skips accounts closed a moment ago and closes the rest", async () => {
  const a = (await ataOf(mintA)).toString();
  const b = (await ataOf(mintB)).toString();
  await closeEmptyTokenAccount(mintA.toString());
  const r = await sweepEmptyTokenAccounts();
  assert.equal(r.closed, 1);
  assert.deepEqual(sends, [a, b]);
  // a second sweep from the same stale view has nothing left to close
  const r2 = await sweepEmptyTokenAccounts();
  assert.equal(r2.closed, 0);
  assert.equal(sends.length, 2);
});

test("an account that vanished under the close is 'does not exist', not an error", async () => {
  const a = (await ataOf(mintA)).toString();
  onChain.delete(a); // gone on chain, but the balance read still sees it
  const logs = [];
  const orig = console.error;
  console.error = (l) => logs.push(String(l));
  let r;
  try { r = await closeEmptyTokenAccount(mintA.toString()); } finally { console.error = orig; }
  assert.equal(r.success, false);
  assert.equal(r.reason, "Account does not exist");
  assert.ok(!logs.some((l) => l.includes("WALLET_ERROR")), "no WALLET_ERROR for a missing account");
});

test("a real failure on an account that still exists is still an error", async () => {
  proto.sendTransaction = async () => { throw new Error("blockhash expired"); };
  const r = await closeEmptyTokenAccount(mintA.toString());
  assert.equal(r.success, false);
  assert.match(r.error, /blockhash expired/);
});

test("ledger entries expire so a re-created account can be closed later", () => {
  let t = 1000;
  const l = createClosedAccountLedger({ ttlMs: 60_000, now: () => t });
  l.note("acct");
  assert.equal(l.has("acct"), true);
  t += 59_000;
  assert.equal(l.has("acct"), true);
  t += 2_000;
  assert.equal(l.has("acct"), false);
});

test("the dust sweep janitor still goes through the guarded wallet helpers", () => {
  const src = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(src, /const empties = await listEmptyTokenAccounts\(\);/);
  assert.match(src, /await closeEmptyTokenAccount\(e\.mint\)/);
});

test.after(() => { for (const [m, f] of Object.entries(real)) proto[m] = f; });
