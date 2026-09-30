process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const { transferFeeBpsFromParsedMint, straddleTopUpRaw, isStraddleFundingError } = await import("../harvest-straddle.js");

// Real stage-C failures (2026-09-26 … 29), read from the landed transactions:
//   GO-SOL   3dFWZNh8…  wallet 2414.053539 base, program pulled 2414.739662 (0.686 short)
//   ELON-SOL 4yqT6jqL…  base leg fine, wSOL leg pulled 0.000064238 SOL from an empty wSOL ATA
//   tOpenAI  preflight "Simulation failed" — Token-2022 mint with a 20 bps transfer fee

test("GO-SOL: 1 % headroom leaves more than the 0.686 base the program asked for on top", () => {
  const bought = 2414.053539;
  const topUp = straddleTopUpRaw(bought, 6, 100) / 1e6;
  assert.ok(topUp + 0.686123 < bought, `top-up ${topUp} + shortfall must fit in ${bought}`);
  assert.ok(topUp > bought * 0.98, "still deposits ~99 % of the bought base");
});

test("ELON-SOL: the 1 % SOL headroom covers the 64,238-lamport wSOL shortfall many times over", () => {
  // stage A leaves ~50 % of a ~0.4 SOL position in the account → ~0.2 SOL on the Y leg
  const yLegLamports = 0.2 * 1e9;
  assert.ok(yLegLamports * 100 / 10000 > 64238 * 20);
});

test("Token-2022 transfer fee is read from the mint and taken off the top-up", () => {
  const tOpenAI = { decimals: 9, extensions: [{ extension: "transferFeeConfig", state: {
    newerTransferFee: { epoch: 987, maximumFee: 18446744073709552000, transferFeeBasisPoints: 20 },
    olderTransferFee: { epoch: 987, maximumFee: 18446744073709552000, transferFeeBasisPoints: 20 } } }] };
  assert.equal(transferFeeBpsFromParsedMint(tOpenAI), 20);
  assert.equal(transferFeeBpsFromParsedMint({ decimals: 6 }), 0, "classic SPL mint");
  assert.equal(transferFeeBpsFromParsedMint({ extensions: [{ extension: "transferFeeConfig", state: {
    olderTransferFee: { transferFeeBasisPoints: 50 }, newerTransferFee: { transferFeeBasisPoints: 300 } } }] }), 300, "the larger of the two configs");
  const bought = 0.008900483;
  const topUp = straddleTopUpRaw(bought, 9, 100, 20);
  assert.ok(topUp * (1 + 20 / 10000) < bought * 1e9, "top-up plus its transfer fee fits the balance");
  assert.equal(straddleTopUpRaw(0, 9, 100), 0);
  assert.equal(straddleTopUpRaw(1, 9, 20000), 0, "headroom beyond 100 % deposits nothing");
});

test("funding refusals are recognised in all three observed shapes; other errors are not", () => {
  assert.ok(isStraddleFundingError("Transaction 3dFWZNh8… resulted in an error. "));
  assert.ok(isStraddleFundingError("Simulation failed. "));
  assert.ok(isStraddleFundingError('{"InstructionError":[3,{"Custom":1}]}'));
  assert.ok(isStraddleFundingError("Program log: Error: insufficient funds"));
  assert.ok(!isStraddleFundingError("block height exceeded"), "a confirmation timeout may have landed — never retried");
  assert.ok(!isStraddleFundingError("buy swap failed: 429"));
});

test("stage C wiring: headroom on the top-up and on the position's own X/Y, one retry, config key", () => {
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  const c = dlmm.slice(dlmm.indexOf("// ── C: top up the base"), dlmm.indexOf('noteFlow(respC, solPerBase, "deposit");'));
  assert.match(c, /straddleTopUpRaw\(boughtX, decX, headroomBps, feeBpsX\)/);
  assert.match(c, /simulateRebalancePositionWithBalancedStrategy\(posPk, pd, strategyType, new BN\(topUpRaw\), new BN\(0\), new BN\(headroomBps\), new BN\(headroomBps\)\)/);
  assert.match(c, /if \(attempt >= 2 \|\| !isStraddleFundingError\(e\.message\)\) throw e;/);
  assert.match(c, /pos = await pool\.getPosition\(posPk\);/, "re-reads the position before each attempt");
  const cfg = fs.readFileSync(new URL("../config.js", import.meta.url), "utf8");
  assert.match(cfg, /harvestStraddleHeadroomBps:\s+u\.harvestStraddleHeadroomBps\s+\?\? 100/);
  const exec = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  assert.match(exec, /harvestStraddleHeadroomBps: \["management", "harvestStraddleHeadroomBps"\]/);
});
