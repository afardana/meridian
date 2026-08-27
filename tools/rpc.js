import { Connection } from "@solana/web3.js";
import { log } from "../logger.js";

// ─── Configuration ──────────────────────────────────────────────────────────
const CIRCUIT_BREAKER_THRESHOLD  = 5;       // consecutive errors to open circuit
const CIRCUIT_BREAKER_COOLDOWN   = 60_000;  // ms before retrying a circuit-opened endpoint
const CALL_TIMEOUT_MS            = 15_000;  // max ms per RPC call
const BACKOFF_BASE_MS            = 1_000;   // base for exponential backoff
const BACKOFF_MAX_MS             = 10_000;  // max backoff delay
const LATENCY_WINDOW             = 20;      // rolling window size for avg latency
const RATE_LIMIT_COOLDOWN_MS     = 30_000;  // avoid immediately reusing a 429 endpoint
const CAPABILITY_COOLDOWN_MS     = 30 * 60_000; // unsupported method/API shape
const RPC_TELEMETRY_LOG_INTERVAL_MS = 5 * 60_000;
const STANDARD_POOL              = "standard";
const INDEXED_POOL               = "indexed";
const UNKNOWN_METHOD             = "unknown";

// Meridian owns the endpoint failover/backoff below.  Letting web3.js also
// retry 429s internally multiplies a single overloaded request into a burst
// before our circuit breaker can react (especially when the PnL poll fan-outs
// signature checks for every position).
export const RPC_CONNECTION_OPTIONS = {
  commitment: "confirmed",
  disableRequestBatching: true,
  disableRetryOnRateLimit: true,
};

// ─── Endpoint Pool ──────────────────────────────────────────────────────────

const DEFAULT_STANDARD_ENDPOINTS = [
  process.env.RPC_URL,
  process.env.RPC_URL_FALLBACK_1,
  process.env.RPC_URL_FALLBACK_2,
  "https://api.mainnet-beta.solana.com",
].filter(Boolean);

const _connectionPools = new Map();
const _rpcTelemetry = new Map();
const _connectionTelemetry = new WeakMap();
const TELEMETRY_LOGICAL = "logical";
const TELEMETRY_WIRE = "wire";
const TELEMETRY_HTTP = "http";
const TELEMETRY_WEBSOCKET = "websocket";

/**
 * Return whether an endpoint is a Helius RPC host. Indexed methods are kept
 * on a Helius-only pool because getProgramAccountsV2 is not available on the
 * public Solana endpoint and retrying there only adds latency/noise.
 */
export function isHeliusRpcUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "helius-rpc.com" || hostname.endsWith(".helius-rpc.com");
  } catch {
    return false;
  }
}

function getEndpointUrls(poolName) {
  if (poolName !== INDEXED_POOL) return Array.from(new Set(DEFAULT_STANDARD_ENDPOINTS));

  const explicitlyConfigured = [
    process.env.RPC_INDEXED_URL,
    process.env.RPC_INDEXED_URL_FALLBACK_1,
    process.env.RPC_INDEXED_URL_FALLBACK_2,
  ].filter(Boolean);

  // If the indexed pool is not separately configured, derive it from existing
  // RPC/PnL settings, but never admit a non-Helius host into this pool.
  const candidates = explicitlyConfigured.length > 0
    ? explicitlyConfigured
    : [
        ...DEFAULT_STANDARD_ENDPOINTS,
        process.env.PNL_RPC_URL_ALT,
        process.env.PNL_RPC_URL,
        process.env.PNL_RPC_URL_FALLBACK,
        "https://pump.helius-rpc.com",
      ].filter(Boolean);

  return Array.from(new Set(candidates.filter(isHeliusRpcUrl)));
}

function getConnectionsPool(poolName = STANDARD_POOL) {
  if (!_connectionPools.has(poolName)) {
    _connectionPools.set(poolName, getEndpointUrls(poolName).map(url => {
      const connection = registerRpcConnection(new Connection(url, RPC_CONNECTION_OPTIONS), {
        pool: poolName,
        url,
        source: "rpc-pool",
      });
      return {
        url,
        pool: poolName,
        connection,
        // Error tracking
        errorsCount: 0,
        consecutiveErrors: 0,
        lastErrorTime: 0,
        // Metrics
        totalCalls: 0,
        totalErrors: 0,
        latencies: [],        // rolling window of recent latencies (ms)
        avgLatencyMs: 0,
        // Circuit breaker
        circuitOpen: false,
        circuitOpenedAt: 0,
        // Capability/rate-limit state is separate from endpoint health. A
        // method can be unsupported without the whole endpoint being unhealthy.
        unsupportedMethods: new Map(),
        capabilityErrors: 0,
        rateLimitedUntil: 0,
        rateLimitErrors: 0,
        endpointBlockedUntil: 0,
      };
    }));
  }
  return _connectionPools.get(poolName);
}

