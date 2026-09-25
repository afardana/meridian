process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";
import { test } from "node:test";
import assert from "node:assert/strict";
const { trackPosition, registerExitSignal, confirmPeak, getTrackedPosition, ensureStateInitialized } = await import("../state.js");
await ensureStateInitialized?.();

test("stale (repeated) valuations do not advance exit-signal confirmation", () => {
  const addr = "FRESHTEST111111111111111111111111111111111111";
  trackPosition({ position: addr, pool: "POOL", pool_name: "T-SOL", base_mint: "MINT_T", amount_sol: 1, amount_x: 0, strategy: "spot" });
  let r = registerExitSignal(addr, "TRAILING_TP", 2, { a: 1 }, { fresh: true });
  assert.equal(r.fire, false); assert.equal(r.count, 1);
  r = registerExitSignal(addr, "TRAILING_TP", 2, { a: 1 }, { fresh: false });
  assert.equal(r.fire, false); assert.equal(r.count, 1); assert.equal(r.stale, true);
  r = registerExitSignal(addr, "TRAILING_TP", 1, { a: 1 }, { fresh: false }); // even confirm=1 never fires on a stale tick
  assert.equal(r.fire, false);
  r = registerExitSignal(addr, "TRAILING_TP", 2, { a: 1 }, { fresh: true });
  assert.equal(r.fire, true); assert.equal(r.count, 2);
});
