import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import { getSolPriceUsd, setSolPriceUsd } from "../sol-price.js";
import { getCachedSymbol, getJupiterPrices } from "./pnl.js";
import { callRpc, registerRpcConnection, RPC_CONNECTION_OPTIONS } from "./rpc.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) {
    _connection = new Connection(process.env.RPC_URL, RPC_CONNECTION_OPTIONS);
    registerRpcConnection(_connection, {
      pool: "standard",
      url: process.env.RPC_URL,
      source: "wallet",
    });
  }
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

/** Read only the native SOL balance through the RPC failover pool. */
export async function getSolBalance() {
  const owner = getWallet().publicKey;
  const lamports = await callRpc(
    (conn) => conn.getBalance(owner, "confirmed"),
    { method: "getBalance" },
  );
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Build the wallet portion of the AUM snapshot from standard Solana RPC data
 * and Jupiter prices. Helius Wallet API charges 100 credits per request; this
 * path uses ordinary RPC calls and avoids tying the 3-minute AUM sampler to an
 * expensive product endpoint.
 */
export async function fetchRpcWalletSnapshot(walletAddress) {
  const owner = new PublicKey(walletAddress);
  const [lamports, legacyAccounts, token2022Accounts] = await Promise.all([
    callRpc(
      (conn) => conn.getBalance(owner, "confirmed"),
      { method: "getBalance" },
    ),
    callRpc(
      (conn) => conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
      { method: "getTokenAccountsByOwner" },
    ),
    callRpc(
      (conn) => conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed"),
      { method: "getTokenAccountsByOwner" },
    ),
  ]);

  const tokenAccounts = [...(legacyAccounts?.value || []), ...(token2022Accounts?.value || [])];
  const byMint = new Map();
  let recoverableRentSol = 0;
  for (const { account } of tokenAccounts) {
    recoverableRentSol += (Number(account?.lamports) || 0) / LAMPORTS_PER_SOL;
    const info = account?.data?.parsed?.info;
    const mint = info?.mint;
    const amount = Number(info?.tokenAmount?.uiAmountString ?? info?.tokenAmount?.uiAmount ?? 0);
    if (!mint || !Number.isFinite(amount) || amount <= 0) continue;
    byMint.set(mint, (byMint.get(mint) || 0) + amount);
  }

  const solBalance = (Number(lamports) || 0) / LAMPORTS_PER_SOL;
  // A wrapped-SOL token account is still SOL economically. Merge it with the
  // native balance so it is counted once and excluded from held-token AUM.
  const wrappedSol = byMint.get(config.tokens.SOL) || 0;
  byMint.delete(config.tokens.SOL);

  const pricedMints = [config.tokens.SOL, ...byMint.keys()];
  const prices = await getJupiterPrices(pricedMints);
  const solPrice = Number(prices[config.tokens.SOL]) || getSolPriceUsd() || 0;
  if (solPrice > 0) setSolPriceUsd(solPrice);

  const balances = [{
    mint: config.tokens.SOL,
    symbol: "SOL",
    balance: solBalance + wrappedSol,
    pricePerToken: solPrice,
    usdValue: (solBalance + wrappedSol) * solPrice,
  }];
  for (const [mint, balance] of byMint) {
    const pricePerToken = Number(prices[mint]) || 0;
    balances.push({
      mint,
      symbol: mint === config.tokens.USDC ? "USDC" : (getCachedSymbol(mint) || mint.slice(0, 8)),
      balance,
      pricePerToken,
      usdValue: balance * pricePerToken,
    });
  }

  return {
    balances,
    totalUsdValue: balances.reduce((sum, item) => sum + item.usdValue, 0),
    recoverableRentSol,
  };
}

/** The agent's wallet public key (base58), or null if the key isn't configured. */
export function getWalletAddress() {
  try {
    return getWallet().publicKey.toString();
  } catch {
    return null;
  }
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
 * Get current wallet balances: SOL, USDC, and all SPL tokens using standard
 * Solana RPC account reads, with USD prices supplied by Jupiter.
 */
/**
 * `freshPositions: false` reuses the getMyPositions in-process cache (5-min
 * TTL) instead of forcing an on-chain rescan — used by the piggyback AUM
 * sampler, which runs right after the management cycle has already done a
 * force-fresh fetch (so the cache is seconds old and the rescan would be
 * pure duplicate RPC load).
 */
export async function getWalletBalances({ freshPositions = true } = {}) {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  // callRpc already performs endpoint failover and bounded retries. Retrying
  // this whole multi-call snapshot would amplify provider load on failures.
  const maxRetries = 1;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const data = await fetchRpcWalletSnapshot(walletAddress);
      const balances = data.balances || [];

      // ─── Find SOL and USDC ────────────────────────────────────
      const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
      const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

      const solBalance = solEntry?.balance || 0;
      const solPrice = solEntry?.pricePerToken || 0;
      const solUsd = solEntry?.usdValue || 0;
      if (solPrice > 0) setSolPriceUsd(solPrice); // feed the shared display-price cache
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
      let unclaimedFeesSol = 0;
      let unclaimedFeesUsd = 0;
      let rentSol = 0;
      let rentUsd = 0;

      // Fallback estimate for DLMM position-account rent, used ONLY if the
      // batched on-chain measurement below fails. The real rent varies with
      // range width (bin count), so a hardcoded constant is never right
      // per-position — we measure it instead (see the getMultipleAccountsInfo
      // block after this loop). This is the last-resort value only.
      const METEORA_DLMM_RENT_SOL_FALLBACK = 0.065;
      const positionPubkeys = [];
      try {
        const { getMyPositions } = await import("./dlmm.js");
        const result = await getMyPositions({ force: freshPositions, silent: true });
        if (result && Array.isArray(result.positions)) {
          for (const p of result.positions) {
            const val = p.total_value_usd || 0;
            const unclaimed = p.unclaimed_fees_usd || 0;

            if (config.management.solMode) {
              // val and unclaimed are in SOL
              deployedSol += val;
              deployedUsd += val * solPrice;
              unclaimedFeesSol += unclaimed;
              unclaimedFeesUsd += unclaimed * solPrice;
            } else {
              // val and unclaimed are in USD
              deployedUsd += val;
              deployedSol += solPrice > 0 ? (val / solPrice) : 0;
              unclaimedFeesUsd += unclaimed;
              unclaimedFeesSol += solPrice > 0 ? (unclaimed / solPrice) : 0;
            }
            if (p.position) positionPubkeys.push(p.position);
          }
        }
      } catch (e) {
        log("wallet_error", `Failed to retrieve deployed positions for AUM: ${e.message}`);
      }

      // Position-account rent (refundable at close). The rent locked in a DLMM
      // position is exactly the lamports balance of its program-owned position
      // account, whose address we already have (p.position). Measure it with one
      // batched read instead of a hardcoded estimate — the old 0.065 constant
      // showed phantom drawdown for wide ranges (real rent ~0.08 SOL). Chunked at
      // 100 (getMultipleAccountsInfo limit). On any failure, fall back to the
      // per-position estimate so this never breaks getWalletBalances.
      if (positionPubkeys.length > 0) {
        try {
          for (let i = 0; i < positionPubkeys.length; i += 100) {
            const chunk = positionPubkeys.slice(i, i + 100).map((pk) => new PublicKey(pk));
            const infos = await callRpc(
              (conn) => conn.getMultipleAccountsInfo(chunk, "confirmed"),
              { method: "getMultipleAccounts", itemCount: chunk.length },
            );
            for (const info of infos) {
              if (info && typeof info.lamports === "number") {
                rentSol += info.lamports / LAMPORTS_PER_SOL;
              } else {
                // Null entry (account not found) — use the fallback estimate.
                rentSol += METEORA_DLMM_RENT_SOL_FALLBACK;
              }
            }
          }
        } catch (e) {
          log("wallet_warn", `Failed to measure position rent; using estimate: ${e.message}`);
          rentSol = positionPubkeys.length * METEORA_DLMM_RENT_SOL_FALLBACK;
        }
        rentUsd = rentSol * solPrice;
      }

      // Recoverable rent locked in the wallet's token accounts (one ATA per
      // position's base token, ~0.002 SOL each). It's our SOL — just held in
      // separate accounts that getBalance() doesn't see — so counting it keeps
      // AUM flat across open/close instead of dipping when an ATA is created or
      // stranded empty. (Part A reclaims it; this keeps the graph honest meanwhile.)
      let recoverableRentSol = 0;
      try {
        recoverableRentSol = Number(data.recoverableRentSol) || 0;
      } catch (e) {
        log("wallet_warn", `Failed to read token-account rent for AUM: ${e.message}`);
      }
      const recoverableRentUsd = recoverableRentSol * solPrice;

      // Held SPL tokens sitting idle in the wallet (e.g. a base token left
      // unsold by the exit-swap price-impact guard or held back by the dust
      // sweeper). Helius's whole-wallet `data.totalUsdValue` already includes
      // these — but `totalSol` had no equivalent term, so any held token was
      // counted in total_usd and silently dropped from total_sol. Build the
      // list excluding the SOL/wrapped-SOL entry by MINT identity (never by
      // array index — Helius doesn't guarantee ordering) and dust/zero
      // balances. USDC is kept — it's a real asset with the same omission.
      let heldTokensUsd = 0;
      let heldTokensSol = 0;
      let heldTokens = [];
      try {
        const solMint = solEntry?.mint ?? config.tokens.SOL;
        heldTokens = balances
          .filter((b) => {
            const isSol = b.mint === config.tokens.SOL || b.mint === solMint || b.symbol === "SOL";
            if (isSol) return false;
            const bal = Number(b.balance) || 0;
            return bal > 0;
          })
          .map((b) => ({
            mint: b.mint,
            symbol: b.symbol || (b.mint ? b.mint.slice(0, 8) : "?"),
            balance: b.balance,
            usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : 0,
          }));
        heldTokensUsd = heldTokens.reduce((s, t) => s + (t.usd || 0), 0);
        heldTokensSol = solPrice > 0 ? heldTokensUsd / solPrice : 0;
      } catch (e) {
        log("wallet_warn", `Failed to compute held-token AUM component: ${e.message}`);
        heldTokensUsd = 0;
        heldTokensSol = 0;
        heldTokens = [];
      }

      const idleSol = solBalance;
      const idleUsd = solUsd;
      // NOTE the asymmetry here is deliberate, not a bug: `data.totalUsdValue`
      // is the whole-wallet RPC/Jupiter USD figure and already includes every held
      // SPL token (that's the bug this fixes for totalSol), so adding
      // heldTokensUsd into totalUsdVal AGAIN would double-count it. Only
      // totalSol needs the new term, because it never had a token component
      // at all.
      const totalSol = idleSol + deployedSol + unclaimedFeesSol + rentSol + recoverableRentSol + heldTokensSol;
      const totalUsdVal = (data.totalUsdValue || 0) + deployedUsd + unclaimedFeesUsd + rentUsd + recoverableRentUsd;

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
          unclaimed_sol: Math.round(unclaimedFeesSol * 1e6) / 1e6,
          unclaimed_usd: Math.round(unclaimedFeesUsd * 100) / 100,
          rent_sol: Math.round(rentSol * 1e6) / 1e6,
          rent_usd: Math.round(rentUsd * 100) / 100,
          recoverable_rent_sol: Math.round(recoverableRentSol * 1e6) / 1e6,
          recoverable_rent_usd: Math.round(recoverableRentUsd * 100) / 100,
          tokens_sol: Math.round(heldTokensSol * 1e6) / 1e6,
          tokens_usd: Math.round(heldTokensUsd * 100) / 100,
          held_tokens: heldTokens,
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

/**
 * Fetch a Jupiter Swap V2 order as a read-only quote (no sign, no execute).
 * Same endpoint/params as swapToken so the quoted outAmount reflects what the
 * real swap would deliver (referral fee included). Used by the exit-swap
 * price-impact guard and the close-efficiency gate. Throws on any API failure —
 * callers fail-open. `amount` is in UI units (decimals resolved on-chain for
 * non-SOL inputs); pass `amount_raw` (smallest units, e.g. a prior quote's
 * out_amount) instead to skip the decimals lookup entirely.
 *
 * `skip_taker` omits the taker param — REQUIRED for hypothetical quotes on a
 * token we don't currently hold, because with a taker Jupiter validates that
 * wallet's input balance and returns "Insufficient funds" instead of a price
 * (this silently killed every close-efficiency round-trip probe 2026-07-22..25:
 * its sell leg quotes a base token the wallet only receives AFTER the close).
 * The quote is otherwise equivalent — measured drift vs. a taker quote is
 * ~0.01% on outAmount. Callers pricing a balance they DO hold (the exit-swap
 * guard) keep the taker so the quote matches the real swap exactly.
 */
export async function getSwapQuote({ input_mint, output_mint, amount, amount_raw, skip_taker = false }) {
  input_mint = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  const wallet = getWallet();
  const connection = getConnection();

  let amountStr;
  if (amount_raw != null) {
    amountStr = Math.floor(Number(amount_raw)).toString();
  } else {
    let decimals = 9;
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();
  }

  const search = new URLSearchParams({
    inputMint: input_mint,
    outputMint: output_mint,
    amount: amountStr,
  });
  if (!skip_taker) search.set("taker", wallet.publicKey.toString());
  const referralParams = getJupiterReferralParams();
  if (referralParams) {
    search.set("referralAccount", referralParams.referralAccount);
    search.set("referralFee", String(referralParams.referralFee));
  }
  const jupiterApiKey = getJupiterApiKey();
  const orderRes = await fetch(`${JUPITER_SWAP_V2_API}/order?${search.toString()}`, {
    headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
  });
  if (!orderRes.ok) {
    throw new Error(`Swap V2 quote failed: ${orderRes.status} ${await orderRes.text()}`);
  }
  const order = await orderRes.json();
  if (order.errorCode || order.errorMessage) {
    throw new Error(`Swap V2 quote error: ${order.errorMessage || order.errorCode}`);
  }
  return {
    in_amount: order.inAmount != null ? Number(order.inAmount) : null,
    out_amount: order.outAmount != null ? Number(order.outAmount) : null, // smallest units of output mint
    price_impact_pct: order.priceImpactPct != null ? Number(order.priceImpactPct) : null,
  };
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
  // Optional fixed slippage cap in basis points. When finite, sent as
  // `slippageBps` on the /order call — Jupiter docs: "If you pass slippageBps
  // to /order, it overrides RTSE with a fixed value." When null/omitted the
  // order keeps Jupiter's RTSE dynamic slippage (the historical behavior).
  // Callers decide the tier (see swapBaseToSolWithRetry in executor.js);
  // this function is mechanism-only.
  slippage_bps = null,
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
    if (Number.isFinite(slippage_bps) && slippage_bps > 0) {
      search.set("slippageBps", String(Math.round(slippage_bps)));
    }
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

    // Look up the actual swap gas fee, retrying (tx often not yet queryable
    // in the moment right after confirmation — see fetchTxFeeLamports).
    let swap_gas_lamports = 5000;
    try {
      const conn = new Connection(process.env.RPC_URL, RPC_CONNECTION_OPTIONS);
      registerRpcConnection(conn, {
        pool: "standard",
        url: process.env.RPC_URL,
        source: "wallet-swap",
      });
      const { fetchTxFeeLamports } = await import("./dlmm.js");
      swap_gas_lamports = await fetchTxFeeLamports(conn, result.signature);
    } catch (_) { /* use default */ }

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
      gas_cost_sol: swap_gas_lamports / 1e9,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}

const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const WITHDRAWAL_MIN_LAMPORTS = 10_000_000; // 0.01 SOL floor (matches deposit dust filter)

/**
 * Classify a self-signed parsed transaction as a manual wallet WITHDRAWAL.
 *
 * Deliberately conservative so bot operations can NEVER be misread as a
 * withdrawal: deploys/closes/claims/swaps always carry DLMM/Jupiter/Token
 * program instructions, while a manual Phantom send is a pure System transfer.
 * A tx qualifies iff ALL of:
 *   (a) every non-ComputeBudget instruction is a System Program instruction,
 *   (b) it has >=1 parsed System `transfer`/`transferWithSeed` whose
 *       info.source === wallet and info.destination !== wallet,
 *   (c) summed outgoing lamports >= 0.01 SOL.
 *
 * Pure function (no I/O) — unit-testable in isolation.
 * @returns {{ isWithdrawal: boolean, amount: number }} amount in SOL.
 */
export function classifyWithdrawal(parsedTx, walletStr) {
  const NOT = { isWithdrawal: false, amount: 0 };
  const instructions = parsedTx?.transaction?.message?.instructions;
  if (!Array.isArray(instructions) || instructions.length === 0) return NOT;

  let lamports = 0;
  let hasOutgoing = false;

  for (const ix of instructions) {
    const programId = ix?.programId?.toString?.() ?? ix?.programId ?? null;
    const program = ix?.program ?? null;

    // ComputeBudget instructions are ignorable (fee/CU config only)
    if (program === "computeBudget" || programId === COMPUTE_BUDGET_PROGRAM_ID) continue;

    // (a) any non-System, non-ComputeBudget instruction disqualifies the tx
    const isSystem = program === "system" || programId === SYSTEM_PROGRAM_ID;
    if (!isSystem) return NOT;

    // (b) accumulate outgoing System transfers away from our wallet
    const type = ix?.parsed?.type;
    if (type === "transfer" || type === "transferWithSeed") {
      const info = ix.parsed.info || {};
      if (info.source === walletStr && info.destination !== walletStr) {
        const l = Number(info.lamports);
        if (Number.isFinite(l) && l > 0) {
          lamports += l;
          hasOutgoing = true;
        }
      }
    }
  }

  // (c) require an outgoing transfer clearing the dust floor
  if (!hasOutgoing || lamports < WITHDRAWAL_MIN_LAMPORTS) return NOT;
  return { isWithdrawal: true, amount: lamports / 1e9 };
}

/**
 * Programmatically calculate baseline capital by scanning on-chain transfers.
 * Records external DEPOSITS (non-signer positive balance changes) and manual
 * WITHDRAWALS (conservatively-classified self-signed System sends). Bot
 * operations (deploys/closes/claims/swaps) are ignored by classifyWithdrawal.
 *
 * @param {{ fullRescan?: boolean }} [opts] - fullRescan ignores the
 *   last_signature checkpoint and rescans the full 1000-signature window
 *   (used for the one-time withdrawal backfill; recording is idempotent).
 */
export async function getBaselineDeposits({ fullRescan = false } = {}) {
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

    // Backfill new fields on old baselines
    baseline.deposits ??= [];
    baseline.total_deposited ??= 0;
    baseline.withdrawals ??= [];
    baseline.total_withdrawn ??= 0;

    // Build dedupe sets ONCE (not per-tx) — required for idempotent full rescan
    const seenDeposits = new Set(baseline.deposits.map(d => d.signature));
    const seenWithdrawals = new Set(baseline.withdrawals.map(w => w.signature));

    const fetchOpts = { limit: 1000 };
    if (!fullRescan && baseline.last_signature) {
      fetchOpts.until = baseline.last_signature;
    }

    const signatures = await callRpc(
      (conn) => conn.getSignaturesForAddress(walletAddress, fetchOpts),
      { method: "getSignaturesForAddress", itemCount: fetchOpts.limit },
    );

    if (signatures.length > 0) {
      // Process new signatures oldest to newest
      const sortedSignatures = [...signatures].reverse();

      for (const sigInfo of sortedSignatures) {
        // Add a 150ms delay between calls to respect Helius free-tier rate limits (10 RPS)
        await new Promise(resolve => setTimeout(resolve, 150));

        const tx = await callRpc(
          (conn) => conn.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
          }),
          { method: "getTransaction" },
        );

        if (!tx) continue;

        // Check if the wallet is a signer (trades, claims, and manual sends)
        const isSigner = tx.transaction.message.accountKeys.some(
          (acc) => acc.pubkey.toBase58() === walletStr && acc.signer
        );

        if (isSigner) {
          // Signer tx: candidate for a MANUAL WITHDRAWAL (conservative classifier
          // rejects any tx carrying DLMM/Jupiter/Token instructions).
          if (seenWithdrawals.has(sigInfo.signature)) continue;
          const { isWithdrawal, amount } = classifyWithdrawal(tx, walletStr);
          if (isWithdrawal) {
            baseline.withdrawals.push({
              signature: sigInfo.signature,
              timestamp: new Date(sigInfo.blockTime * 1000).toISOString(),
              amount
            });
            baseline.total_withdrawn += amount;
            seenWithdrawals.add(sigInfo.signature);
          }
          continue;
        }

        // Non-signer tx: candidate for an external DEPOSIT
        if (seenDeposits.has(sigInfo.signature)) continue;

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
          seenDeposits.add(sigInfo.signature);
        }
      }

      // Save the newest signature as the last_signature cache checkpoint
      baseline.last_signature = signatures[0].signature;
      baseline.total_deposited = Math.round(baseline.total_deposited * 1e6) / 1e6;
      baseline.total_withdrawn = Math.round(baseline.total_withdrawn * 1e6) / 1e6;
      saveBaselineState(baseline);
    }

    return {
      wallet: walletStr,
      total_deposited: baseline.total_deposited,
      deposit_count: baseline.deposits.length,
      deposits: baseline.deposits,
      total_withdrawn: baseline.total_withdrawn,
      withdrawals: baseline.withdrawals
    };
  } catch (err) {
    return { error: "Failed to calculate baseline: " + err.message };
  }
}