/**
 * Mask an RPC URL for safe logging (strip API key query params).
 * @param {string} url
 * @returns {string}
 */
export function maskUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split("?")[0];
  }
}

/**
 * Compute a health score for an endpoint (lower is better).
 * @param {object} node
 * @returns {number}
 */
function healthScore(node) {
  if (node.circuitOpen) return 999_999;
  if (node.endpointBlockedUntil > Date.now()) return 999_998;
  if (node.rateLimitedUntil > Date.now()) return 999_997;
  const primaryUrl = node.pool === INDEXED_POOL
    ? (process.env.RPC_INDEXED_URL || process.env.RPC_URL)
    : process.env.RPC_URL;
  const isPrimary = node.url === primaryUrl;
  if (isPrimary && node.consecutiveErrors === 0) return 0;
  return node.avgLatencyMs + (node.consecutiveErrors * 5_000);
}

function normalizeMethod(method) {
  return typeof method === "string" && method.trim() ? method.trim() : UNKNOWN_METHOD;
}

function normalizePool(poolName) {
  return poolName === INDEXED_POOL ? INDEXED_POOL : STANDARD_POOL;
}

function normalizeTelemetryKind(kind) {
  return kind === TELEMETRY_WIRE ? TELEMETRY_WIRE : TELEMETRY_LOGICAL;
}

function normalizeTelemetryTransport(transport) {
  return transport === TELEMETRY_WEBSOCKET ? TELEMETRY_WEBSOCKET : TELEMETRY_HTTP;
}

function getRpcMetric(poolName, method, kind = TELEMETRY_LOGICAL, transport = TELEMETRY_HTTP) {
  const pool = normalizePool(poolName);
  const normalizedMethod = normalizeMethod(method);
  const normalizedKind = normalizeTelemetryKind(kind);
  const normalizedTransport = normalizeTelemetryTransport(transport);
  const key = `${normalizedKind}:${normalizedTransport}:${pool}:${normalizedMethod}`;
  let metric = _rpcTelemetry.get(key);
  if (!metric) {
    metric = {
      pool,
      method: normalizedMethod,
      kind: normalizedKind,
      transport: normalizedTransport,
      requests: 0,
      successes: 0,
      failures: 0,
      attempts: 0,
      retries: 0,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
      itemCount: 0,
      inFlight: 0,
      lastLoggedRequests: 0,
    };
    _rpcTelemetry.set(key, metric);
  }
  return metric;
}

function startRpcMetric(poolName, method, itemCount, { kind = TELEMETRY_LOGICAL, transport = TELEMETRY_HTTP } = {}) {
  const metric = getRpcMetric(poolName, method, kind, transport);
  metric.requests++;
  metric.inFlight++;
  // Wire entries represent a concrete attempt already being sent. Logical
  // entries increment attempts in the failover loop because they may retry
  // across endpoints.
  if (normalizeTelemetryKind(kind) === TELEMETRY_WIRE) metric.attempts++;
  if (Number.isFinite(Number(itemCount)) && Number(itemCount) >= 0) {
    metric.itemCount += Number(itemCount);
  }
  return { metric, startedAt: Date.now() };
}

function noteRpcAttempt(metricState, attemptIndex) {
  if (!metricState) return;
  metricState.metric.attempts++;
  if (attemptIndex > 0) metricState.metric.retries++;
}

function finishRpcMetric(metricState, success) {
  if (!metricState) return;
  const elapsed = Math.max(0, Date.now() - metricState.startedAt);
  const metric = metricState.metric;
  metric.inFlight = Math.max(0, metric.inFlight - 1);
  if (success) metric.successes++;
  else metric.failures++;
  metric.totalLatencyMs += elapsed;
  metric.maxLatencyMs = Math.max(metric.maxLatencyMs, elapsed);
  maybeLogRpcTelemetry();
}

