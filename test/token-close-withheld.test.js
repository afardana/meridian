process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

// Token-2022 transfer-fee mints: a zero-balance account can still hold withheld fees
// and CloseAccount then fails (custom 0x23) — prod logged it every ~30 min on
// 2026-09-30. The close is now preceded by a permissionless harvest to the mint.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const { withheldTransferFee, buildCloseInstructions } = await import("../tools/wallet.js");

const parsed = (withheldAmount) => ({
  mint: "Mint111111111111111111111111111111111111111",
  tokenAmount: { amount: "0", uiAmount: 0 },
  extensions: [{ extension: "immutableOwner" }, { extension: "transferFeeAmount", state: { withheldAmount } }],
});

test("reads withheld transfer fees from a jsonParsed account", () => {
  assert.equal(withheldTransferFee(parsed(12345)), 12345n);
  assert.equal(withheldTransferFee(parsed(0)), 0n);
  assert.equal(withheldTransferFee({ tokenAmount: { amount: "0" } }), 0n);
  assert.equal(withheldTransferFee(null), 0n);
});

const account = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;

test("a Token-2022 account with withheld fees is harvested to the mint before the close", () => {
  const ixs = buildCloseInstructions({ account, mint, owner, programId: TOKEN_2022_PROGRAM_ID, withheld: 5n });
  assert.equal(ixs.length, 2);
  assert.ok(ixs.every((ix) => ix.programId.equals(TOKEN_2022_PROGRAM_ID)));
  assert.ok(ixs[0].keys.some((k) => k.pubkey.equals(mint) && k.isWritable), "harvest writes the mint");
  assert.ok(ixs[0].keys.some((k) => k.pubkey.equals(account)), "harvest reads from the account");
  assert.ok(ixs[1].keys[0].pubkey.equals(account), "then close the account");
});

test("no harvest without withheld fees, and never on the classic token program", () => {
  assert.equal(buildCloseInstructions({ account, mint, owner, programId: TOKEN_2022_PROGRAM_ID, withheld: 0n }).length, 1);
  const classic = buildCloseInstructions({ account, mint, owner, programId: TOKEN_PROGRAM_ID, withheld: 7n });
  assert.equal(classic.length, 1);
  assert.ok(classic[0].programId.equals(TOKEN_PROGRAM_ID));
});
