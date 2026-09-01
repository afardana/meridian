import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const source = fs.readFileSync(path.join(repoRoot, "index.js"), "utf8");
const walletSource = fs.readFileSync(path.join(repoRoot, "tools/wallet.js"), "utf8");
const pnlSource = fs.readFileSync(path.join(repoRoot, "tools/pnl.js"), "utf8");

assert.match(source, /const recoverableRentSol = aum\.recoverable_rent_sol \|\| 0/);
assert.match(source, /const recoverableRentUsd = aum\.recoverable_rent_usd \|\| 0/);
assert.match(source, /Recoverable ATA Rent/);
assert.match(source, /const heldTokensSol = aum\.tokens_sol \|\| 0/);
assert.match(source, /const heldTokensUsd = aum\.tokens_usd \|\| 0/);
assert.match(source, /Held Tokens/);
assert.match(
  source,
  /\$\{feeHtml\}\$\{rentHtml\}\$\{recoverableRentHtml\}\$\{heldTokensHtml\}/,
);
assert.match(pnlSource, /export function getPositionDiscoverySnapshot\(\)/);
assert.match(walletSource, /getPositionDiscoverySnapshot/);
assert.match(walletSource, /aumUntrackedPositionCount/);
assert.match(walletSource, /Including \$\{aumUntrackedPositionCount\} recently discovered position/);
assert.match(walletSource, /valuation_complete: aumValuationComplete/);
assert.match(source, /Skipping sample: \$\{aum\.untracked_position_count\} newly discovered position/);

console.log("Wallet status AUM component coverage passed.");