function metricSnapshot(metric) {
  return {
    pool: metric.pool,
    method: metric.method,
    kind: metric.kind,
    transport: metric.transport,
    requests: metric.requests,
    successes: metric.successes,
    failures: metric.failures,
    attempts: metric.attempts,
    retries: metric.retries,
    inFlight: metric.inFlight,
    avgLatencyMs: metric.requests > 0
      ? Math.round(metric.totalLatencyMs / metric.requests)
      : 0,
    maxLatencyMs: metric.maxLatencyMs,
    itemCount: metric.itemCount,
  };
}

function maybeLogRpcTelemetry() {
  const now = Date.now();
  if (!maybeLogRpcTelemetry.lastAt) maybeLogRpcTelemetry.lastAt = 0;
  if (now - maybeLogRpcTelemetry.lastAt < RPC_TELEMETRY_LOG_INTERVAL_MS) return;

  const changed = [..._rpcTelemetry.values()]
    .filter((metric) => metric.requests > metric.lastLoggedRequests && metric.inFlight === 0)
    .sort((a, b) => (b.requests - b.lastLoggedRequests) - (a.requests - a.lastLoggedRequests));
  if (changed.length === 0) return;

  const rendered = changed.slice(0, 12).map((metric) => {
    const deltaRequests = metric.requests - metric.lastLoggedRequests;
    const deltaSuccesses = metric.successes - (metric.lastLoggedSuccesses || 0);
    const deltaFailures = metric.failures - (metric.lastLoggedFailures || 0);
    const deltaAttempts = metric.attempts - (metric.lastLoggedAttempts || 0);
    const deltaRetries = metric.retries - (metric.lastLoggedRetries || 0);
    const deltaLatency = metric.totalLatencyMs - (metric.lastLoggedLatencyMs || 0);
    const avgLatency = deltaRequests > 0 ? Math.round(deltaLatency / deltaRequests) : 0;
    metric.lastLoggedRequests = metric.requests;
    metric.lastLoggedSuccesses = metric.successes;
    metric.lastLoggedFailures = metric.failures;
    metric.lastLoggedAttempts = metric.attempts;
    metric.lastLoggedRetries = metric.retries;
    metric.lastLoggedLatencyMs = metric.totalLatencyMs;
    return `${metric.kind}/${metric.transport}:${metric.pool}:${metric.method} req=${deltaRequests} ok=${deltaSuccesses} fail=${deltaFailures} attempts=${deltaAttempts} retries=${deltaRetries} avg=${avgLatency}ms`;
  });
  maybeLogRpcTelemetry.lastAt = now;
  log("rpc_metrics", `Last ${Math.round(RPC_TELEMETRY_LOG_INTERVAL_MS / 60_000)}m — ${rendered.join(" | ")}`);
}

/**
 * Return cumulative, method-level RPC counters without exposing endpoint URLs
 * or API keys. Counters are process-local and intentionally cheap to update.
 */
export function getRpcTelemetrySnapshot({ kind = null, transport = null } = {}) {
  return [..._rpcTelemetry.values()]
    .filter((metric) => !kind || metric.kind === kind)
    .filter((metric) => !transport || metric.transport === transport)
    .map(metricSnapshot)
    .sort((a, b) => b.requests - a.requests || a.pool.localeCompare(b.pool) || a.method.localeCompare(b.method));
}

export function resetRpcTelemetry() {
  _rpcTelemetry.clear();
  maybeLogRpcTelemetry.lastAt = 0;
}

function inferRpcItemCount(method, params) {
  const normalizedMethod = normalizeMethod(method);
  if (normalizedMethod === "getMultipleAccounts") {
    return Array.isArray(params?.[0]) ? params[0].length : null;
  }
  if (normalizedMethod === "getSignaturesForAddress" || normalizedMethod.endsWith("Subscribe")) return 1;
  if (normalizedMethod === "getTokenAccountsByOwner") return 1;
  if (normalizedMethod === "getProgramAccounts" || normalizedMethod === "getProgramAccountsV2") return null;
  return 1;
}

function wireResponseFailed(response) {
  return !!response?.error;
}

/**
 * Attach wire-level telemetry to a web3.js Connection instance.
 *
 * web3.js' public methods and the Meteora SDK both eventually call the
 * instance-private `_rpcRequest`/`_rpcBatchRequest` methods. Wrapping those
 * methods gives us the JSON-RPC method actually sent over HTTP, even when a
 * high-level SDK operation hides several reads. The WebSocket call boundary is
 * wrapped too, so /health can distinguish HTTP and WS traffic.
 *
 * This is intentionally an opt-in registration rather than a global prototype
 * patch: scripts and third-party connections outside Meridian are not counted,
 * while every bot-owned connection is registered at construction time.
 */
