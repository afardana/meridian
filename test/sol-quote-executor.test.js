process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

// SOL-quote rule, executor layer (2026-10-11): deploy_position is refused when the pool's
// token Y is not wrapped SOL — CLAUDIA-USDC reached the deployer with "0.4 Y" meaning USDC.
import { test } from "node:test";
import assert from "node:assert/strict";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const POOL = "ATe287quS14THv5SjdCbXvBhNaPHepoytjdhHCJJ8Syd";

const { executeTool } = await import("../tools/executor.js");

// The executor reads the pool row fresh from the discovery API; serve it from here.
const realFetch = globalThis.fetch;
let row = null;
let discoveryCalls = 0;
function stubDiscovery() {
  discoveryCalls = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).includes("pool-discovery-api")) throw new Error(`unexpected fetch in test: ${url}`);
    discoveryCalls++;
    return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: row ? [row] : [] }) };
  };
}
const healthy = (token_x, token_y) => ({
  pool_address: POOL, name: `${token_x.symbol}-${token_y.symbol}`, pool_type: "dlmm", token_x, token_y,
  tvl: 250_000, active_tvl: 200_000, volume: 400_000, fee_active_tvl_ratio: 0.9, swap_count: 6000,
  volatility: 2.1, dlmm_params: { bin_step: 100 },
});
const deployArgs = { pool_address: POOL, pool_name: "CLAUDIA-USDC", amount_y: 0.4, bins_below: 62, bins_above: 0 };

test("deploy_position into a USDC-quoted pool is blocked with the quote reason", async () => {
  row = healthy({ symbol: "CLAUDIA", address: "2j5SaSCLAUDIA" }, { symbol: "USDC", address: USDC, decimals: 6 });
  stubDiscovery();
  try {
    const res = await executeTool("deploy_position", { ...deployArgs });
    assert.equal(res.blocked, true);
    assert.match(res.reason, /CLAUDIA-USDC quote token is not SOL \(USDC\)/);
    assert.match(res.reason, /only SOL-quoted pools/);
    assert.equal(discoveryCalls, 1, "refused on the first pool read, before any other threshold");
  } finally { globalThis.fetch = realFetch; }
});

test("SOL as token X (SOL-USDC) is blocked too", async () => {
  row = healthy({ symbol: "SOL", address: SOL }, { symbol: "USDC", address: USDC });
  stubDiscovery();
  try {
    const res = await executeTool("deploy_position", { ...deployArgs, pool_name: "SOL-USDC" });
    assert.equal(res.blocked, true);
    assert.match(res.reason, /quote token is not SOL \(USDC; SOL is the base token\)/);
  } finally { globalThis.fetch = realFetch; }
});

test("a pool row without a token Y mint fails closed", async () => {
  row = healthy({ symbol: "X", address: "XMint" }, { symbol: "SOL" });
  stubDiscovery();
  try {
    const res = await executeTool("deploy_position", { ...deployArgs, pool_name: "X-SOL" });
    assert.equal(res.blocked, true);
    assert.match(res.reason, /quote token mint unknown/);
  } finally { globalThis.fetch = realFetch; }
});

test("a SOL-quoted pool passes the quote rule (it is refused later, for an unrelated reason)", async () => {
  // Same row, SOL as token Y, but a bin step outside every configured band: the block must
  // come from that later check, i.e. the quote rule let the pool through.
  row = { ...healthy({ symbol: "X", address: "XMint" }, { symbol: "SOL", address: SOL }), dlmm_params: { bin_step: 1 } };
  stubDiscovery();
  try {
    const res = await executeTool("deploy_position", { ...deployArgs, pool_name: "X-SOL" });
    assert.equal(res.blocked, true);
    assert.doesNotMatch(res.reason, /quote token/);
    assert.match(res.reason, /bin_step 1 is below configured minBinStep/);
  } finally { globalThis.fetch = realFetch; }
});
