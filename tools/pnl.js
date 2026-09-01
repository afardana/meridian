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
  recordPositionValuationState,
} from "../state.js";
import {
  callRpc,
  callRpcMethod,
  maskUrl,
  registerRpcConnection,
  RPC_CONNECTION_OPTIONS,
} from "./rpc.js";

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
    const connection = new Connection(url, RPC_CONNECTION_OPTIONS);
    registerRpcConnection(connection, { pool: "standard", url, source: "pnl" });
    _pnlConnections.set(url, connection);
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
  const list = unique(mints.filter((m) => m != null).map((m) => String(m).trim()));
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

// Mint decimals and Token-2022 transfer-fee metadata are stable/slow-moving
// inputs to processPosition. Cache the decoded metadata across fast ticks, but
// keep a bounded TTL so an authority-side metadata change is eventually seen.
const MINT_METADATA_CACHE_TTL_MS = 60 * 60_000;
const _mintMetadataCache = new Map(); // mint -> { at, metadata }
const MINT_METADATA_CACHE_MAX = 1024;

// Bin-array addresses are deterministic from a position's pool and range. The
// account contents remain live and are always fetched; only this derivation is
// cached so a changed range naturally gets a new dependency set.
const _binCoverageCache = new Map(); // position -> { rangeKey, keys }
const BIN_COVERAGE_CACHE_MAX = 512;

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

// Read-only snapshot for the AUM sampler. Discovery intentionally runs slower
// than the PnL poller, but its latest complete position set is still the best
// signal that a manual deployment has landed before the adoption dwell ends.
// Returning only the timestamp and rows keeps the scheduler decoupled from the
// discovery implementation while avoiding another owner-wide RPC scan.
export function getPositionDiscoverySnapshot() {
  const result = _positionDiscovery.lastResult;
  if (!result) return null;
  return {
    snapshot_at: result.snapshot_at || null,
    positions: Array.isArray(result.positions) ? result.positions : [],
  };
}

// The deposit/PnL cache is five minutes. Signature checks are the fallback for
// external/manual mutations; normal Meridian mutations invalidate the affected
// position immediately through invalidatePositionPnlCache().
let _lastSignatureCheckAt = 0;
const _latestSignatureByPosition = new Map();
const _signatureInvalidated = new Set();
const _directSignatureAt = new Map();

/**
 * Force the deposit-history cache to revalidate a position after an on-chain
 * mutation. The next PnL tick checks only invalidated/missing signatures; the
 * periodic fallback still catches changes made outside Meridian.
 */
export function invalidatePositionPnlCache(positionAddress, {
  poolAddress = null,
  signature = null,
  signatures = [],
} = {}) {
  if (!positionAddress) return;
  const address = String(positionAddress);
  const confirmedSignatures = [
    ...(Array.isArray(signatures) ? signatures : [signatures]),
    signature,
  ].filter((value) => typeof value === "string" && value.length > 0);
  const latestConfirmedSignature = confirmedSignatures.at(-1) || null;
  if (latestConfirmedSignature) {
    // The caller has already waited for confirmation, so the next cache refresh
    // can use this signature directly. This is the common Meridian-originated
    // mutation path and avoids a fan-out getSignaturesForAddress lookup.
    _latestSignatureByPosition.set(address, latestConfirmedSignature);
    _signatureInvalidated.delete(address);
    _directSignatureAt.set(address, Date.now());
  } else {
    _signatureInvalidated.add(address);
    _directSignatureAt.delete(address);
  }
  _binCoverageCache.delete(address);
  if (poolAddress) {
    _meteoraCache.delete(String(poolAddress));
    return;
  }
  for (const [pool, cached] of _meteoraCache.entries()) {
    if (cached?.sigByPosition && Object.prototype.hasOwnProperty.call(cached.sigByPosition, address)) {
      _meteoraCache.delete(pool);
    }
  }
}

export function invalidatePositionsPnlCache(positionAddresses, options = {}) {
  for (const address of positionAddresses || []) {
    invalidatePositionPnlCache(address, options);
  }
}