export function registerRpcConnection(connection, { pool = STANDARD_POOL, url = null, source = null } = {}) {
  if (!connection || typeof connection !== "object") return connection;

  let metadata = _connectionTelemetry.get(connection);
  if (!metadata) {
    metadata = {
      pool: normalizePool(pool),
      url,
      source,
      rpcWrapped: false,
      batchWrapped: false,
      websocketWrapped: false,
    };
    _connectionTelemetry.set(connection, metadata);
  } else {
    metadata.pool = normalizePool(pool);
    metadata.url = url || metadata.url;
    metadata.source = source || metadata.source;
  }

  if (!metadata.rpcWrapped && typeof connection._rpcRequest === "function") {
    const originalRpcRequest = connection._rpcRequest;
    connection._rpcRequest = function meridianTelemetryRpcRequest(method, params) {
      const state = startRpcMetric(
        metadata.pool,
        method,
        inferRpcItemCount(method, params),
        { kind: TELEMETRY_WIRE, transport: TELEMETRY_HTTP },
      );
      let request;
      try {
        request = originalRpcRequest.call(this, method, params);
      } catch (error) {
        finishRpcMetric(state, false);
        throw error;
      }
      return Promise.resolve(request).then(
        (response) => {
          finishRpcMetric(state, !wireResponseFailed(response));
          return response;
        },
        (error) => {
          finishRpcMetric(state, false);
          throw error;
        },
      );
    };
    metadata.rpcWrapped = true;
  }

  if (!metadata.batchWrapped && typeof connection._rpcBatchRequest === "function") {
    const originalRpcBatchRequest = connection._rpcBatchRequest;
    connection._rpcBatchRequest = function meridianTelemetryRpcBatchRequest(requests) {
      const requestList = Array.isArray(requests) ? requests : [];
      const states = requestList.map((request) => startRpcMetric(
        metadata.pool,
        request?.methodName,
        inferRpcItemCount(request?.methodName, request?.args),
        { kind: TELEMETRY_WIRE, transport: TELEMETRY_HTTP },
      ));
      let batch;
      try {
        batch = originalRpcBatchRequest.call(this, requests);
      } catch (error) {
        states.forEach((state) => finishRpcMetric(state, false));
        throw error;
      }
      return Promise.resolve(batch).then(
        (response) => {
          const responses = Array.isArray(response) ? response : [];
          states.forEach((state, index) => {
            finishRpcMetric(state, !!responses[index] && !wireResponseFailed(responses[index]));
          });
          return response;
        },
        (error) => {
          states.forEach((state) => finishRpcMetric(state, false));
          throw error;
        },
      );
    };
    metadata.batchWrapped = true;
  }

  const websocket = connection._rpcWebSocket;
  if (!metadata.websocketWrapped && websocket && typeof websocket.call === "function") {
    const originalWebsocketCall = websocket.call;
    websocket.call = function meridianTelemetryWebsocketCall(method, ...args) {
      const state = startRpcMetric(
        metadata.pool,
        method,
        inferRpcItemCount(method, args),
        { kind: TELEMETRY_WIRE, transport: TELEMETRY_WEBSOCKET },
      );
      let request;
      try {
        request = originalWebsocketCall.call(this, method, ...args);
      } catch (error) {
        finishRpcMetric(state, false);
        throw error;
      }
      return Promise.resolve(request).then(
        (response) => {
          finishRpcMetric(state, !wireResponseFailed(response));
          return response;
        },
        (error) => {
          finishRpcMetric(state, false);
          throw error;
        },
      );
    };

    if (typeof websocket.notify === "function") {
      const originalWebsocketNotify = websocket.notify;
      websocket.notify = function meridianTelemetryWebsocketNotify(method, ...args) {
        const state = startRpcMetric(
          metadata.pool,
          method,
          inferRpcItemCount(method, args),
          { kind: TELEMETRY_WIRE, transport: TELEMETRY_WEBSOCKET },
        );
        try {
          const response = originalWebsocketNotify.call(this, method, ...args);
          finishRpcMetric(state, true);
          return response;
        } catch (error) {
          finishRpcMetric(state, false);
          throw error;
        }
      };
    }
    metadata.websocketWrapped = true;
  }

  return connection;
}

function unsupportedMethodUntil(node, method, now = Date.now()) {
  const normalizedMethod = normalizeMethod(method);
  const until = node.unsupportedMethods.get(normalizedMethod) || 0;
  if (until > now) return until;
  if (until) node.unsupportedMethods.delete(normalizedMethod);
  return 0;
}

