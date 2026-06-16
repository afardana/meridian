import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_error", "HELIUS_API_KEY not set in .env");
    return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Helius API key missing" };
  }

  const maxRetries = 3;
  let delay = 1000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
      const res = await fetch(url);
      
      if (!res.ok) {
        throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
      }

      const data = await res.json();
      const balances = data.balances || [];

      // ─── Find SOL and USDC ────────────────────────────────────
      const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
      const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

      const solBalance = solEntry?.balance || 0;
      const solPrice = solEntry?.pricePerToken || 0;
      const solUsd = solEntry?.usdValue || 0;
      const usdcBalance = usdcEntry?.balance || 0;

      // ─── Map all tokens ───────────────────────────────────────
      const enrichedTokens = balances.map(b => ({
        mint: b.mint,
        symbol: b.symbol || b.mint.slice(0, 8),
        balance: b.balance,
        usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
      }));

      // ─── Calculate Deployed Value & AUM ───────────────────────
      let deployedSol = 0;
      let deployedUsd = 0;
      try {
        const { getMyPositions } = await import("./dlmm.js");
        const result = await getMyPositions({ force: true, silent: true });
        if (result && Array.isArray(result.positions)) {
          for (const p of result.positions) {
            const val = p.total_value_usd || 0;
            if (config.management.solMode) {
              // val is in SOL
              deployedSol += val;
              deployedUsd += val * solPrice;
            } else {
              // val is in USD
              deployedUsd += val;
              deployedSol += solPrice > 0 ? (val / solPrice) : 0;
            }
          }
        }
      } catch (e) {
        log("wallet_error", `Failed to retrieve deployed positions for AUM: ${e.message}`);
      }

      const idleSol = solBalance;
      const idleUsd = solUsd;
      const totalSol = idleSol + deployedSol;
      const totalUsdVal = (data.totalUsdValue || 0) + deployedUsd;

      return {
        wallet: walletAddress,
        sol: Math.round(solBalance * 1e6) / 1e6,
        sol_price: Math.round(solPrice * 100) / 100,
        sol_usd: Math.round(solUsd * 100) / 100,
        usdc: Math.round(usdcBalance * 100) / 100,
        tokens: enrichedTokens,
        aum: {
          idle_sol: Math.round(idleSol * 1e6) / 1e6,
          idle_usd: Math.round(idleUsd * 100) / 100,
          deployed_sol: Math.round(deployedSol * 1e6) / 1e6,
          deployed_usd: Math.round(deployedUsd * 100) / 100,
          total_sol: Math.round(totalSol * 1e6) / 1e6,
          total_usd: Math.round(totalUsdVal * 100) / 100,
        },
        total_usd: Math.round(totalUsdVal * 100) / 100,
      };
    } catch (error) {
      log("wallet_error", `Attempt ${attempt}/${maxRetries} failed: ${error.message}`);
      if (attempt === maxRetries) {
        return {
          wallet: walletAddress,
          sol: 0,
          sol_price: 0,
          sol_usd: 0,
          usdc: 0,
          tokens: [],
          total_usd: 0,
          error: error.message,
        };
      }
      await new Promise(r => setTimeout(r, delay));
      delay *= 2.5;
    }
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Programmatically calculate baseline capital by scanning on-chain deposits.
 * Excludes self-signed transactions (operations) and micro-dust spam transfers.
 */
export async function getBaselineDeposits() {
  let connection, walletAddress;
  try {
    connection = getConnection();
    walletAddress = getWallet().publicKey;
  } catch (err) {
    return { error: "Wallet or Connection not configured: " + err.message };
  }

  const walletStr = walletAddress.toString();
  try {
    const { getBaselineState, saveBaselineState } = await import("../state.js");
    const { callRpc } = await import("./rpc.js");
    const baseline = getBaselineState();

    const fetchOpts = { limit: 1000 };
    if (baseline.last_signature) {
      fetchOpts.until = baseline.last_signature;
    }

    const signatures = await callRpc(conn => conn.getSignaturesForAddress(walletAddress, fetchOpts));

    if (signatures.length > 0) {
      // Process new signatures oldest to newest
      const sortedSignatures = [...signatures].reverse();

      for (const sigInfo of sortedSignatures) {
        // Add a 150ms delay between calls to respect Helius free-tier rate limits (10 RPS)
        await new Promise(resolve => setTimeout(resolve, 150));

        const tx = await callRpc(conn => conn.getParsedTransaction(sigInfo.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed"
        }));

        if (!tx) continue;

        // Check if the wallet is a signer (skip trades, claims, etc.)
        const isSigner = tx.transaction.message.accountKeys.some(
          (acc) => acc.pubkey.toBase58() === walletStr && acc.signer
        );
        if (isSigner) continue;

        // Find balance change for our wallet
        const accountIndex = tx.transaction.message.accountKeys.findIndex(
          (acc) => acc.pubkey.toBase58() === walletStr
        );
        if (accountIndex === -1) continue;

        const pre = tx.meta.preBalances[accountIndex];
        const post = tx.meta.postBalances[accountIndex];
        const change = post - pre;

        // Filter out micro-spam transfers (< 0.01 SOL)
        if (change > 10000000) {
          const changeSol = change / 1e9;
          baseline.deposits.push({
            signature: sigInfo.signature,
            timestamp: new Date(sigInfo.blockTime * 1000).toISOString(),
            amount: changeSol
          });
          baseline.total_deposited += changeSol;
        }
      }

      // Save the newest signature as the last_signature cache checkpoint
      baseline.last_signature = signatures[0].signature;
      baseline.total_deposited = Math.round(baseline.total_deposited * 1e6) / 1e6;
      saveBaselineState(baseline);
    }

    return {
      wallet: walletStr,
      total_deposited: baseline.total_deposited,
      deposit_count: baseline.deposits.length,
      deposits: baseline.deposits
    };
  } catch (err) {
    return { error: "Failed to calculate baseline: " + err.message };
  }
}

