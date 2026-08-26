import { Connection, PublicKey } from "@solana/web3.js";
import { unpackMint } from "@solana/spl-token";
import { config } from "../config.js";
import { log } from "../logger.js";
import {
  getTrackedPosition,
  getTrackedPositions,
  markOutOfRange,
  markInRange,
  minutesOutOfRange,
} from "../state.js";
import { callRpc, callRpcMethod, maskUrl, RPC_CONNECTION_OPTIONS } from "./rpc.js";

// ─── Public-infra PnL engine ───────────────────────────────────
// Live position value (current liquidity + claimable fees) is read ON-CHAIN
// via the Meteora DLMM SDK on a public RPC (pump.helius). Deposit history
// (cost basis, withdrawals, claimed fees) comes ONLY from the Meteora /pnl
// API — its precomputed live pnl/balances are intentionally ignored. Token
// USD prices come from Jupiter. No LPAgent / agentmeridian dependency, so the
// poller can run aggressively on fully public resources.

const JUP_SEARCH = "https://datapi.jup.ag/v1/assets/search";
const METEORA_PNL = "https://dlmm.datapi.meteora.ag/positions";

// Lazy SDK load — mirrors tools/dlmm.js (CJS dir-imports break in ESM at import time).
let _DLMM = null;
let _DLMMModule = null;
async function loadDlmmModule() {
  if (!_DLMMModule) _DLMMModule = await import("@meteora-ag/dlmm");
  return _DLMMModule;
}

const _pnlConnections = new Map();

function getPnlRpcUrls() {
  return unique([
    config.pnl.rpcUrl,
    process.env.PNL_RPC_URL_ALT,
    process.env.PNL_RPC_URL,
    process.env.PNL_RPC_URL_FALLBACK,
    "https://pump.helius-rpc.com",
  ]);
}

function getConnectionForUrl(url) {
  if (!_pnlConnections.has(url)) {
    _pnlConnections.set(url, new Connection(url, RPC_CONNECTION_OPTIONS));
  }
  return _pnlConnections.get(url);
}

/**
 * Return the preferred PnL RPC connection without doing network I/O.
 * Call getPnlConnectionWithFailover() when the connection must be health-checked.
 */
export function getPnlConnection() {
  const [primaryUrl] = getPnlRpcUrls();
  return getConnectionForUrl(primaryUrl);
}

/**
 * Select a healthy PnL RPC endpoint for the WebSocket monitor. The PnL poller
 * itself uses the shared HTTP failover pool; this covers the separate long-lived
 * Connection used for low-latency account subscriptions.
 */
