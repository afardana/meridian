import { Connection, PublicKey } from "@solana/web3.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");

// Load .env to get the RPC URL
dotenv.config({ path: path.join(repoRoot, ".env") });

const RPC_URL = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const WALLET_ADDRESS = "HMBFSUujee6zrvBmSKVDh6LqnYfjzUzHqCeU4YzhDRgp";

async function main() {
  console.log(`Connecting to RPC: ${RPC_URL.split("?")[0]}`);
  const connection = new Connection(RPC_URL, "confirmed");
  const pubkey = new PublicKey(WALLET_ADDRESS);

  console.log(`Fetching transaction signatures for ${WALLET_ADDRESS}...`);
  // Get all signatures (we don't limit to 100 just in case there are more, but limit is high enough)
  const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 1000 });
  console.log(`Found ${signatures.length} signatures. Analyzing transaction details...`);

  let totalDeposited = 0;
  let depositCount = 0;
  const depositsList = [];

  // We want to process signatures from oldest to newest to trace deposits in order
  const sortedSignatures = [...signatures].reverse();

  for (const sigInfo of sortedSignatures) {
    const tx = await connection.getParsedTransaction(sigInfo.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed"
    });

    if (!tx) continue;

    // Check if the wallet is a signer
    const isSigner = tx.transaction.message.accountKeys.some(
      (acc) => acc.pubkey.toBase58() === WALLET_ADDRESS && acc.signer
    );

    if (isSigner) {
      // Operations signed by the bot wallet itself (deploy, close, swap, etc.) are skipped.
      continue;
    }

    // Since our wallet didn't sign, this is an incoming transaction from an external source (e.g. Pionex)
    // Find how much SOL was transferred to our wallet.
    const accountIndex = tx.transaction.message.accountKeys.findIndex(
      (acc) => acc.pubkey.toBase58() === WALLET_ADDRESS
    );

    if (accountIndex === -1) continue;

    const preBalance = tx.meta.preBalances[accountIndex];
    const postBalance = tx.meta.postBalances[accountIndex];
    const change = postBalance - preBalance;

    if (change > 0) {
      const changeSol = change / 1e9;
      const dateStr = new Date(sigInfo.blockTime * 1000).toISOString();
      console.log(`Deposit transaction: ${sigInfo.signature}`);
      console.log(`  Date/Time: ${dateStr}`);
      console.log(`  Amount: ${changeSol} SOL`);
      totalDeposited += changeSol;
      depositCount++;
      depositsList.push({
        signature: sigInfo.signature,
        timestamp: dateStr,
        amount: changeSol
      });
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`Total External Deposits Found: ${depositCount}`);
  console.log(`Sum of Deposits: ${totalDeposited} SOL`);
  console.log(`JSON Result:`, JSON.stringify(depositsList, null, 2));
}

main().catch(console.error);
