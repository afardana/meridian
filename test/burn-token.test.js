import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const walletSource = fs.readFileSync(path.join(repoRoot, "tools/wallet.js"), "utf8");
const burnScript = fs.readFileSync(path.join(repoRoot, "scripts/burn_token.js"), "utf8");

assert.match(walletSource, /export async function burnAndCloseTokenAccount\(mintAddress\)/);
assert.match(walletSource, /createBurnCheckedInstruction/);
assert.match(walletSource, /createCloseAccountInstruction/);
assert.match(walletSource, /TOKEN_2022_PROGRAM_ID/);

assert.match(burnScript, /import \{ burnAndCloseTokenAccount \} from "\.\.\/tools\/wallet\.js"/);
assert.match(burnScript, /burnAndCloseTokenAccount\(mint\)/);

console.log("Burn and close token account tests passed.");
