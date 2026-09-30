process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// SI-SOL 2026-09-30: the Meteora UI created 6new4bEw in one transaction at 11:35:03,
// the WebSocket hint arrived at 11:35:03.97, the owner-index scan it triggered came
// back without the account, and adoption waited for the 5-minute full scan (11:40:22).
const { notePositionHint, hasPendingPositionHints } = await import("../tools/pnl.js");

test("a hinted address stays pending until a discovery scan confirms it", () => {
  assert.equal(hasPendingPositionHints(), false);
  notePositionHint("6new4bEwmnRgjCu2qkoYFbPz3xssrRfkMotXERcSzdrj");
  assert.equal(hasPendingPositionHints(), true);
});

test("discovery reads hinted accounts directly, owner-checked, and keeps confirmed ones", () => {
  const src = fs.readFileSync(new URL("../tools/pnl.js", import.meta.url), "utf8");
  assert.match(src, /addresses: \[\.\.\.next, \.\.\.hinted\]/, "hinted accounts join the account read");
  assert.match(src, /added: \[\.\.\.added, \.\.\.hinted\]/, "a hint forces a rebuild");
  assert.match(src, /requireOwnerFor\?\.has\(address\.toBase58\(\)\) && wrapper\.owner\(\)\?\.toBase58\?\.\(\) !== requireOwner/);
  assert.match(src, /_positionDiscovery\.addresses\.add\(address\)/, "a confirmed hint survives incremental rebuilds");
});

test("the socket notes unknown accounts before the hint cooldown; discovery retries while pending", () => {
  const sock = fs.readFileSync(new URL("../tools/socket-monitor.js", import.meta.url), "utf8");
  const handler = sock.slice(sock.indexOf("function handlePositionProgramAccountChange"));
  assert.ok(handler.indexOf("notePositionHint(address)") < handler.indexOf("POSITION_DISCOVERY_HINT_COOLDOWN_MS"));
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /else if \(hasPendingPositionHints\(\)\) \{[\s\S]{0,200}queuePnlDiscovery\(5_000\)/);
});