/**
 * Remove a position from the owner-discovery snapshot after a confirmed close.
 * The incremental getProgramAccountsV2 view cannot report deletions reliably,
 * so retaining the old result can make reconciliation resurrect a closed row
 * until the next full owner scan.
 */
export function invalidatePositionDiscovery(positionAddress) {
  if (!positionAddress) return;
  const address = String(positionAddress);
  _positionDiscovery.addresses.delete(address);
  if (Array.isArray(_positionDiscovery.lastResult?.positions)) {
    const positions = _positionDiscovery.lastResult.positions
      .filter((position) => position?.position !== address);
    _positionDiscovery.lastResult = {
      ..._positionDiscovery.lastResult,
      positions,
      total_positions: positions.length,
    };
  }
}

function publicKeyMap(keys) {
  const out = new Map();
  for (const key of keys || []) {
    if (!key) continue;
    const pubkey = key instanceof PublicKey ? key : new PublicKey(key);
    out.set(pubkey.toBase58(), pubkey);
  }
  return out;
}

async function fetchMultipleAccountInfos(keys, { method = "getMultipleAccounts" } = {}) {
  const uniqueKeys = [...publicKeyMap(keys).values()];
  if (uniqueKeys.length === 0) return [];

  const infos = [];
  // Sequential chunks keep a large position book from creating another burst
  // while still using getMultipleAccounts for the normal six-position case.
  for (let i = 0; i < uniqueKeys.length; i += RPC_ACCOUNT_BATCH_SIZE) {
    const chunk = uniqueKeys.slice(i, i + RPC_ACCOUNT_BATCH_SIZE);
    const result = await callRpc(
      (connection) => connection.getMultipleAccountsInfo(chunk, "confirmed"),
      { method, itemCount: chunk.length },
    );
    infos.push(...result);
  }
  return infos;
}

/**
 * Confirm that a candidate position account still exists at the current RPC
 * commitment. Used immediately before orphan adoption so a discovery snapshot
 * cannot resurrect a position that was closed after the snapshot was built.
 * Returns null on an RPC failure so callers can retry rather than guessing.
 */
export async function isPositionAccountLive(positionAddress) {
  if (!positionAddress) return null;
  try {
    const infos = await fetchMultipleAccountInfos([positionAddress]);
    return infos[0] != null;
  } catch (error) {
    log("pnl_warn", `Position liveness check failed for ${String(positionAddress).slice(0, 8)}: ${error.message}`);
    return null;
  }
}

function accountInfoMap(keys, infos) {
  const map = new Map();
  const uniqueKeys = [...publicKeyMap(keys).values()];
  for (let i = 0; i < uniqueKeys.length; i++) {
    if (infos[i]) map.set(uniqueKeys[i].toBase58(), infos[i]);
  }
  return map;
}

async function fetchMintMetadata(mintKeys) {
  const uniqueMintKeys = [...publicKeyMap(mintKeys).values()];
  const metadataByKey = new Map();
  const missingKeys = [];
  const now = Date.now();

  for (const mintKey of uniqueMintKeys) {
    const key = mintKey.toBase58();
    const cached = _mintMetadataCache.get(key);
    if (cached && now - cached.at < MINT_METADATA_CACHE_TTL_MS) {
      metadataByKey.set(key, cached.metadata);
    } else {
      missingKeys.push(mintKey);
    }
  }

  if (missingKeys.length > 0) {
    const infos = await fetchMultipleAccountInfos(missingKeys, { method: "getMultipleAccounts" });
    const infoByKey = accountInfoMap(missingKeys, infos);
    for (const mintKey of missingKeys) {
      const key = mintKey.toBase58();
      const accountInfo = infoByKey.get(key);
      if (!accountInfo) continue;
      try {
        const metadata = unpackMint(mintKey, accountInfo, accountInfo.owner);
        _mintMetadataCache.set(key, { at: Date.now(), metadata });
        while (_mintMetadataCache.size > MINT_METADATA_CACHE_MAX) {
          _mintMetadataCache.delete(_mintMetadataCache.keys().next().value);
        }
        metadataByKey.set(key, metadata);
      } catch (error) {
        log("pnl_warn", `Could not decode mint metadata for ${key.slice(0, 8)}: ${error.message}`);
        // Preserve the previous outer fallback behavior instead of silently
        // returning an empty RPC portfolio when a required mint is malformed.
        throw error;
      }
    }
  }

  return metadataByKey;
}

