import { Connection, PublicKey } from "@solana/web3.js";

const NORMAL_RPC = "https://mainnet.helius-rpc.com/?api-key=51d82335-85b5-4456-b25c-91ce855e0cba";
const BETA_RPC = "https://solana-mainnet.g.alchemy.com/v2/Tumyd6J9BKdCyI9beDFDb";

const TEST_TX = "2smRnHQmTYjfFVqm2rdmvTcxUdj4qfHtKHwUXkhW8S32jJuY7Upma5obfWf3CaRozhkgUZTQGcpsofdgNEuFCywD";

async function measureLatency(name, rpcUrl) {
  const connection = new Connection(rpcUrl, "confirmed");
  const latencies = [];
  
  console.log(`Testing ${name}...`);
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    try {
      await connection.getSlot();
      const duration = performance.now() - start;
      latencies.push(duration);
    } catch (err) {
      console.error(`  ${name} getSlot failed: ${err.message}`);
    }
  }

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  console.log(`  ${name} getSlot Avg: ${avg.toFixed(2)}ms | Min: ${min.toFixed(2)}ms | Max: ${max.toFixed(2)}ms (success: ${latencies.length}/10)`);
  return { avg, min, max, success: latencies.length };
}

async function measureTxFetch(name, rpcUrl) {
  const connection = new Connection(rpcUrl, "confirmed");
  const latencies = [];
  
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    try {
      await connection.getParsedTransaction(TEST_TX, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed"
      });
      const duration = performance.now() - start;
      latencies.push(duration);
    } catch (err) {
      console.error(`  ${name} getParsedTransaction failed: ${err.message}`);
    }
  }

  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  console.log(`  ${name} getParsedTransaction Avg: ${avg.toFixed(2)}ms | Min: ${min.toFixed(2)}ms | Max: ${max.toFixed(2)}ms`);
  return { avg, min, max };
}

async function testRateLimits(name, rpcUrl) {
  const connection = new Connection(rpcUrl, "confirmed");
  console.log(`Testing rate limit resilience for ${name} (fetching 25 transactions sequentially with no delay)...`);
  
  let successCount = 0;
  let error429Count = 0;
  const start = performance.now();

  for (let i = 0; i < 25; i++) {
    try {
      await connection.getParsedTransaction(TEST_TX, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed"
      });
      successCount++;
    } catch (err) {
      if (err.message.includes("429") || err.message.includes("Too Many Requests")) {
        error429Count++;
      } else {
        console.error(`  ${name} error: ${err.message}`);
      }
    }
  }

  const duration = performance.now() - start;
  console.log(`  ${name} Rate Limit Results:`);
  console.log(`    Success: ${successCount}/25`);
  console.log(`    429 Rate Limits: ${error429Count}`);
  console.log(`    Total Time: ${duration.toFixed(2)}ms`);
  return { successCount, error429Count, duration };
}

async function main() {
  console.log("=== SOLANA RPC COMPARISON: HELIUS NORMAL VS BETA GATEKEEPER ===\n");
  
  // 1. Measure getSlot Latency
  const normalSlot = await measureLatency("Helius Mainnet (Normal)", NORMAL_RPC);
  const betaSlot = await measureLatency("Helius Gatekeeper (Beta)", BETA_RPC);
  console.log();

  // 2. Measure getParsedTransaction Latency
  const normalTx = await measureTxFetch("Helius Mainnet (Normal)", NORMAL_RPC);
  const betaTx = await measureTxFetch("Helius Gatekeeper (Beta)", BETA_RPC);
  console.log();

  // 3. Test sequential requests rate limits
  const normalRL = await testRateLimits("Helius Mainnet (Normal)", NORMAL_RPC);
  console.log();
  const betaRL = await testRateLimits("Helius Gatekeeper (Beta)", BETA_RPC);
  console.log();

  console.log("=== SUMMARY ===");
  console.log(`Slot Latency improvement: ${((normalSlot.avg - betaSlot.avg) / normalSlot.avg * 100).toFixed(1)}% (${normalSlot.avg.toFixed(1)}ms -> ${betaSlot.avg.toFixed(1)}ms)`);
  console.log(`Tx Fetch Latency improvement: ${((normalTx.avg - betaTx.avg) / normalTx.avg * 100).toFixed(1)}% (${normalTx.avg.toFixed(1)}ms -> ${betaTx.avg.toFixed(1)}ms)`);
  console.log(`Normal 429 count: ${normalRL.error429Count} | Beta 429 count: ${betaRL.error429Count}`);
}

main().catch(console.error);