function isNodeAvailable(node, method, now = Date.now()) {
  return !node.circuitOpen
    && node.rateLimitedUntil <= now
    && node.endpointBlockedUntil <= now
    && unsupportedMethodUntil(node, method, now) === 0;
}

function classifyRpcError(error) {
  const code = Number(error?.rpcCode ?? error?.code);
  const message = String(error?.message || error || "");
  const statusMatch = message.match(/(?:HTTP(?: error)?|status)\s*(\d{3})|\b(4\d{2})\b/i);
  const httpStatus = Number(statusMatch?.[1] || statusMatch?.[2] || 0);
  const isRateLimit = code === 429 || httpStatus === 429
    || /429|too many requests|rate.?limit/i.test(message);
  const isCapability = code === -32601 || code === -32602
    || [400, 401, 403, 404].includes(httpStatus);
  const isTimeout = /timed out|timeout/i.test(message);
  return { code, httpStatus, isRateLimit, isCapability, isTimeout };
}

function markRpcCapabilityFailure(node, method, classification) {
  const until = Date.now() + CAPABILITY_COOLDOWN_MS;
  if (normalizeMethod(method) === UNKNOWN_METHOD || [401, 403].includes(classification.httpStatus)) {
    node.endpointBlockedUntil = until;
  } else {
    node.unsupportedMethods.set(normalizeMethod(method), until);
  }
  node.capabilityErrors++;
  log("rpc_capability", `${maskUrl(node.url)} does not support ${normalizeMethod(method)}${classification.code ? ` (${classification.code})` : ""}; skipping it for ${Math.round(CAPABILITY_COOLDOWN_MS / 60_000)}m`);
}

function markRpcRateLimit(node) {
  node.rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  node.rateLimitErrors++;
}

/**
 * Update rolling average latency for an endpoint.
 * @param {object} node
 * @param {number} latencyMs
 */
function recordLatency(node, latencyMs) {
  node.latencies.push(latencyMs);
  if (node.latencies.length > LATENCY_WINDOW) node.latencies.shift();
  node.avgLatencyMs = Math.round(
    node.latencies.reduce((a, b) => a + b, 0) / node.latencies.length
  );
}

/**
 * Check and auto-reset circuit breakers whose cooldown has expired.
 * @param {object[]} pool
 */
function checkCircuitBreakers(pool) {
  const now = Date.now();
  for (const node of pool) {
    if (node.circuitOpen && (now - node.circuitOpenedAt >= CIRCUIT_BREAKER_COOLDOWN)) {
      node.circuitOpen = false;
      node.consecutiveErrors = 0;
      log("rpc_health", `Circuit breaker CLOSED (auto-reset) for ${maskUrl(node.url)}`);
    }
  }
}

/**
 * Open the circuit breaker for an endpoint.
 * @param {object} node
 */
function openCircuitBreaker(node) {
  node.circuitOpen = true;
  node.circuitOpenedAt = Date.now();
  log("rpc_health", `Circuit breaker OPENED for ${maskUrl(node.url)} after ${node.consecutiveErrors} consecutive errors`);
}

/**
 * Wrap a promise with a timeout.
 * @param {Promise} promise
 * @param {number} ms
 * @returns {Promise}
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RPC call timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      val => { clearTimeout(timer); resolve(val); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Executes a Solana web3.js RPC operation with automatic failover,
 * per-endpoint circuit breakers, exponential backoff, and latency tracking.
 *
 * @example
 *   const balance = await callRpc(conn => conn.getBalance(pubkey));
 *
 * @param {Function} operation - Callback receiving a Connection instance
 * @param {object} [options]
 * @param {string} [options.method] - JSON-RPC method label for telemetry/capability routing
 * @param {string} [options.pool] - Endpoint pool name: standard or indexed
 * @param {number} [options.itemCount] - Logical item count represented by the call
 * @returns {Promise<{result: any, connection: Connection, url: string}>} Response and connection that succeeded
 */
