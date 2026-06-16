import { Connection } from "@solana/web3.js";
import { log } from "../logger.js";

// ─── Configuration ──────────────────────────────────────────────────────────
const CIRCUIT_BREAKER_THRESHOLD  = 5;       // consecutive errors to open circuit
const CIRCUIT_BREAKER_COOLDOWN   = 60_000;  // ms before retrying a circuit-opened endpoint
const CALL_TIMEOUT_MS            = 15_000;  // max ms per RPC call
const BACKOFF_BASE_MS            = 1_000;   // base for exponential backoff
const BACKOFF_MAX_MS             = 10_000;  // max backoff delay
const LATENCY_WINDOW             = 20;      // rolling window size for avg latency

// ─── Endpoint Pool ──────────────────────────────────────────────────────────

const DEFAULT_ENDPOINTS = [
  process.env.RPC_URL,
  process.env.RPC_URL_FALLBACK_1,
  process.env.RPC_URL_FALLBACK_2,
  "https://rpc.ankr.com/solana",
  "https://api.mainnet-beta.solana.com",
].filter(Boolean);

let _connections = [];

function getConnectionsPool() {
  if (_connections.length === 0) {
    const uniqueUrls = Array.from(new Set(DEFAULT_ENDPOINTS));
    _connections = uniqueUrls.map(url => ({
      url,
      connection: new Connection(url, "confirmed"),
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
    }));
  }
  return _connections;
}

/**
 * Mask an RPC URL for safe logging (strip API key query params).
 * @param {string} url
 * @returns {string}
 */
function maskUrl(url) {
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
  return node.avgLatencyMs + (node.consecutiveErrors * 5_000);
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
    promise.then(
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
 * @returns {Promise<any>} Response from the successful connection call
 */
export async function callRpc(operation) {
  const pool = getConnectionsPool();
  checkCircuitBreakers(pool);

  // Sort by health score (lower = healthier)
  const sortedPool = [...pool].sort((a, b) => healthScore(a) - healthScore(b));

  // Filter out circuit-opened endpoints
  const available = sortedPool.filter(n => !n.circuitOpen);
  if (available.length === 0) {
    // All endpoints circuit-opened — try the one with oldest circuit open
    const oldest = sortedPool.sort((a, b) => a.circuitOpenedAt - b.circuitOpenedAt)[0];
    if (oldest) {
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
      return result;
    } catch (err) {
      const elapsed = Date.now() - start;
      lastError = err;
      node.errorsCount++;
      node.totalErrors++;
      node.consecutiveErrors++;
      node.lastErrorTime = Date.now();
      recordLatency(node, Math.max(elapsed, CALL_TIMEOUT_MS));

      log("rpc_failover", `${maskUrl(node.url)}: ${err.message} (consecutive: ${node.consecutiveErrors})`);

      // Open circuit breaker if threshold reached
      if (node.consecutiveErrors >= CIRCUIT_BREAKER_THRESHOLD) {
        openCircuitBreaker(node);
      }
    }
  }

  throw new Error(`All Solana RPC endpoints in the failover pool failed. Last error: ${lastError?.message || "unknown"}`);
}

/**
 * Returns a health report for all RPC endpoints.
 * Useful for /status command and dashboard display.
 *
 * @returns {Array<{url: string, status: string, avgLatencyMs: number, totalCalls: number, totalErrors: number, errorRate: string, consecutiveErrors: number, circuitOpen: boolean}>}
 */
export function getRpcHealthReport() {
  const pool = getConnectionsPool();
  return pool.map(node => {
    const errorRate = node.totalCalls > 0
      ? ((node.totalErrors / node.totalCalls) * 100).toFixed(1) + "%"
      : "N/A";
    let status = "🟢 Healthy";
    if (node.circuitOpen) status = "🔴 Circuit Open";
    else if (node.consecutiveErrors > 0) status = "🟡 Degraded";
    return {
      url: maskUrl(node.url),
      status,
      avgLatencyMs: node.avgLatencyMs,
      totalCalls: node.totalCalls,
      totalErrors: node.totalErrors,
      errorRate,
      consecutiveErrors: node.consecutiveErrors,
      circuitOpen: node.circuitOpen,
    };
  });
}

/**
 * Format RPC health report as a compact string for Telegram/CLI.
 * @returns {string}
 */
export function formatRpcHealth() {
  const report = getRpcHealthReport();
  if (report.length === 0) return "RPC: No endpoints configured";
  const lines = report.map((r, i) => {
    const name = i === 0 ? "Primary" : `Fallback ${i}`;
    return `  ${r.status} ${name}: ${r.avgLatencyMs}ms avg, ${r.errorRate} errors (${r.totalCalls} calls)`;
  });
  return `RPC Health:\n${lines.join("\n")}`;
}

/**
 * Reset all RPC endpoint health counters. For manual recovery.
 */
export function resetRpcHealth() {
  const pool = getConnectionsPool();
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
  }
  log("rpc_health", "All RPC health counters reset");
}
