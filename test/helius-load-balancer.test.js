import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "mock-key";
process.env.OLLAMA_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

const {
  discoverHeliusEndpoints,
  isHeliusRpcUrl,
  maskUrl,
  callRpcWithConnection,
  resetConnectionPools,
  getRpcHealthReport,
} = await import("../tools/rpc.js");

function restoreEnv(key, val) {
  if (val === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = val;
  }
}

test("isHeliusRpcUrl correctly identifies Helius hosts", () => {
  assert.equal(isHeliusRpcUrl("https://mainnet.helius-rpc.com/?api-key=abc"), true);
  assert.equal(isHeliusRpcUrl("https://beta.helius-rpc.com/?api-key=abc"), true);
  assert.equal(isHeliusRpcUrl("https://pump.helius-rpc.com"), true);
  assert.equal(isHeliusRpcUrl("https://api.mainnet-beta.solana.com"), false);
  assert.equal(isHeliusRpcUrl("https://solana-rpc.example.com"), false);
  assert.equal(isHeliusRpcUrl("not a url"), false);
});

test("discoverHeliusEndpoints discovers keys from multiple environment sources and preserves query params", () => {
  const origRpcUrl = process.env.RPC_URL;
  const origHeliusKeys = process.env.HELIUS_API_KEYS;
  const origKey = process.env.HELIUS_API_KEY;
  const origKeyAlt = process.env.HELIUS_API_KEY_ALT;
  const origKeyFallback = process.env.HELIUS_API_KEY_FALLBACK;

  try {
    // Case 1: RPC_URL with rebate-address and key in query + HELIUS_API_KEY_ALT + comma-separated list
    process.env.RPC_URL = "https://mainnet.helius-rpc.com/?api-key=key_alpha_1111&rebate-address=MyAgentWallet123";
    process.env.HELIUS_API_KEY_ALT = "key_beta_2222";
    process.env.HELIUS_API_KEYS = "key_gamma_3333, key_delta_4444";
    delete process.env.HELIUS_API_KEY;
    delete process.env.HELIUS_API_KEY_FALLBACK;

    const endpoints = discoverHeliusEndpoints();
    assert.equal(endpoints.length, 4);

    // Verify all endpoints have the rebate-address query param preserved
    for (const ep of endpoints) {
      assert.ok(ep.includes("rebate-address=MyAgentWallet123"), `Endpoint ${ep} should retain rebate-address`);
      assert.ok(ep.startsWith("https://mainnet.helius-rpc.com/?api-key="), `Endpoint ${ep} should have correct base and api-key`);
    }

    // Verify all 4 keys are present
    const foundKeys = endpoints.map((ep) => new URL(ep).searchParams.get("api-key"));
    assert.ok(foundKeys.includes("key_alpha_1111"));
    assert.ok(foundKeys.includes("key_beta_2222"));
    assert.ok(foundKeys.includes("key_gamma_3333"));
    assert.ok(foundKeys.includes("key_delta_4444"));
  } finally {
    restoreEnv("RPC_URL", origRpcUrl);
    restoreEnv("HELIUS_API_KEYS", origHeliusKeys);
    restoreEnv("HELIUS_API_KEY", origKey);
    restoreEnv("HELIUS_API_KEY_ALT", origKeyAlt);
    restoreEnv("HELIUS_API_KEY_FALLBACK", origKeyFallback);
  }
});

test("maskUrl preserves safe 4-character key fingerprint", () => {
  const urlWithKey = "https://mainnet.helius-rpc.com/?api-key=abcdef123456&rebate-address=Wallet123";
  const masked = maskUrl(urlWithKey);
  assert.equal(masked, "https://mainnet.helius-rpc.com/ [..3456]");

  const urlWithoutKey = "https://api.mainnet-beta.solana.com/";
  assert.equal(maskUrl(urlWithoutKey), "https://api.mainnet-beta.solana.com/");
});

test("callRpcWithConnection equally distributes load across multiple Helius keys via round-robin", async () => {
  const origRpcUrl = process.env.RPC_URL;
  const origHeliusKeys = process.env.HELIUS_API_KEYS;

  try {
    process.env.RPC_URL = "https://mainnet.helius-rpc.com/?api-key=helius_key_a111";
    process.env.HELIUS_API_KEYS = "helius_key_b222";
    resetConnectionPools();

    const usedUrls = [];
    const dummyOp = async (conn) => {
      // Simulate successful call
      return "ok";
    };

    // Execute 10 RPC calls
    for (let i = 0; i < 10; i++) {
      const { url } = await callRpcWithConnection(dummyOp, { method: "getSlot" });
      usedUrls.push(url);
    }

    console.log("usedUrls in test:", usedUrls);
    const countKeyA = usedUrls.filter((u) => u.includes("helius_key_a111")).length;
    const countKeyB = usedUrls.filter((u) => u.includes("helius_key_b222")).length;

    // Both should receive exactly 5 calls (50/50 distribution)
    assert.equal(countKeyA, 5, `Key A should receive 5 calls, got ${countKeyA}`);
    assert.equal(countKeyB, 5, `Key B should receive 5 calls, got ${countKeyB}`);

    // Alternation check: consecutive calls should alternate
    for (let i = 0; i < 9; i++) {
      assert.notEqual(usedUrls[i], usedUrls[i + 1], `Calls ${i} and ${i + 1} should alternate between endpoints`);
    }

    // Check health report observability
    const healthReport = getRpcHealthReport();
    const heliusEntries = healthReport.filter((r) => r.pool === "standard" && r.url.includes("helius-rpc.com"));
    assert.equal(heliusEntries.length, 2, "Health report should display both Helius keys");
    for (const entry of heliusEntries) {
      assert.equal(entry.totalCalls, 5, `Each Helius key should show 5 calls in health report`);
    }
  } finally {
    restoreEnv("RPC_URL", origRpcUrl);
    restoreEnv("HELIUS_API_KEYS", origHeliusKeys);
    resetConnectionPools();
  }
});

test("callRpcWithConnection fails over smoothly if one Helius key is rate limited (429)", async () => {
  const origRpcUrl = process.env.RPC_URL;
  const origHeliusKeys = process.env.HELIUS_API_KEYS;

  try {
    process.env.RPC_URL = "https://mainnet.helius-rpc.com/?api-key=helius_key_a111";
    process.env.HELIUS_API_KEYS = "helius_key_b222";
    resetConnectionPools();

    let callCount = 0;
    const dummyOp = async (conn) => {
      callCount++;
      // If called on Key A, simulate 429 rate limit
      if (conn._rpcEndpoint?.includes("helius_key_a111")) {
        const err = new Error("429 Too Many Requests");
        err.code = 429;
        throw err;
      }
      return "ok_from_b";
    };

    // First call: Key A will be tried first, fail with 429, then fail over to Key B
    const res1 = await callRpcWithConnection(dummyOp, { method: "getSlot" });
    assert.equal(res1.result, "ok_from_b");
    assert.ok(res1.url.includes("helius_key_b222"));

    // Second call: Key A is now in rate-limit cooldown, so Key B should be chosen immediately
    const res2 = await callRpcWithConnection(dummyOp, { method: "getSlot" });
    assert.equal(res2.result, "ok_from_b");
    assert.ok(res2.url.includes("helius_key_b222"));
  } finally {
    restoreEnv("RPC_URL", origRpcUrl);
    restoreEnv("HELIUS_API_KEYS", origHeliusKeys);
    resetConnectionPools();
  }
});