export async function callRpcWithConnection(operation, options = {}) {
  const method = normalizeMethod(options.method);
  const poolName = normalizePool(options.pool);
  const pool = getConnectionsPool(poolName);
  const metricState = startRpcMetric(poolName, method, options.itemCount);
  checkCircuitBreakers(pool);

  // Sort by health score (lower = healthier)
  const sortedPool = [...pool].sort((a, b) => healthScore(a) - healthScore(b));

  // Filter out circuit-opened, rate-limited, forbidden, and method-incompatible endpoints.
  const available = sortedPool.filter((node) => isNodeAvailable(node, method));
  if (available.length === 0) {
    // Preserve the old circuit-breaker recovery behavior, but never bypass a
    // method capability or rate-limit cooldown just to force a request through.
    const circuitCandidates = sortedPool.filter((node) =>
      node.rateLimitedUntil <= Date.now()
      && node.endpointBlockedUntil <= Date.now()
      && unsupportedMethodUntil(node, method) === 0
    );
    const oldest = circuitCandidates
      .filter((node) => node.circuitOpen)
      .sort((a, b) => a.circuitOpenedAt - b.circuitOpenedAt)[0];
    if (oldest && circuitCandidates.every((node) => node.circuitOpen)) {
      oldest.circuitOpen = false;
      oldest.consecutiveErrors = 0;
      available.push(oldest);
      log("rpc_health", `All endpoints circuit-opened. Force-resetting ${maskUrl(oldest.url)}`);
    }
  }

  if (available.length === 0) {
    finishRpcMetric(metricState, false);
    const reason = pool.length === 0
      ? `No ${poolName} RPC endpoints configured`
      : `No ${poolName} RPC endpoints available for ${method}`;
    throw new Error(`${reason}.`);
  }

  let lastError = null;
  for (let i = 0; i < available.length; i++) {
    const node = available[i];
    node.totalCalls++;
    noteRpcAttempt(metricState, i);

    // Exponential backoff between retries (not on first attempt)
    if (i > 0) {
      const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, i - 1), BACKOFF_MAX_MS);
      await new Promise(r => setTimeout(r, delay));
    }

    const start = Date.now();
    try {
      const result = await withTimeout(operation(node.connection), CALL_TIMEOUT_MS);
      const elapsed = Date.now() - start;
      recordLatency(node, elapsed);

      // Success: reset consecutive errors
      if (node.consecutiveErrors > 0) {
        node.consecutiveErrors = 0;
      }
      node.rateLimitedUntil = 0;
      finishRpcMetric(metricState, true);
      return { result, connection: node.connection, url: node.url };
    } catch (err) {
      const elapsed = Date.now() - start;
      lastError = err;
      const classification = classifyRpcError(err);
      node.errorsCount++;
      node.totalErrors++;
      node.lastErrorTime = Date.now();
      recordLatency(node, Math.max(elapsed, CALL_TIMEOUT_MS));

      log("rpc_failover", `${maskUrl(node.url)}: ${err.message} (consecutive: ${node.consecutiveErrors})`);

      const { recordError } = await import("../error-telemetry.js");
      if (classification.isRateLimit) recordError("rpc_429", `${maskUrl(node.url)}: 429`);
      else if (classification.isTimeout) recordError("rpc_timeout", `${maskUrl(node.url)}: timeout`);
      else recordError("rpc_other", `${maskUrl(node.url)}: ${err.message}`);

      if (classification.isCapability) {
        // -32601/-32602 and HTTP 4xx responses are permanent for this
        // endpoint/method combination; retrying them only fans out failures.
        markRpcCapabilityFailure(node, method, classification);
      } else {
        node.consecutiveErrors++;
        if (classification.isRateLimit) markRpcRateLimit(node);

        // Open circuit breaker if threshold reached
        if (node.consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
          openCircuitBreaker(node);
        }
      }
    }
  }

  finishRpcMetric(metricState, false);
  throw new Error(`All Solana RPC endpoints in the failover pool failed. Last error: ${lastError?.message || "unknown"}`);
}

/**
 * Execute an RPC operation with failover and return only its result.
 * Existing read-only callers use this compatibility wrapper; callers that need
 * to continue using the same endpoint for subsequent SDK/transaction calls
 * should use callRpcWithConnection instead.
 */
export async function callRpc(operation, options = {}) {
  const { result } = await callRpcWithConnection(operation, options);
  return result;
}

/**
 * Execute an RPC method that is not exposed by web3.js' public Connection
 * methods (for example Helius' getProgramAccountsV2) through the same
 * endpoint pool and circuit breaker as normal RPC calls.
 *
 * `_rpcRequest` is the low-level request primitive used by Connection itself;
 * RPC_CONNECTION_OPTIONS disables its built-in 429 retry so this wrapper remains
 * the single owner of retry and failover behavior.
 *
 * @param {string} method
 * @param {Array} [params]
 * @param {object} [options]
 */
