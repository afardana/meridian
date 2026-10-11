process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Close audit v9: token-account rent is symmetric across an opener / closer pair ===");

const { summarizeFlows, evaluateCloseAudit, CLOSE_AUDIT_VERSION } = await import("../close-audit.js");
const { applyWalletNet } = await import("../lessons.js");
assert.equal(CLOSE_AUDIT_VERSION, 9);
const near = (a, b, eps = 2e-6) => Math.abs(a - b) <= eps;

// Real transactions (read on chain, trimmed to the wallet's balances and its own token
// accounts): baton-SOL J4oFb2LY opened the wallet's token account for the mint in its deploy and
// left it open (never-filled ladder, 0.98 fee tokens); baton-SOL 4b98tgF6, the next position in
// the token, closed that account after its exit swap. Under v8 the opener's rent was set aside
// and the closer was credited it: Σ audits 0.029195 vs Σ wallet 0.027681 (◎0.001514 too high).
{
  const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/close-audit-rent-pair.json", import.meta.url), "utf8"));
  const run = (k) => {
    const p = FX.positions[k];
    const f = summarizeFlows({ posTxs: p.posTxs, walletTxs: p.walletTxs, wallet: FX.wallet, baseMint: p.record.base_mint });
    f.wallet_history_complete = true;
    return { f, v: evaluateCloseAudit(p.record, f), p };
  };
  const a = run("J4oFb2LY"), b = run("4b98tgF6");
  // opener: rent set aside (v8, unchanged)
  assert.ok(near(a.f.open_account_rent_sol, 0.00151384, 1e-8) && a.f.released_account_rent_sol === 0);
  assert.deepEqual([a.v.status, a.v.net_sol, a.v.open_account_rent_sol], ["ok", -0.000008, 0.001514]);
  assert.equal(a.v.net_sol, a.p.stored_v8.net_sol, "the opener's figure does not move");
  // closer: the released rent is not its result (v9)
  assert.ok(near(b.f.released_account_rent_sol, 0.00151384, 1e-8) && b.f.open_account_rent_sol === 0);
  assert.ok(near(b.f.net_sol, 0.029203), "raw wallet sum still includes the rent");
  assert.deepEqual([b.v.status, b.v.net_sol, b.v.released_account_rent_sol], ["ok", 0.027689, 0.001514]);
  assert.ok(near(b.p.stored_v8.net_sol - b.v.net_sol, 0.001514));
  // Σ audits == Σ wallet
  const sumWallet = a.f.net_sol + b.f.net_sol, sumAudits = a.v.net_sol + b.v.net_sol;
  assert.ok(near(sumWallet, 0.027681), `Σ wallet ${sumWallet}`);
  assert.ok(near(sumAudits, 0.027681), `Σ audits ${sumAudits}`);
  assert.ok(near(a.p.stored_v8.net_sol + b.p.stored_v8.net_sol, 0.029195), "v8 summed ◎0.001514 above the wallet");
  // …and the figure written to the record is the adjusted one
  const rec = { ...b.p.record, chain_audit: b.v };
  assert.equal(applyWalletNet(rec, b.v), true);
  assert.deepEqual([rec.pnl_sol_net, rec.pnl_sol_net_modelled], [0.027689, 0.030708]);
  console.log("ok — baton J4oFb2LY → 4b98tgF6: Σ audits == Σ wallet == 0.027681");
}