/**
 * Close an empty Associated Token Account (ATA) to reclaim 0.002 SOL rent.
 * Skip native or wrapped SOL accounts.
 */
export async function closeEmptyTokenAccount(mintAddress) {
  const mintStr = normalizeMint(mintAddress);
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (mintStr === SOL_MINT) {
    return { success: false, reason: "Skipped native/wrapped SOL" };
  }

  try {
    const wallet = getWallet();
    const conn = getConnection();
    const mint = new PublicKey(mintStr);

    // Token-2022 mints (most pump.fun tokens) derive their ATA under a
    // different program id than the classic SPL token program — get it
    // wrong and the lookup just hits a nonexistent address. Read the
    // mint's owning program to pick the right one; fall back to classic
    // if the mint account can't be fetched.
    let programId = TOKEN_PROGRAM_ID;
    try {
      const mintInfo = await conn.getAccountInfo(mint);
      if (mintInfo?.owner?.equals(TOKEN_2022_PROGRAM_ID)) {
        programId = TOKEN_2022_PROGRAM_ID;
      }
    } catch (e) {
      log("wallet_warn", `Failed to read mint owner for ${mintStr}, assuming classic token program: ${e.message}`);
    }

    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey, false, programId);

    // Verify account exists and balance is 0
    const balanceInfo = await conn.getTokenAccountBalance(ata).catch(() => null);
    if (!balanceInfo) {
      return { success: false, reason: "Account does not exist" };
    }

    const balance = parseFloat(balanceInfo.value.amount);
    if (balance > 0) {
      log("wallet", `Token account ${ata.toString()} still has balance ${balance}, skipping close`);
      return { success: false, reason: "Account has non-zero balance" };
    }

    log("wallet", `Closing empty token account ${ata.toString()} for mint ${mintStr}`);
    const ix = createCloseAccountInstruction(
      ata,
      wallet.publicKey, // destination for reclaimed rent
      wallet.publicKey, // owner authority
      [],
      programId
    );

    const tx = new Transaction().add(ix);
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signature = await conn.sendTransaction(tx, [wallet]);
    await conn.confirmTransaction(signature, "confirmed");

    log("wallet", `Successfully closed empty token account. Tx: ${signature}`);
    return { success: true, tx: signature };
  } catch (e) {
    log("wallet_error", `Failed to close empty token account: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * List empty (balance-0) token accounts across both the classic and
 * Token-2022 programs. Read-only — used by janitor passes that decide
 * per-mint whether/how to reclaim rent (e.g. sweepWalletDust's ATA janitor).
 */
export async function listEmptyTokenAccounts() {
  const wallet = getWallet();
  const conn = getConnection();
  const owner = wallet.publicKey;

  const empties = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await conn.getParsedTokenAccountsByOwner(owner, { programId });
    for (const { pubkey, account } of res.value) {
      const amt = account.data.parsed.info.tokenAmount;
      if (amt.amount === "0" || amt.uiAmount === 0) {
        empties.push({
          mint: account.data.parsed.info.mint,
          ata: pubkey.toString(),
          lamports: account.lamports,
        });
      }
    }
  }
  return empties;
}

/**
 * Sweep ALL empty (balance-0) token accounts on the wallet, batch-closing them in
 * one tx to reclaim their rent (~0.002 SOL each). Catch-all for ATAs the
 * post-close reclaim misses (dust-skipped swaps, skip_swap, failures, historical).
 * Handles both Token and Token-2022 programs. DRY_RUN-aware. Sends via RPC_URL
 * (rebate-eligible). Caps per run to keep the tx within size limits.
 */
export async function sweepEmptyTokenAccounts({ max = 25 } = {}) {
  const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  try {
    const wallet = getWallet();
    const conn = getConnection();
    const owner = wallet.publicKey;

    const empties = [];
    for (const programId of [TOKEN_PROGRAM, TOKEN_2022]) {
      const res = await conn.getParsedTokenAccountsByOwner(owner, { programId });
      for (const { pubkey, account } of res.value) {
        const amt = account.data.parsed.info.tokenAmount;
        if (amt.amount === "0" || amt.uiAmount === 0) {
          empties.push({ pubkey, programId, lamports: account.lamports });
        }
      }
    }

    if (empties.length === 0) return { closed: 0, reclaimed_sol: 0, found: 0 };

    const batch = empties.slice(0, max);
    const reclaimedSol = Math.round((batch.reduce((s, e) => s + e.lamports, 0) / LAMPORTS_PER_SOL) * 1e6) / 1e6;

    if (process.env.DRY_RUN === "true") {
      log("wallet", `[DRY_RUN] Would close ${batch.length} empty token account(s), reclaiming ~${reclaimedSol} SOL (${empties.length} found).`);
      return { closed: 0, reclaimed_sol: reclaimedSol, found: empties.length, dry_run: true };
    }

    const tx = new Transaction();
    for (const e of batch) {
      tx.add(createCloseAccountInstruction(e.pubkey, owner, owner, [], e.programId));
    }
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
    const signature = await conn.sendTransaction(tx, [wallet]);
    await conn.confirmTransaction(signature, "confirmed");

    const remaining = empties.length - batch.length;
    log("wallet", `Swept ${batch.length} empty token account(s), reclaimed ~${reclaimedSol} SOL${remaining > 0 ? ` (${remaining} remaining)` : ""}. Tx: ${signature}`);
    return { closed: batch.length, reclaimed_sol: reclaimedSol, found: empties.length, remaining, tx: signature };
  } catch (e) {
    log("wallet_error", `sweepEmptyTokenAccounts failed: ${e.message}`);
    return { closed: 0, reclaimed_sol: 0, error: e.message };
  }
}