function getBinArrayKeysForPosition(address, wrapper, programId) {
  const key = address.toBase58();
  if (typeof wrapper.lowerBinId !== "function" || typeof wrapper.upperBinId !== "function") {
    return wrapper.getBinArrayKeysCoverage(programId);
  }
  const rangeKey = [
    wrapper.lbPair().toBase58(),
    wrapper.lowerBinId().toString(),
    wrapper.upperBinId().toString(),
    programId.toBase58(),
  ].join(":");
  const cached = _binCoverageCache.get(key);
  if (cached?.rangeKey === rangeKey) return cached.keys;

  const keys = wrapper.getBinArrayKeysCoverage(programId);
  _binCoverageCache.set(key, { rangeKey, keys });
  while (_binCoverageCache.size > BIN_COVERAGE_CACHE_MAX) {
    _binCoverageCache.delete(_binCoverageCache.keys().next().value);
  }
  return keys;
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
    const result = await callRpcMethod(
      "getProgramAccountsV2",
      [DLMM_PROGRAM_ID.toBase58(), params],
      { itemCount: params.limit },
    );
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

  // 2) Derive the pool and bin-array dependencies now that position wrappers
  // are decoded. Both sets are read together below. Bin-array addresses depend
  // on the position range, but not on the live lbPair account contents, so
  // there is no correctness reason to put them in a separate RPC round trip.
  const poolKeys = [...publicKeyMap(wrappers.map(({ wrapper }) => wrapper.lbPair())).values()];
  const binKeysByPosition = new Map();
  const binKeys = [];
  for (const { address, wrapper } of wrappers) {
    const keys = getBinArrayKeysForPosition(address, wrapper, program.programId);
    binKeysByPosition.set(address.toBase58(), keys);
    binKeys.push(...keys);
  }
  const uniqueBinKeys = [...publicKeyMap(binKeys).values()];
  const poolAndBinReadKeys = [SYSVAR_CLOCK_PUBKEY, ...poolKeys, ...uniqueBinKeys];
  const poolAndBinInfos = await fetchMultipleAccountInfos(poolAndBinReadKeys);
  const poolAndBinInfoByKey = accountInfoMap(poolAndBinReadKeys, poolAndBinInfos);
  const clockInfo = poolAndBinInfoByKey.get(SYSVAR_CLOCK_PUBKEY.toBase58());
  if (!clockInfo) throw new Error("Clock account unavailable while reading known positions");
  const clock = ClockLayout.decode(clockInfo.data);
  const lbPairByKey = new Map();
  for (const poolKey of poolKeys) {
    const accountInfo = poolAndBinInfoByKey.get(poolKey.toBase58());
    if (accountInfo) lbPairByKey.set(poolKey.toBase58(), decodeAccount(program, "lbPair", accountInfo.data));
  }

  // 3) Decode the bin arrays from the same account batch as the pools.
  const binArrayMap = new Map();
  for (const binKey of uniqueBinKeys) {
    const accountInfo = poolAndBinInfoByKey.get(binKey.toBase58());
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
  const mintByKey = await fetchMintMetadata(mintKeys);

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
    const sigs = await callRpc(
      (conn) => conn.getSignaturesForAddress(new PublicKey(addr), { limit: 1 }),
      { method: "getSignaturesForAddress", itemCount: 1 },
    );
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
  const activePositions = new Set(positionAddresses);
  for (const address of _signatureInvalidated) {
    if (!activePositions.has(address)) _signatureInvalidated.delete(address);
  }
  for (const address of _latestSignatureByPosition.keys()) {
    if (!activePositions.has(address)) _latestSignatureByPosition.delete(address);
  }
  for (const address of _directSignatureAt.keys()) {
    if (!activePositions.has(address)) _directSignatureAt.delete(address);
  }
  const signatureIntervalMs = Math.max(1, Number(config.pnl.signatureCheckIntervalSec ?? 300)) * 1000;
  const periodicRefreshDue = Date.now() - _lastSignatureCheckAt >= signatureIntervalMs;
  const periodicRefreshBaseline = _lastSignatureCheckAt;
  const directSignaturesFreshForPeriodicFallback = new Set(
    positionAddresses.filter((address) => (_directSignatureAt.get(address) || 0) > periodicRefreshBaseline),
  );
  const addressesNeedingRefresh = periodicRefreshDue
    ? positionAddresses.filter((address) => !directSignaturesFreshForPeriodicFallback.has(address))
    : positionAddresses.filter((address) => !_latestSignatureByPosition.has(address) || _signatureInvalidated.has(address));
  if (addressesNeedingRefresh.length > 0) {
    const signatures = await Promise.all(addressesNeedingRefresh.map(async (address) => [address, await getLatestSig(address)]));
    for (const [address, signature] of signatures) {
      if (signature !== undefined || !_latestSignatureByPosition.has(address)) {
        _latestSignatureByPosition.set(address, signature ?? null);
      }
      // A failed event-triggered check is retried by the periodic fallback;
      // retaining the prior signature keeps the deposit cache valid meanwhile.
      _signatureInvalidated.delete(address);
    }
  }
  // Advance the periodic fallback clock even when direct Meridian signatures
  // satisfied this pass and no getSignaturesForAddress lookup was needed. This
  // prevents a fresh direct signature from suppressing external/manual-change
  // detection forever while still avoiding the redundant immediate lookup.
  if (periodicRefreshDue) _lastSignatureCheckAt = Date.now();

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

// ─── Asset-aware position valuation ────────────────────────────
// The bot's normal deployment is token-X/meme + token-Y/SOL, but adopted/manual
// positions can use any pair orientation. Keep this calculation pure so the
// exact incident can be replayed without an RPC or state mutation.
export function calculateAssetAwareValue(f, prices = {}, solUsd, meteora = null, solMode = false, tracked = null) {
  const profile = tracked?.asset_profile || {};
  const tokenXMint = f.tokenXMint || f.baseMint || profile.token_x_mint || null;
  const tokenYMint = f.tokenYMint || profile.token_y_mint || null;
  const priceX = tokenXMint ? (prices[tokenXMint] ?? 0) : 0;
  const priceY = tokenYMint
    ? (prices[tokenYMint] ?? (tokenYMint === config.tokens.SOL ? (solUsd ?? 0) : 0))
    : 0;

  const decX = Number.isFinite(Number(f.decX)) ? Number(f.decX) : (profile.token_x_decimals ?? 9);
  const decY = Number.isFinite(Number(f.decY)) ? Number(f.decY) : (profile.token_y_decimals ?? 9);
  const xHuman = safeNum(f.xRaw) / 10 ** decX;
  const yHuman = safeNum(f.yRaw) / 10 ** decY;
  const balancesUsd = xHuman * priceX + yHuman * priceY;
  const balancesSol = solUsd > 0 ? balancesUsd / solUsd : 0;

  const feeXHuman = safeNum(f.feeXRaw) / 10 ** decX;
  const feeYHuman = safeNum(f.feeYRaw) / 10 ** decY;
  const claimableUsd = feeXHuman * priceX + feeYHuman * priceY;
  const claimableSol = solUsd > 0 ? claimableUsd / solUsd : 0;

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

  const reportedPct = solMode ? maybeNum(meteora?.pnlSolPctChange) : maybeNum(meteora?.pnlPctChange);
  const pnlPctDiff = reportedPct != null ? Math.abs(ourPct - reportedPct) : null;
  const holdsTokenX = xHuman > 0 || feeXHuman > 0;
  const holdsTokenY = yHuman > 0 || feeYHuman > 0;
  const metadataMissing = !tokenXMint || !tokenYMint;
  const priceMissing = !(solUsd > 0)
    || (holdsTokenX && !(priceX > 0))
    || (holdsTokenY && !(priceY > 0));
  const depositsMissing = (solMode ? depositsSol : depositsUsd) <= 0;
  const extremeLimit = Math.max(10, Number(config.management?.pnlExtremeDivergencePct ?? 50));
  const extremeDivergence = pnlPctDiff != null && pnlPctDiff > extremeLimit;
  const quality = metadataMissing
    ? "missing_asset_metadata"
    : priceMissing
      ? "missing_price"
      : depositsMissing
        ? "missing_deposits"
        : extremeDivergence
          ? "extreme_divergence"
          : "valid";
  const qualityReason = metadataMissing
    ? "token mints unavailable"
    : priceMissing
      ? "one or more held assets are unpriced"
      : depositsMissing
        ? "Meteora deposit basis unavailable"
        : extremeDivergence
          ? `reported/derived PnL differs by ${pnlPctDiff.toFixed(2)}pp`
          : null;

  return {
    tokenXMint,
    tokenYMint,
    decX,
    decY,
    priceX,
    priceY,
    xHuman,
    yHuman,
    feeXHuman,
    feeYHuman,
    balancesUsd,
    balancesSol,
    claimableUsd,
    claimableSol,
    depositsUsd,
    depositsSol,
    withdrawUsd,
    withdrawSol,
    claimedUsd,
    claimedSol,
    pnlUsd,
    pnlSol,
    pctUsd,
    pctSol,
    ourPct,
    reportedPct,
    pnlPctDiff,
    quality,
    qualityReason,
    pnlPctSuspicious: quality !== "valid",
    liqXUsd: xHuman * priceX,
    liqYUsd: yHuman * priceY,
    feeXUsd: feeXHuman * priceX,
    feeYUsd: feeYHuman * priceY,
  };
}

// ─── Build the shaped position object (matches getMyPositions output) ──
function buildPosition(f, prices, solUsd, meteora, solMode) {
  const tracked = getTrackedPosition(f.position);
  const value = calculateAssetAwareValue(f, prices, solUsd, meteora, solMode, tracked);
  const {
    tokenXMint, tokenYMint, decX, decY, priceX, priceY,
    xHuman, yHuman, feeXHuman, feeYHuman,
    balancesUsd, balancesSol, claimableUsd, claimableSol,
    depositsUsd, depositsSol, withdrawUsd, withdrawSol,
    claimedUsd, claimedSol, pnlUsd, pnlSol, pctUsd, pctSol, ourPct,
    pnlPctDiff, quality, qualityReason, pnlPctSuspicious,
    liqXUsd, liqYUsd, feeXUsd, feeYUsd,
  } = value;

  if (pnlPctSuspicious) {
    log("pnl_warn", `${f.position.slice(0, 8)} unsafe valuation — quality=${quality} reason=${qualityReason || "unknown"} ` +
      `(solUsd=${solUsd ?? 0}, priceX=${priceX}, priceY=${priceY}, pnlPctDiff=${pnlPctDiff ?? "n/a"})`);
  }

  // Human price (token Y per token X, e.g. SOL/MEME) derived from bin geometry.
  // Validated against Meteora's reported current_price: price(binId) =
  // (1 + binStep/1e4)^binId * 10^(decX - decY).
  const priceFactor = 10 ** (decX - decY);
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
  const trackedProfile = tracked?.asset_profile || {};
  const profileMatchesOnChain = trackedProfile.token_x_mint === tokenXMint
    && trackedProfile.token_y_mint === tokenYMint;
  const provisionalTrackedPair = !rawPoolName
    || rawPoolName.toUpperCase() === "SOL-SOL"
    || rawPoolName.toUpperCase() === "SOL/SOL"
    || rawPoolName.includes("?");
  // A provisional adopted display pair must never outrank the current pool
  // mints. This repairs legacy rows that were persisted as SOL-SOL before the
  // quote asset was known (the original SOL/USDC incident).
  const useTrackedNames = !tracked?.adopted || (profileMatchesOnChain && !provisionalTrackedPair);
  const sepIdx = Math.max(rawPoolName.lastIndexOf("/"), rawPoolName.lastIndexOf("-"));
  const nameX = useTrackedNames
    ? (sepIdx > 0 ? rawPoolName.slice(0, sepIdx).trim() : rawPoolName)
    : "";
  const nameY = useTrackedNames && sepIdx > 0 ? rawPoolName.slice(sepIdx + 1).trim() : "";
  const symX = nameX || meteora?.tokenX || getCachedSymbol(tokenXMint)
    || (tokenXMint ? `${String(tokenXMint).slice(0, 4)}…` : "?");
  const symY = nameY || meteora?.tokenY || getCachedSymbol(tokenYMint)
    || (tokenYMint ? `${String(tokenYMint).slice(0, 4)}…` : "?");
  const canonicalPair = `${symX}-${symY}`;
  const valuationState = recordPositionValuationState(f.position, {
    quality,
    pair_name: canonicalPair,
    asset_profile: {
      token_x_mint: tokenXMint,
      token_y_mint: tokenYMint,
      token_x_symbol: symX,
      token_y_symbol: symY,
      token_x_decimals: decX,
      token_y_decimals: decY,
      source: "onchain_rpc",
      validated_at: new Date().toISOString(),
    },
  });
  const pair = valuationState.pair_name || tracked?.pool_name || canonicalPair;
  const pnlManagementReady = quality === "valid" && valuationState.management_armed;

  const ageFromState = tracked?.deployed_at
    ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
    : null;
  const ageMinutes = meteora?.createdAt ? Math.floor((Date.now() - meteora.createdAt * 1000) / 60000) : ageFromState;

  return {
    position:           f.position,
    pool:               f.pool,
    pair:               pair,
    base_mint:          tokenXMint,
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
    pnl_quality:        quality,
    pnl_quality_reason: qualityReason,
    pnl_management_ready: !!pnlManagementReady,
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
    token_x_mint:   tokenXMint,
    token_y_mint:   tokenYMint,
    token_x_decimals: decX,
    token_y_decimals: decY,
    asset_profile: valuationState.asset_profile,
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
    const tokenXMint = info?.lbPair?.tokenXMint?.toString?.()
      ?? info?.tokenX?.mint?.address?.toString?.()
      ?? null;
    const tokenYMint = info?.lbPair?.tokenYMint?.toString?.()
      ?? info?.tokenY?.mint?.address?.toString?.()
      ?? null;
    const baseMint = tokenXMint;
    const active = info?.lbPair?.activeId ?? null;
    const binStep = info?.lbPair?.binStep ?? null;
    for (const p of info?.lbPairPositionsData || []) {
      const d = p.positionData || {};
      flat.push({
        position: p.publicKey.toString(),
        pool: lbPairKey,
        baseMint,
        tokenXMint,
        tokenYMint,
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
    return {
      wallet: walletAddress,
      total_positions: 0,
      positions: [],
      source: "rpc",
      snapshot_at: new Date().toISOString(),
    };
  }

  const [prices, meteoraByPosition] = await Promise.all([
    getJupiterPrices([SOL_MINT, ...flat.flatMap((f) => [f.tokenXMint, f.tokenYMint])]),
    getMeteoraData(walletAddress, flat),
  ]);
  const solUsd = prices[SOL_MINT] ?? null;

  const positions = flat.map((f) => buildPosition(f, prices, solUsd, meteoraByPosition[f.position], solMode));

  return {
    wallet: walletAddress,
    total_positions: positions.length,
    positions,
    source: "rpc",
    snapshot_at: new Date().toISOString(),
  };
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
    return {
      wallet: walletAddress,
      total_positions: 0,
      positions: [],
      source: "rpc",
      snapshot_at: new Date().toISOString(),
    };
  }

  const map = await buildPositionMapFromAccounts(tracked);
  return buildPositionsFromMap(walletAddress, map, { countTick: true });
}