export async function callRpcMethod(method, params = [], options = {}) {
  if (!method || typeof method !== "string") throw new Error("RPC method is required");
  const { result } = await callRpcWithConnection(async (connection) => {
    if (typeof connection._rpcRequest !== "function") {
      throw new Error(`RPC method ${method} is unavailable on this web3.js version`);
    }
    const response = await connection._rpcRequest(method, params);
    if (response?.error) {
      const code = response.error.code != null ? ` (${response.error.code})` : "";
      const error = new Error(`${method}${code}: ${response.error.message || "RPC error"}`);
      error.rpcCode = response.error.code;
      throw error;
    }
    return response?.result;
  }, {
    ...options,
    method,
    pool: method === "getProgramAccountsV2" ? INDEXED_POOL : options.pool,
  });
  return result;
}

/**
 * Returns a health report for all RPC endpoints.
 * Useful for /status command and dashboard display.
 *
 * @returns {Array<{pool: string, url: string, status: string, avgLatencyMs: number, totalCalls: number, totalErrors: number, errorRate: string, consecutiveErrors: number, circuitOpen: boolean}>}
 */
export function getRpcHealthReport() {
  const report = [];
  for (const poolName of [STANDARD_POOL, INDEXED_POOL]) {
    const pool = getConnectionsPool(poolName);
    for (const node of pool) {
      const errorRate = node.totalCalls > 0
        ? ((node.totalErrors / node.totalCalls) * 100).toFixed(1) + "%"
        : "N/A";
      let status = "🟢 Healthy";
      if (node.circuitOpen) status = "🔴 Circuit Open";
      else if (node.consecutiveErrors > 0) status = "🟡 Degraded";
      else if (node.endpointBlockedUntil > Date.now() || node.rateLimitedUntil > Date.now() || node.capabilityErrors > 0) status = "🟡 Limited";
      report.push({
        pool: poolName,
        url: maskUrl(node.url),
        status,
        avgLatencyMs: node.avgLatencyMs,
        totalCalls: node.totalCalls,
        totalErrors: node.totalErrors,
        errorRate,
        consecutiveErrors: node.consecutiveErrors,
        circuitOpen: node.circuitOpen,
        capabilityErrors: node.capabilityErrors,
        rateLimitErrors: node.rateLimitErrors,
        unsupportedMethods: [...node.unsupportedMethods.keys()],
      });
    }
  }
  return report;
}

/**
 * Format RPC health report as a compact string for Telegram/CLI.
 * @returns {string}
 */
export function formatRpcHealth() {
  const report = getRpcHealthReport();
  if (report.length === 0) return "RPC: No endpoints configured";
  const lines = report.map((r, i) => {
    const poolEntriesBefore = report.slice(0, i).filter((entry) => entry.pool === r.pool).length;
    const name = poolEntriesBefore === 0 ? "Primary" : `Fallback ${poolEntriesBefore}`;
    return `  ${r.status} ${r.pool}/${name}: ${r.avgLatencyMs}ms avg, ${r.errorRate} errors (${r.totalCalls} calls)`;
  });
  return `RPC Health:\n${lines.join("\n")}`;
}

/**
 * Reset all RPC endpoint health counters. For manual recovery.
 */
export function resetRpcHealth() {
  for (const pool of _connectionPools.values()) {
    for (const node of pool) {
      node.errorsCount = 0;
      node.consecutiveErrors = 0;
      node.lastErrorTime = 0;
      node.totalCalls = 0;
      node.totalErrors = 0;
      node.latencies = [];
      node.avgLatencyMs = 0;
      node.circuitOpen = false;
      node.circuitOpenedAt = 0;
      node.unsupportedMethods.clear();
      node.capabilityErrors = 0;
      node.rateLimitedUntil = 0;
      node.rateLimitErrors = 0;
      node.endpointBlockedUntil = 0;
    }
  }
  log("rpc_health", "All RPC health counters reset for every pool");
}

/**
 * Execute a batch JSON-RPC request to the healthiest available RPC node.
 * Automatically handles failover, circuit breakers, and timeouts.
 *
 * @param {Array<{method: string, params: Array}>} requests
 * @returns {Promise<Array>} Array of results matching the requests
 */
