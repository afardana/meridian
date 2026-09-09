#!/usr/bin/env node
import { burnAndCloseTokenAccount } from "../tools/wallet.js";
import { getWalletBalances } from "../tools/wallet.js";
import { log } from "../logger.js";

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.log("Usage: node scripts/burn_token.js <mintAddress or tokenSymbol>");
    process.exit(1);
  }

  let mint = target;

  // If user passed a symbol (e.g. "LOOKSMAX"), resolve it from wallet balances
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(target)) {
    console.log(`Resolving symbol "${target}" from wallet balances...`);
    const balances = await getWalletBalances({ freshPositions: false });
    const match = (balances.tokens || []).find(
      (t) => t.symbol?.toUpperCase() === target.toUpperCase()
    );
    if (!match) {
      console.error(`Could not find token with symbol "${target}" in wallet.`);
      process.exit(1);
    }
    mint = match.mint;
    console.log(`Found token ${match.symbol} with mint: ${mint} (balance: ${match.balance})`);
  }

  console.log(`Burning tokens and closing account for mint: ${mint}...`);
  const res = await burnAndCloseTokenAccount(mint);

  if (res.success) {
    console.log(`✅ Successfully burned ${res.burnedAmount} tokens and closed account ${res.ata}.`);
    console.log(`Transaction: https://solscan.io/tx/${res.tx}`);
  } else {
    console.error(`❌ Failed: ${res.reason || res.error}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