// Unit sequences. One wallet token account of the mint at index 2; rent 0.002.
{
  const W = "WALLET", M = "MINT", POS = "POSITION", RENT = 0.002;
  const mk = ({ t, sol = 0, acct = [0, 0], tok = [null, null], op = null }) => ({
    blockTime: t, slot: t,
    transaction: { message: { accountKeys: [W, POS, "ATA"] } },
    meta: {
      err: null,
      preBalances: [10e9, 0, Math.round(acct[0] * 1e9)], postBalances: [10e9 + Math.round(sol * 1e9), 0, Math.round(acct[1] * 1e9)],
      preTokenBalances: tok[0] == null ? [] : [{ accountIndex: 2, owner: W, mint: M, uiTokenAmount: { uiAmountString: String(tok[0]) } }],
      postTokenBalances: tok[1] == null ? [] : [{ accountIndex: 2, owner: W, mint: M, uiTokenAmount: { uiAmountString: String(tok[1]) } }],
      logMessages: op ? [`Program log: Instruction: ${op}`] : [],
    },
  });
  // account-only wallet transactions (no token moves): open pays the rent, close returns it
  const openAcct = (t) => mk({ t, sol: -RENT, acct: [0, RENT], tok: [null, 0] });
  const closeAcct = (t) => mk({ t, sol: RENT, acct: [RENT, 0], tok: [0, null] });
  // the position's own transactions: SOL-only deploy / close (the mint's account is not listed)
  const deploy = mk({ t: 100, sol: -1 }), close = mk({ t: 400, sol: 1.05 });
  const flows = (walletTxs, posTxs = [deploy, close]) => summarizeFlows({ posTxs, walletTxs, wallet: W, baseMint: M });
  const rec = { pnl_sol_net: 0.05, amount_sol: 1, recorded_at: new Date(405 * 1000).toISOString() };
  const audit = (f) => evaluateCloseAudit(rec, f);

  // open → close inside the window: nothing either way
  let f = flows([openAcct(150), closeAcct(410)]);
  assert.deepEqual([f.open_account_rent_sol, f.released_account_rent_sol], [0, 0]);
  assert.ok(near(f.net_sol, 0.05) && near(audit(f).net_sol, 0.05));
  assert.equal("released_account_rent_sol" in audit(f), false);

  // open only: set aside (v8)
  f = flows([openAcct(150)]);
  assert.ok(near(f.open_account_rent_sol, RENT) && f.released_account_rent_sol === 0);
  assert.ok(near(f.net_sol, 0.05 - RENT) && near(audit(f).net_sol, 0.05));

  // close only: an earlier position's rent coming back — released, not income (v9)
  f = flows([closeAcct(410)]);
  assert.ok(f.open_account_rent_sol === 0 && near(f.released_account_rent_sol, RENT));
  assert.ok(near(f.net_sol, 0.05 + RENT) && near(audit(f).net_sol, 0.05));
  assert.equal(audit(f).released_account_rent_sol, 0.002);
  assert.ok(near(audit(f).diff_sol, 0));

  // close → reopen: back where it started, nothing either way
  f = flows([closeAcct(150), openAcct(200)]);
  assert.deepEqual([f.open_account_rent_sol, f.released_account_rent_sol], [0, 0]);
  assert.ok(near(audit(f).net_sol, 0.05));

  // close → reopen → close: one release
  f = flows([closeAcct(150), openAcct(200), closeAcct(410)]);
  assert.ok(f.open_account_rent_sol === 0 && near(f.released_account_rent_sol, RENT));
  assert.ok(near(f.net_sol, 0.05 + RENT) && near(audit(f).net_sol, 0.05));

  // the release inside a POSITION transaction (the close's exit path closes the account) counts too
  const closeWithAcct = mk({ t: 400, sol: 1.05 + RENT, acct: [RENT, 0], tok: [0, null], op: "RemoveLiquidity" });
  f = flows([], [deploy, closeWithAcct]);
  assert.ok(near(f.released_account_rent_sol, RENT) && near(audit(f).net_sol, 0.05));

  // a pair: opener + closer sum to the wallet
  const opener = flows([openAcct(150)]), closer = flows([closeAcct(410)]);
  assert.ok(near(audit(opener).net_sol + audit(closer).net_sol, opener.net_sol + closer.net_sol));

  // the verdict uses the adjusted figure: a rent-sized gap no longer hides in / pushes out of tolerance
  const tight = { pnl_sol_net: 0.05, amount_sol: 0.1, recorded_at: rec.recorded_at };
  assert.equal(evaluateCloseAudit(tight, { ...closer, net_sol: 0.05 + 0.0099 + RENT }).status, "ok");
  assert.equal(evaluateCloseAudit(tight, { ...closer, net_sol: 0.05 + 0.0101 + RENT }).status, "mismatch");
  console.log("ok — open/close 0, open only set aside, close only released, close/reopen/close one release");
}

console.log("✅ close audit v9 verified");
process.exit(0);
