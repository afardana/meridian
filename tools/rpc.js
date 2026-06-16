import { Connection } from "@solana/web3.js";
import { log } from "../logger.js";

// List of backup public and fallback endpoints
const DEFAULT_ENDPOINTS = [
  process.env.RPC_URL,                  // Primary Helius key
  process.env.RPC_URL_FALLBACK_1,       // Fallback 1 from environment
  process.env.RPC_URL_FALLBACK_2,       // Fallback 2 from environment
  "https://rpc.ankr.com/solana",        // Ankr Public (very reliable)
  "https://api.mainnet-beta.solana.com", // Solana Foundation Public
].filter(Boolean);

let _connections = [];

function getConnectionsPool() {
  if (_connections.length === 0) {
    // Dedup endpoints
    const uniqueUrls = Array.from(new Set(DEFAULT_ENDPOINTS));
    _connections = uniqueUrls.map(url => ({
      url,
      connection: new Connection(url, "confirmed"),
      errorsCount: 0,
      lastErrorTime: 0
    }));
  }
  return _connections;
}

/**
 * Executes a Solana web3.js RPC operation with automatic failover and circuit breaker logic.
 *
 * Example:
 *   const balance = await callRpc(conn => conn.getBalance(pubkey));
 *
 * @param {Function} operation - Callback receiving a Connection instance
 * @returns {Promise<any>} Response from the successful connection call
 */
export async function callRpc(operation) {
  const pool = getConnectionsPool();
  const now = Date.now();

  // Prioritize healthy nodes; deprioritize nodes with recent errors (5-minute cooldown)
  const sortedPool = [...pool].sort((a, b) => {
    const aInCooldown = (now - a.lastErrorTime < 300000) && a.errorsCount > 0;
    const bInCooldown = (now - b.lastErrorTime < 300000) && b.errorsCount > 0;

    if (aInCooldown && !bInCooldown) return 1;
    if (!aInCooldown && bInCooldown) return -1;
    return a.errorsCount - b.errorsCount;
  });

  let lastError = null;
  for (const node of sortedPool) {
    try {
      const result = await operation(node.connection);
      // Success: reset error count
      if (node.errorsCount > 0) {
        node.errorsCount = 0;
      }
      return result;
    } catch (err) {
      lastError = err;
      node.errorsCount++;
      node.lastErrorTime = Date.now();
      
      const maskedUrl = node.url.split("?")[0];
      log("rpc_failover", `Call failed on endpoint ${maskedUrl}: ${err.message}. Swapping node...`);
    }
  }

  throw new Error(`All Solana RPC endpoints in the failover pool failed. Last error: ${lastError?.message || "unknown"}`);
}