export async function getPnlConnectionWithFailover() {
  let lastError = null;
  for (const [index, url] of getPnlRpcUrls().entries()) {
    const connection = getConnectionForUrl(url);
    try {
      await connection.getSlot("confirmed");
      log("pnl_rpc", `${index === 0 ? "Primary" : `Fallback ${index}`} PnL RPC ready: ${maskUrl(url)}`);
      return connection;
    } catch (err) {
      lastError = err;
      const message = String(err?.message || err).replace(/https?:\/\/\S+/g, "[endpoint]").slice(0, 180);
      log("pnl_rpc_failover", `${maskUrl(url)}: ${message}`);
    }
  }
  throw new Error(`All PnL RPC endpoints failed. Last error: ${lastError?.message || "unknown"}`);
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function maybeNum(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}
function round(value, decimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
function unique(arr) {
  return [...new Set(arr.filter(Boolean))];
}

// ─── Meteora /pnl per pool (deposit history) ────────────────────
// Exported because tools/dlmm.js (getPositionPnl + the Meteora fallback path)
// also reads it.
export async function fetchDlmmPnlForPool(poolAddress, walletAddress) {
  const url = `${METEORA_PNL}/${poolAddress}/pnl?user=${walletAddress}&status=open&pageSize=100&page=1`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("pnl_api", `HTTP ${res.status} for pool ${poolAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return {};
    }
    const data = await res.json();
    const positions = data.positions || data.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.positionAddress || p.address || p.position;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("pnl_api", `Fetch error for pool ${poolAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Jupiter prices (never cached) ──────────────────────────────
// Symbols, however, are stable — cache them so positions whose tracked
// pool_name is missing still resolve a real ticker instead of "?".
const _symbolByMint = new Map();
export function getCachedSymbol(mint) {
  return mint ? _symbolByMint.get(String(mint).trim()) ?? null : null;
}

export async function getJupiterPrices(mints) {
  const list = unique(mints.map((m) => String(m).trim()));
  if (!list.length) return {};
  try {
    const res = await fetch(`${JUP_SEARCH}?query=${list.join(",")}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Jupiter ${res.status}`);
    const assets = await res.json();
    const out = {};
    for (const a of assets) {
      out[a.id] = maybeNum(a.usdPrice);
      if (a.symbol) _symbolByMint.set(a.id, a.symbol);
    }
    return out;
  } catch (e) {
    log("pnl_price", `Jupiter price fetch failed: ${e.message}`);
    return {};
  }
}

// ─── Deposit-history cache (sig-invalidated + TTL) ──────────────
// Deposits/withdrawals/claimed fees change only on a position tx; feePerTvl24h
// is a slow 24h pool stat. Cache per pool, refetch when any position's latest
// signature changes or the TTL lapses.
const _meteoraCache = new Map(); // pool -> { at, byPosition, sigByPosition }
let _pollCount = 0;

// Fast PnL reads use the position addresses already known to Meridian. A full
// owner/program scan is only needed for manual-position adoption and periodic
// reconciliation; doing that scan on every fast tick was the dominant Helius
// credit consumer and caused account-index overloads.
const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const SYSVAR_CLOCK_PUBKEY = new PublicKey("SysvarC1ock11111111111111111111111111111111");
const RPC_ACCOUNT_BATCH_SIZE = 100;
const FULL_POSITION_DISCOVERY_INTERVAL_MS = 5 * 60_000;
const MAX_POSITION_DISCOVERY_PAGES = 100;
const _positionDiscovery = {
  initialized: false,
  addresses: new Set(),
  lastSlot: null,
  lastFullAt: 0,
  lastResult: null,
};

// The deposit/PnL cache is five minutes, but the old implementation still
// queried one latest signature per position on every fast PnL tick. Keep
// signature invalidation responsive without spending six RPC calls every tick.
let _lastSignatureCheckAt = 0;
const _latestSignatureByPosition = new Map();

function publicKeyMap(keys) {
  const out = new Map();
  for (const key of keys || []) {
    if (!key) continue;
    const pubkey = key instanceof PublicKey ? key : new PublicKey(key);
    out.set(pubkey.toBase58(), pubkey);
  }
  return out;
}

async function fetchMultipleAccountInfos(keys) {
  const uniqueKeys = [...publicKeyMap(keys).values()];
  if (uniqueKeys.length === 0) return [];

  const infos = [];
  // Sequential chunks keep a large position book from creating another burst
  // while still using getMultipleAccounts for the normal six-position case.
  for (let i = 0; i < uniqueKeys.length; i += RPC_ACCOUNT_BATCH_SIZE) {
    const chunk = uniqueKeys.slice(i, i + RPC_ACCOUNT_BATCH_SIZE);
    const result = await callRpc((connection) => connection.getMultipleAccountsInfo(chunk, "confirmed"));
    infos.push(...result);
  }
  return infos;
}

function accountInfoMap(keys, infos) {
  const map = new Map();
  const uniqueKeys = [...publicKeyMap(keys).values()];
  for (let i = 0; i < uniqueKeys.length; i++) {
    if (infos[i]) map.set(uniqueKeys[i].toBase58(), infos[i]);
  }
  return map;
}

function extractProgramAccountsV2Page(result) {
  // withContext=true nests the page under result.value; without it the page is
  // returned directly. Accept both shapes so a provider-side compatibility
  // proxy cannot silently turn a discovery result into an empty set.
  const page = result?.value ?? result ?? {};
  return {
    accounts: Array.isArray(page.accounts) ? page.accounts : [],
    paginationKey: page.paginationKey ?? null,
    slot: result?.context?.slot ?? page.context?.slot ?? null,
  };
}

async function discoverPositionAddresses(walletAddress) {
  const now = Date.now();
  const full = !_positionDiscovery.initialized
    || (now - _positionDiscovery.lastFullAt) >= FULL_POSITION_DISCOVERY_INTERVAL_MS;
  const { positionV2Filter, positionOwnerFilter } = await loadDlmmModule();
  const baseParams = {
    encoding: "base64",
    commitment: "confirmed",
    filters: [positionV2Filter(), positionOwnerFilter(new PublicKey(walletAddress))],
    dataSlice: { offset: 0, length: 0 },
    limit: 1000,
    withContext: true,
  };
  if (!full && _positionDiscovery.lastSlot != null) {
    baseParams.changedSinceSlot = _positionDiscovery.lastSlot;
  }

  const pageAddresses = new Set();
  let paginationKey = null;
  let latestSlot = _positionDiscovery.lastSlot;
  let pageCount = 0;
  do {
    const params = paginationKey ? { ...baseParams, paginationKey } : baseParams;
    const result = await callRpcMethod("getProgramAccountsV2", [DLMM_PROGRAM_ID.toBase58(), params]);
    const page = extractProgramAccountsV2Page(result);
    for (const account of page.accounts) {
      if (account?.pubkey) pageAddresses.add(String(account.pubkey));
    }
    if (Number.isFinite(Number(page.slot))) latestSlot = Number(page.slot);
    paginationKey = page.paginationKey;
    pageCount++;
    if (pageCount > MAX_POSITION_DISCOVERY_PAGES) {
      throw new Error(`getProgramAccountsV2 exceeded ${MAX_POSITION_DISCOVERY_PAGES} pages`);
    }
  } while (paginationKey);

  const previous = _positionDiscovery.addresses;
  const next = full ? pageAddresses : new Set([...previous, ...pageAddresses]);
  const added = [...next].filter((address) => !previous.has(address));
  const removed = full ? [...previous].filter((address) => !next.has(address)) : [];

  _positionDiscovery.initialized = true;
  _positionDiscovery.addresses = next;
  if (full) _positionDiscovery.lastFullAt = now;
  if (latestSlot != null) _positionDiscovery.lastSlot = latestSlot;

  return {
    full,
    added,
    removed,
    changed: full || added.length > 0 || pageAddresses.size > 0,
    addresses: [...next],
  };
}

async function buildPositionMapFromAccounts(positionAddresses) {
  const addresses = [...publicKeyMap(positionAddresses).values()];
  if (addresses.length === 0) return new Map();

  const mod = await loadDlmmModule();
  if (!_DLMM) _DLMM = mod.default;
  const {
    ClockLayout,
    createProgram,
    decodeAccount,
    wrapPosition,
  } = mod;
  const decodeConnection = getPnlConnection();
  const program = createProgram(decodeConnection);

  // 1) Read only the known position accounts. This replaces the expensive
  // owner-wide getProgramAccounts call in the fast PnL path.
  const positionInfos = await fetchMultipleAccountInfos(addresses);
  const positionInfoByAddress = accountInfoMap(addresses, positionInfos);
  const wrappers = [];
  for (const address of addresses) {
    const accountInfo = positionInfoByAddress.get(address.toBase58());
    if (!accountInfo) continue; // closed between ticks
    try {
      wrappers.push({ address, wrapper: wrapPosition(program, address, accountInfo) });
    } catch (error) {
      log("pnl_warn", `Skipping undecodable position ${address.toBase58().slice(0, 8)}: ${error.message}`);
    }
  }
  if (wrappers.length === 0) return new Map();

  // 2) Fetch the pool accounts and clock in one standard batched read.
  const poolKeys = [...publicKeyMap(wrappers.map(({ wrapper }) => wrapper.lbPair())).values()];
  const poolReadKeys = [SYSVAR_CLOCK_PUBKEY, ...poolKeys];
  const poolInfos = await fetchMultipleAccountInfos(poolReadKeys);
  const poolInfoByKey = accountInfoMap(poolReadKeys, poolInfos);
  const clockInfo = poolInfoByKey.get(SYSVAR_CLOCK_PUBKEY.toBase58());
  if (!clockInfo) throw new Error("Clock account unavailable while reading known positions");
  const clock = ClockLayout.decode(clockInfo.data);
  const lbPairByKey = new Map();
  for (const poolKey of poolKeys) {
    const accountInfo = poolInfoByKey.get(poolKey.toBase58());
    if (accountInfo) lbPairByKey.set(poolKey.toBase58(), decodeAccount(program, "lbPair", accountInfo.data));
  }

  // 3) Read all bin arrays needed by the known positions together.
  const binKeysByPosition = new Map();
  const binKeys = [];
  for (const { address, wrapper } of wrappers) {
    const keys = wrapper.getBinArrayKeysCoverage(program.programId);
    binKeysByPosition.set(address.toBase58(), keys);
    binKeys.push(...keys);
  }
  const uniqueBinKeys = [...publicKeyMap(binKeys).values()];
  const binInfos = await fetchMultipleAccountInfos(uniqueBinKeys);
  const binInfoByKey = accountInfoMap(uniqueBinKeys, binInfos);
  const binArrayMap = new Map();
  for (const binKey of uniqueBinKeys) {
    const accountInfo = binInfoByKey.get(binKey.toBase58());
    if (accountInfo) binArrayMap.set(binKey.toBase58(), decodeAccount(program, "binArray", accountInfo.data));
  }

  // 4) Mint metadata is static for a pool, so fetch each unique mint once.
  const mintKeys = [];
  for (const lbPair of lbPairByKey.values()) {
    mintKeys.push(lbPair.tokenXMint, lbPair.tokenYMint);
    for (const reward of lbPair.rewardInfos || []) {
      if (reward?.mint && !reward.mint.equals(PublicKey.default)) mintKeys.push(reward.mint);
    }
  }
  const uniqueMintKeys = [...publicKeyMap(mintKeys).values()];
  const mintInfos = await fetchMultipleAccountInfos(uniqueMintKeys);
  const mintInfoByKey = accountInfoMap(uniqueMintKeys, mintInfos);
  const mintByKey = new Map();
  for (const mintKey of uniqueMintKeys) {
    const accountInfo = mintInfoByKey.get(mintKey.toBase58());
    if (accountInfo) mintByKey.set(mintKey.toBase58(), unpackMint(mintKey, accountInfo, accountInfo.owner));
  }

  const map = new Map();
  for (const { address, wrapper } of wrappers) {
    const poolKey = wrapper.lbPair();
    const poolKeyString = poolKey.toBase58();
    const lbPair = lbPairByKey.get(poolKeyString);
    if (!lbPair) continue;
    const tokenXMint = mintByKey.get(lbPair.tokenXMint.toBase58());
    const tokenYMint = mintByKey.get(lbPair.tokenYMint.toBase58());
    if (!tokenXMint || !tokenYMint) {
      log("pnl_warn", `Skipping ${address.toBase58().slice(0, 8)}: pool mint account unavailable`);
      continue;
    }
    const rewardMints = (lbPair.rewardInfos || []).map((reward) =>
      reward?.mint && !reward.mint.equals(PublicKey.default)
        ? (mintByKey.get(reward.mint.toBase58()) || null)
        : null
    );
    const positionData = await _DLMM.processPosition(
      program,
      lbPair,
      clock,
      wrapper,
      tokenXMint,
      tokenYMint,
      rewardMints[0] || null,
      rewardMints[1] || null,
      new Map((binKeysByPosition.get(address.toBase58()) || [])
        .map((key) => [key.toBase58(), binArrayMap.get(key.toBase58())])
        .filter(([, value]) => value))
    );
    if (!positionData) continue;
    if (!map.has(poolKeyString)) {
      map.set(poolKeyString, {
        publicKey: poolKey,
        lbPair,
        tokenX: { mint: tokenXMint },
        tokenY: { mint: tokenYMint },
        lbPairPositionsData: [],
      });
    }
    map.get(poolKeyString).lbPairPositionsData.push({ publicKey: address, positionData });
  }
  return map;
}

async function getLatestSig(addr) {
  try {
    const sigs = await callRpc(conn => conn.getSignaturesForAddress(new PublicKey(addr), { limit: 1 }));
    return sigs?.[0]?.signature ?? null;
  } catch {
    // Preserve the previous value on a transient RPC failure. Treating an
    // unavailable lookup as a real null signature would invalidate the cache
    // and cause an unnecessary Meteora API fetch on the next tick.
    return undefined;
  }
}

async function getMeteoraData(walletAddress, flat) {
  const ttlMs = Math.max(0, Number(config.pnl.depositCacheTtlSec ?? 300)) * 1000;
  const positionsByPool = new Map();
  for (const f of flat) {
    if (!positionsByPool.has(f.pool)) positionsByPool.set(f.pool, []);
    positionsByPool.get(f.pool).push(f.position);
  }

  const positionAddresses = [...new Set(flat.map((f) => f.position).filter(Boolean))];
  const signatureIntervalMs = Math.max(1, Number(config.pnl.signatureCheckIntervalSec ?? 60)) * 1000;
  const missingSignature = positionAddresses.some((address) => !_latestSignatureByPosition.has(address));
  const signatureRefreshDue = missingSignature || (Date.now() - _lastSignatureCheckAt >= signatureIntervalMs);
  if (signatureRefreshDue && positionAddresses.length > 0) {
    const signatures = await Promise.all(positionAddresses.map(async (address) => [address, await getLatestSig(address)]));
    for (const [address, signature] of signatures) {
      if (signature !== undefined || !_latestSignatureByPosition.has(address)) {
        _latestSignatureByPosition.set(address, signature ?? null);
      }
    }
    _lastSignatureCheckAt = Date.now();
  }

  const byPosition = {};
  await Promise.all([...positionsByPool.entries()].map(async ([pool, positionAddrs]) => {
    const cached = _meteoraCache.get(pool);
    const sigByPosition = {};
    for (const addr of positionAddrs) {
      sigByPosition[addr] = _latestSignatureByPosition.get(addr) ?? null;
    }

    const ageOk = cached && Date.now() - cached.at < ttlMs;
    const sigsMatch = cached && positionAddrs.every((a) => cached.sigByPosition?.[a] === sigByPosition[a]);

    let data;
    if (ageOk && sigsMatch) {
      data = cached.byPosition;
    } else {
      data = await fetchDlmmPnlForPool(pool, walletAddress);
      _meteoraCache.set(pool, { at: Date.now(), byPosition: data, sigByPosition });
    }
    for (const addr of positionAddrs) byPosition[addr] = data[addr] || null;
  }));

  return byPosition;
}

function mapEntries(map) {
  return map instanceof Map ? [...map.entries()] : Object.entries(map || {});
}

// ─── Build the shaped position object (matches getMyPositions output) ──
function buildPosition(f, prices, solUsd, meteora, solMode) {
  const priceX = f.baseMint ? (prices[f.baseMint] ?? 0) : 0;

  const xHuman = safeNum(f.xRaw) / 10 ** f.decX;
  const yHuman = safeNum(f.yRaw) / 10 ** f.decY;
  const balancesUsd = xHuman * priceX + yHuman * (solUsd ?? 0);
  const balancesSol = solUsd ? balancesUsd / solUsd : yHuman;

  const feeXHuman = safeNum(f.feeXRaw) / 10 ** f.decX;
  const feeYHuman = safeNum(f.feeYRaw) / 10 ** f.decY;
  const claimableUsd = feeXHuman * priceX + feeYHuman * (solUsd ?? 0);
  const claimableSol = solUsd ? claimableUsd / solUsd : feeYHuman;

  const tracked = getTrackedPosition(f.position);

  const depositsUsd = safeNum(meteora?.allTimeDeposits?.total?.usd);
  const depositsSol = safeNum(meteora?.allTimeDeposits?.total?.sol);
  const withdrawUsd = safeNum(meteora?.allTimeWithdrawals?.total?.usd);
  const withdrawSol = safeNum(meteora?.allTimeWithdrawals?.total?.sol);

  // Claimed fees: floor the indexer's cumulative total with our own claim ledger
  // (state.recordClaim). Claimable fees above are read ON-CHAIN and zero out the
  // instant a claim lands, but allTimeFees comes from the Meteora indexer, which
  // lags — and the sig-invalidated cache below then pins that stale value for up
  // to depositCacheTtlSec. In that window the fee is in NEITHER term and pnl_pct
  // collapses by the fee %, firing phantom TRAILING_TP / STOP_LOSS / ratchet
  // exits on a position that never moved.
  //
  // max() is safe because both sides measure the SAME cumulative quantity at
  // claim-time valuation, so they converge: ours leads during the lag, the
  // indexer takes over once it catches up. This floor belongs ONLY here, where
  // claimable is fresh and claimed is lagging — the fully-indexed paths in
  // tools/dlmm.js still carry a lagging claim in *their* unclaimed term, so
  // flooring there would double-count it.
  const claimedUsd = Math.max(safeNum(meteora?.allTimeFees?.total?.usd), safeNum(tracked?.total_fees_claimed_true_usd));
  const claimedSol = Math.max(safeNum(meteora?.allTimeFees?.total?.sol), safeNum(tracked?.total_fees_claimed_sol));

  const pnlUsd = balancesUsd + withdrawUsd + claimableUsd + claimedUsd - depositsUsd;
  const pnlSol = balancesSol + withdrawSol + claimableSol + claimedSol - depositsSol;
  const pctUsd = depositsUsd > 0 ? (pnlUsd / depositsUsd) * 100 : 0;
  const pctSol = depositsSol > 0 ? (pnlSol / depositsSol) * 100 : 0;

  const ourPct = solMode ? pctSol : pctUsd;

  // pnl_pct_diff is the gap vs Meteora's precomputed pct — kept ONLY as a logged
  // diagnostic. It is NOT used to gate exits: Meteora's pct comes from the
  // deposit cache (stale up to depositCacheTtlSec) while ourPct is fresh every
  // poll, so on a fast move the gap inflates and would falsely suppress
  // STOP_LOSS / TRAILING_TP exactly when they matter.
  const reportedPct = solMode ? maybeNum(meteora?.pnlSolPctChange) : maybeNum(meteora?.pnlPctChange);
  const pnlPctDiff = reportedPct != null ? Math.abs(ourPct - reportedPct) : null;

  // On-chain amounts are authoritative; a tick is "suspicious" (don't act on it)
  // only when we couldn't price it. Guards against:
  //  - Jupiter outage → solUsd/priceX missing → balances collapse → false STOP_LOSS
  //  - missing Meteora deposits → 0 cost basis → garbage pnl / inflated value
  const holdsTokenX = xHuman > 0 || feeXHuman > 0;
  const priceMissing = !(solUsd > 0) || (holdsTokenX && !!f.baseMint && !(priceX > 0));
  const depositsMissing = (solMode ? depositsSol : depositsUsd) <= 0;
  const pnlPctSuspicious = priceMissing || depositsMissing;
  if (pnlPctSuspicious) {
    log("pnl_warn", `${f.position.slice(0, 8)} suspicious tick — priceMissing=${priceMissing} depositsMissing=${depositsMissing} (solUsd=${solUsd}, priceX=${priceX})`);
  }

  // Per-token USD breakdown (collapsed into totals above — kept here for the UI).
  const liqXUsd = xHuman * priceX;
  const liqYUsd = yHuman * (solUsd ?? 0);
  const feeXUsd = feeXHuman * priceX;
  const feeYUsd = feeYHuman * (solUsd ?? 0);

  // Human price (token Y per token X, e.g. SOL/MEME) derived from bin geometry.
  // Validated against Meteora's reported current_price: price(binId) =
  // (1 + binStep/1e4)^binId * 10^(decX - decY).
  const priceFactor = 10 ** ((f.decX ?? 9) - (f.decY ?? 9));
  const priceOfBin = (binId) =>
    binId == null || f.binStep == null
      ? null
      : Math.pow(1 + f.binStep / 1e4, binId) * priceFactor;

  const inRange = f.active != null && f.lower != null && f.upper != null
    ? f.active >= f.lower && f.active <= f.upper
    : (meteora ? !meteora.isOutOfRange : true);

  if (inRange) markInRange(f.position);
  else markOutOfRange(f.position);

  // Token symbols, resolved through a robust fallback chain so a position with
  // no tracked pool_name never renders as "?/SOL":
  //   tracked pool_name → Meteora API symbol → Jupiter symbol (by mint) → mint prefix.
  // Split on the LAST separator, not every one: a base symbol may itself contain
  // a hyphen ("K-HOME-SOL" is K-HOME over SOL), whereas the quote token is always
  // a single symbol (SOL/USDC). Splitting on all separators and taking the first
  // two fields rendered that pool as "K/HOME" — and because both fields came out
  // truthy, the Meteora/Jupiter fallbacks below never got a chance to correct it.
  // No separator at all → treat the whole name as the base, as before.
  const rawPoolName = tracked?.pool_name ? String(tracked.pool_name).trim() : "";
  const sepIdx = Math.max(rawPoolName.lastIndexOf("/"), rawPoolName.lastIndexOf("-"));
  const nameX = sepIdx > 0 ? rawPoolName.slice(0, sepIdx).trim() : rawPoolName;
  const nameY = sepIdx > 0 ? rawPoolName.slice(sepIdx + 1).trim() : "";
  const symX = nameX || meteora?.tokenX || getCachedSymbol(f.baseMint)
    || (f.baseMint ? `${String(f.baseMint).slice(0, 4)}…` : "?");
  const symY = nameY || meteora?.tokenY || "SOL";
  const pair = tracked?.pool_name || `${symX}-${symY}`;

  const ageFromState = tracked?.deployed_at
    ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
    : null;
  const ageMinutes = meteora?.createdAt ? Math.floor((Date.now() - meteora.createdAt * 1000) / 60000) : ageFromState;

  return {
    position:           f.position,
    pool:               f.pool,
    pair:               pair,
    base_mint:          f.baseMint,
    lower_bin:          f.lower ?? tracked?.bin_range?.min ?? null,
    upper_bin:          f.upper ?? tracked?.bin_range?.max ?? null,
    active_bin:         f.active ?? tracked?.bin_range?.active ?? null,
    in_range:           inRange,
    unclaimed_fees_usd: round(solMode ? claimableSol : claimableUsd),
    unclaimed_fees_true_usd: round(claimableUsd),
    total_value_usd:    round(solMode ? balancesSol : balancesUsd),
    total_value_true_usd: round(balancesUsd),
    collected_fees_usd: round(solMode ? claimedSol : claimedUsd),
    collected_fees_true_usd: round(claimedUsd),
    pnl_usd:            round(solMode ? pnlSol : pnlUsd),
    pnl_true_usd:       round(pnlUsd),
    pnl_pct:            round(ourPct, 2),
    pnl_pct_usd:        round(pctUsd, 2),
    pnl_pct_derived:    round(ourPct, 2),
    pnl_pct_diff:       pnlPctDiff != null ? round(pnlPctDiff, 2) : null,
    pnl_pct_suspicious: !!pnlPctSuspicious,
    fee_per_tvl_24h:    meteora ? Math.round(safeNum(meteora.feePerTvl24h) * 100) / 100 : null,
    age_minutes:        ageMinutes,
    minutes_out_of_range: minutesOutOfRange(f.position),
    instruction:        tracked?.instruction ?? null,

    // ── Exit-stack state for the dashboard card (sparkline + protection chip) ──
    // pnl_tick_history is the TWAP guard's per-poll ring (~45s cadence, cap 20)
    // of SOL-basis pnl_pct values; the effective stop/floor levels are resolved
    // against config HERE so the dashboard never has to know the bot's knobs.
    pnl_ticks: Array.isArray(tracked?.pnl_tick_history)
      ? tracked.pnl_tick_history.slice(-20).map((v) => round(v, 2))
      : [],
    peak_pnl_pct:    tracked?.peak_pnl_pct ?? null,
    ratchet_armed:   !!tracked?.ratchet_armed,
    trailing_active: !!tracked?.trailing_active,
    stop_pct: (tracked?.ratchet_armed && config.management?.profitRatchetEnabled)
      ? (config.management?.profitRatchetStopPct ?? null)
      : (config.management?.stopLossPct ?? null),
    trailing_floor_pct: (tracked?.trailing_active && tracked?.peak_pnl_pct != null
        && config.management?.trailingDropPct != null)
      ? round(tracked.peak_pnl_pct - config.management.trailingDropPct, 2)
      : null,

    // ── Per-token breakdown + prices for the dashboard position card ──
    token_x_symbol: symX,
    token_y_symbol: symY,
    bin_step:       f.binStep ?? null,
    liq_x_amount:   round(xHuman, 6),
    liq_x_usd:      round(liqXUsd, 2),
    liq_y_amount:   round(yHuman, 6),
    liq_y_usd:      round(liqYUsd, 2),
    fee_x_amount:   round(feeXHuman, 6),
    fee_x_usd:      round(feeXUsd, 2),
    fee_y_amount:   round(feeYHuman, 6),
    fee_y_usd:      round(feeYUsd, 2),
    price_lower:    priceOfBin(f.lower),
    price_upper:    priceOfBin(f.upper),
    price_active:   priceOfBin(f.active),

    // Per-bin liquidity histogram for the dashboard's Meteora-style bar chart.
    // v is each bin's LIQUIDITY valued at the BIN's own price (x·P_bin + y, in
    // token-Y units — the DLMM constant-sum invariant), normalized so the
    // tallest bin = 1. Not mark-to-market: valuing converted (X-side) bins at
    // the current market price shrank them by P_now/P_bin and bent a linearly
    // deposited ladder into a curve at the purple end (BULLSHIT 2026-08-22);
    // bin-price valuation shows the deposited shape, which is what Meteora's
    // bin chart draws. Zero-liquidity bins are KEPT (v: 0) so they render as
    // dim stubs instead of vanishing.
    bins: (() => {
      if (!Array.isArray(f.binData) || f.binData.length === 0) return [];
      const withV = f.binData.map(({ b, x, y }) => ({
        b,
        v: x * (priceOfBin(b) ?? 0) + y,
        s: x > 0 && y > 0 ? "xy" : x > 0 ? "x" : "y",
      }));
      const maxV = withV.reduce((m, bv) => Math.max(m, bv.v), 0);
      return withV.map(({ b, v, s }) => ({ b, v: round(maxV > 0 ? v / maxV : 0, 3), s }));
    })(),
  };
}

// ─── Shape a position result from decoded on-chain accounts ────
async function buildPositionsFromMap(walletAddress, map, { countTick = false } = {}) {
  const solMode = !!config.management?.solMode;
  const SOL_MINT = config.tokens.SOL;
  if (countTick) {
    _pollCount++;
    const n = [...mapEntries(map)].reduce((s, [, i]) => s + (i?.lbPairPositionsData?.length ?? 0), 0);
    if (_pollCount % 20 === 1) log("pnl_tick", `poller alive — ${n} position(s) tracked (tick #${_pollCount})`);
  }

  const flat = [];
  for (const [lbPairKey, info] of mapEntries(map)) {
    const decX = info?.tokenX?.mint?.decimals ?? 9;
    const decY = info?.tokenY?.mint?.decimals ?? 9;
    const baseMint = info?.tokenX?.mint?.address?.toString?.() ?? null;
    const active = info?.lbPair?.activeId ?? null;
    const binStep = info?.lbPair?.binStep ?? null;
    for (const p of info?.lbPairPositionsData || []) {
      const d = p.positionData || {};
      flat.push({
        position: p.publicKey.toString(),
        pool: lbPairKey,
        baseMint,
        decX,
        decY,
        binStep,
        active,
        lower: d.lowerBinId ?? null,
        upper: d.upperBinId ?? null,
        xRaw: d.totalXAmount,
        yRaw: d.totalYAmount,
        feeXRaw: d.feeX?.toString?.() ?? d.feeX ?? 0,
        feeYRaw: d.feeY?.toString?.() ?? d.feeY ?? 0,
        // Per-bin liquidity breakdown (raw-unit strings from the SDK), capped at
        // 160 bins — above the max configured range width — so the flat item
        // stays bounded regardless of how wide a position gets deployed.
        binData: Array.isArray(d.positionBinData)
          ? d.positionBinData.slice(0, 160).map((bd) => ({
              b: bd.binId,
              x: (Number(bd.positionXAmount) / 10 ** decX) || 0,
              y: (Number(bd.positionYAmount) / 10 ** decY) || 0,
            }))
          : [],
      });
    }
  }

  if (flat.length === 0) {
    return { wallet: walletAddress, total_positions: 0, positions: [], source: "rpc" };
  }

  const [prices, meteoraByPosition] = await Promise.all([
    getJupiterPrices([SOL_MINT, ...flat.map((f) => f.baseMint)]),
    getMeteoraData(walletAddress, flat),
  ]);
  const solUsd = prices[SOL_MINT] ?? null;

  const positions = flat.map((f) => buildPosition(f, prices, solUsd, meteoraByPosition[f.position], solMode));

  return { wallet: walletAddress, total_positions: positions.length, positions, source: "rpc" };
}

// ─── Main entry: compute positions from public infra ────────────
// Fast ticks read known position accounts only. Discovery/adoption calls the
// paginated Helius V2 method on its own slower cadence.
export async function computePositions(walletAddress, { discovery = false } = {}) {
  if (discovery) {
    const scan = await discoverPositionAddresses(walletAddress);
    const shouldRebuild = scan.full
      || scan.added.length > 0
      || scan.removed.length > 0
      || !_positionDiscovery.lastResult;

    if (!shouldRebuild && _positionDiscovery.lastResult) {
      return {
        ..._positionDiscovery.lastResult,
        discovery_changed: scan.changed,
        discovery_added: scan.added,
        discovery_removed: scan.removed,
      };
    }

    const map = await buildPositionMapFromAccounts(scan.addresses);
    const result = await buildPositionsFromMap(walletAddress, map);
    _positionDiscovery.lastResult = result;
    return {
      ...result,
      discovery_changed: scan.changed,
      discovery_added: scan.added,
      discovery_removed: scan.removed,
    };
  }

  const tracked = getTrackedPositions(true)
    .filter((position) => position?.position)
    .map((position) => position.position);
  if (tracked.length === 0) {
    return { wallet: walletAddress, total_positions: 0, positions: [], source: "rpc" };
  }

  const map = await buildPositionMapFromAccounts(tracked);
  return buildPositionsFromMap(walletAddress, map, { countTick: true });
}