export async function callRpcBatch(requests) {
  if (!Array.isArray(requests) || requests.length === 0) return [];
  const { recordError } = await import("../error-telemetry.js");

  const pool = getConnectionsPool(STANDARD_POOL);
  const metricState = startRpcMetric(STANDARD_POOL, "batch", requests.length);
  checkCircuitBreakers(pool);

  const sortedPool = [...pool].sort((a, b) => healthScore(a) - healthScore(b));
  const available = sortedPool.filter((node) => isNodeAvailable(node, "batch"));

  if (available.length === 0) {
    const circuitCandidates = sortedPool.filter((node) =>
      node.rateLimitedUntil <= Date.now()
      && node.endpointBlockedUntil <= Date.now()
      && unsupportedMethodUntil(node, "batch") === 0
    );
    const oldest = circuitCandidates
      .filter((node) => node.circuitOpen)
      .sort((a, b) => a.circuitOpenedAt - b.circuitOpenedAt)[0];
    if (oldest && circuitCandidates.every((node) => node.circuitOpen)) {
      oldest.circuitOpen = false;
      oldest.consecutiveErrors = 0;
      available.push(oldest);
      log("rpc_health", `All endpoints circuit-opened. Force-resetting ${maskUrl(oldest.url)}`);
    }
  }

  let lastError = null;
  for (let i = 0; i < available.length; i++) {
    const node = available[i];
    node.totalCalls++;
    noteRpcAttempt(metricState, i);

    if (i > 0) {
      const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, i - 1), BACKOFF_MAX_MS);
      await new Promise(r => setTimeout(r, delay));
    }

    const start = Date.now();
    let wireStates = [];
    let wireMetricsFinished = false;
    try {
      const payload = requests.map((req, idx) => ({
        jsonrpc: "2.0",
        id: idx + 1,
        method: req.method,
        params: req.params,
      }));
      wireStates = requests.map((req) => startRpcMetric(
        STANDARD_POOL,
        req?.method,
        inferRpcItemCount(req?.method, req?.params),
        { kind: TELEMETRY_WIRE, transport: TELEMETRY_HTTP },
      ));

      // Call via raw fetch for batch JSON-RPC request
      const res = await withTimeout(
        fetch(node.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
        CALL_TIMEOUT_MS
      );

      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}`);
      }

      const json = await res.json();
      if (!Array.isArray(json)) {
        throw new Error("RPC response is not an array");
      }

      const elapsed = Date.now() - start;
      recordLatency(node, elapsed);

      if (node.consecutiveErrors > 0) {
        node.consecutiveErrors = 0;
      }
      node.rateLimitedUntil = 0;

      // Sort responses by ID to match request index order
      const sortedResponses = json.sort((a, b) => a.id - b.id);
      wireStates.forEach((state, index) => {
        finishRpcMetric(state, !!sortedResponses[index] && !wireResponseFailed(sortedResponses[index]));
      });
      wireMetricsFinished = true;
      const results = sortedResponses.map((r) => {
        if (r.error) {
          const error = new Error(r.error.message || JSON.stringify(r.error));
          error.rpcCode = r.error.code;
          throw error;
        }
        return r.result;
      });
      finishRpcMetric(metricState, true);
      return results;
    } catch (err) {
      const elapsed = Date.now() - start;
      lastError = err;
      if (!wireMetricsFinished) {
        wireStates.forEach((state) => finishRpcMetric(state, false));
        wireMetricsFinished = true;
      }
      node.errorsCount++;
      node.totalErrors++;
      node.lastErrorTime = Date.now();
      recordLatency(node, Math.max(elapsed, CALL_TIMEOUT_MS));

      log("rpc_failover", `Batch call failed on ${maskUrl(node.url)}: ${err.message}`);

      // Log to telemetry
      const is429 = err.message?.includes("429") || err.message?.toLowerCase().includes("too many requests");
      const isTimeout = err.message?.includes("timed out") || err.message?.includes("timeout");
      if (is429) recordError("rpc_429", `${maskUrl(node.url)} batch 429`);
      else if (isTimeout) recordError("rpc_timeout", `${maskUrl(node.url)} batch timeout`);
      else recordError("rpc_other", `${maskUrl(node.url)}: ${err.message}`);

      const classification = classifyRpcError(err);
      if (classification.isCapability) {
        markRpcCapabilityFailure(node, "batch", classification);
      } else {
        node.consecutiveErrors++;
        if (classification.isRateLimit) markRpcRateLimit(node);
        if (node.consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
          openCircuitBreaker(node);
        }
      }
    }
  }

  finishRpcMetric(metricState, false);
  throw new Error(`All Solana RPC endpoints in the failover pool failed. Last error: ${lastError?.message || "unknown"}`);
}
