process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Hands-off on a held position (no rule overrides the hold) ===");

const H = await import("../hands-off.js");
const { handsOffActive, handsOffUntil, parseHandsOffBody, validateHandsOffUntil, handsOffRefusal, heldPositionAction, handsOffCardFields, handsOffRowSuffix, HANDS_OFF_MAX_MS } = H;
const { holdOverrideActive } = await import("../hold-override.js");
const { holdThinLimitReading } = await import("../hold-thin-limit.js");
const S = await import("../state.js");
await S.ensureStateInitialized();

const SEC = 1000, MIN = 60_000, HOUR = 3_600_000;
const m = { holdThinPoolLimitMode: "enforce", tvlFloorExitMode: "enforce" };
let seq = 0;
const mk = (tag, { hold = true, entry_tvl = 42622.68 } = {}) => {
  const addr = `TEST_HANDS_OFF_${tag}_${Date.now()}_${seq++}`;
  S.trackPosition({ position: addr, pool: "POOL_HO_" + tag, pool_name: tag + "-SOL", amount_sol: 1.48, strategy: "spot", entry_tvl, bin_step: 100 });
  if (hold) S.setPositionHold(addr, true);
  return addr;
};
const pos = (a) => S.getTrackedPosition(a);
const inH = (h) => new Date(Date.now() + h * HOUR).toISOString();

// ── Pure helper ───────────────────────────────────────────────────────────────────────
{
  const now = Date.parse("2026-11-27T13:00:00Z");
  const until = "2026-11-28T00:00:00Z";
  assert.equal(handsOffActive({ hold_mode: true, hands_off_until: until }, now), true);
  assert.equal(handsOffActive({ hold_mode: false, hands_off_until: until }, now), false);      // released: no effect
  assert.equal(handsOffActive({ hold_mode: true, hands_off_until: until, closed: true }, now), false);
  assert.equal(handsOffActive({ hold_mode: true, hands_off_until: until }, Date.parse(until)), false); // expired
  assert.equal(handsOffActive({ hold_mode: true, hands_off_until: "garbage" }, now), false);
  assert.equal(handsOffActive({ hold_mode: true }, now), false);
  assert.equal(handsOffActive(null, now), false);
  assert.equal(handsOffUntil({ hold_mode: true, hands_off_until: until }, now), "2026-11-28T00:00:00.000Z");
  assert.deepEqual(handsOffCardFields({ hold_mode: true, hands_off_until: until }, now), { hands_off_until: "2026-11-28T00:00:00.000Z" });
  assert.deepEqual(handsOffCardFields({ hold_mode: false, hands_off_until: until }, now), { hands_off_until: null });
  const late = Date.parse("2026-11-27T20:00:00Z"); // 03:00 WIB on 28 Nov
  assert.equal(handsOffRowSuffix({ hold_mode: true, hands_off_until: until }, late), " · hands-off until 07:00 WIB"); // same WIB day
  assert.equal(handsOffRowSuffix({ hold_mode: true, hands_off_until: until }, now), " · hands-off until 28 Nov 07:00 WIB"); // next WIB day
  assert.equal(handsOffRowSuffix({ hold_mode: false, hands_off_until: until }, now), "");
  // validation
  assert.equal(validateHandsOffUntil(null, now).ok, true);
  assert.equal(validateHandsOffUntil(now - 1, now).ok, false);
  assert.equal(validateHandsOffUntil(now, now).ok, false);
  assert.equal(validateHandsOffUntil(now + HANDS_OFF_MAX_MS, now).ok, true);
  assert.equal(validateHandsOffUntil(now + HANDS_OFF_MAX_MS + 1, now).ok, false);
  assert.equal(validateHandsOffUntil(NaN, now).ok, false);
  // refusals
  assert.equal(handsOffRefusal(null).status, 404);
  assert.equal(handsOffRefusal({ closed: true, hold_mode: true }).status, 404);
  assert.equal(handsOffRefusal({ hold_mode: false }).status, 409);
  assert.equal(handsOffRefusal({ hold_mode: false }, { clearing: true }), null);
  assert.equal(handsOffRefusal({ hold_mode: true }), null);
  // CLAIM → STAY
  const held = { hold_mode: true, hands_off_until: until };
  assert.deepEqual(heldPositionAction({ hold_mode: true }, 5, 1, now), { action: "CLAIM", hold_mode: true });
  assert.deepEqual(heldPositionAction({ hold_mode: true }, 0.5, 1, now), { action: "STAY", hold_mode: true });
  assert.deepEqual(heldPositionAction(held, 5, 1, now), { action: "STAY", hold_mode: true, hands_off: true });
  assert.deepEqual(heldPositionAction(held, 5, 1, Date.parse(until) + 1), { action: "CLAIM", hold_mode: true }); // expired
}

// ── Endpoint body ─────────────────────────────────────────────────────────────────────
{
  const ADDR = "WiNsToN1111111111111111111111111111111111";
  const now = Date.parse("2026-11-27T13:00:00Z");
  assert.deepEqual(parseHandsOffBody({ position: ` ${ADDR} `, until: "2026-11-28T00:00:00Z" }, now), { ok: true, position: ADDR, untilMs: Date.parse("2026-11-28T00:00:00Z") });
  assert.deepEqual(parseHandsOffBody({ position: ADDR, hours: 10 }, now), { ok: true, position: ADDR, untilMs: now + 10 * HOUR });
  assert.deepEqual(parseHandsOffBody({ position: ADDR, until: null }, now), { ok: true, position: ADDR, untilMs: null });
  assert.deepEqual(parseHandsOffBody({ position: ADDR, hours: 0 }, now), { ok: true, position: ADDR, untilMs: null });
  for (const bad of [
    { position: "nope", hours: 1 },
    { hours: 1 },
    { position: ADDR },                                       // neither
    { position: ADDR, until: "2026-11-28T00:00:00Z", hours: 1 }, // both
    { position: ADDR, until: "tomorrow-ish" },
    { position: ADDR, until: 12345 },
    { position: ADDR, hours: -1 },
    { position: ADDR, hours: "5" },
    { position: ADDR, hours: Infinity },
    { position: ADDR, until: "2026-11-27T12:00:00Z" },       // past
    { position: ADDR, hours: 7 * 24 + 1 },                   // > 7 days
  ]) {
    const r = parseHandsOffBody(bad, now);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(typeof r.error, "string");
  }
  assert.equal(parseHandsOffBody(null, now).ok, false);
}

// ── State: set / clear / validation ───────────────────────────────────────────────────
{
  const a = mk("SET");
  const r = S.setPositionHandsOff(a, inH(10));
  assert.equal(r.ok, true);
  assert.ok(pos(a).hands_off_until && pos(a).hands_off_set_at);
  assert.equal(handsOffActive(pos(a)), true);
  // past / too far / garbage → refused, stamp unchanged
  const keep = pos(a).hands_off_until;
  for (const bad of [inH(-1), inH(7 * 24 + 1), "not a time"]) {
    const x = S.setPositionHandsOff(a, bad);
    assert.equal(x.ok, false);
    assert.equal(x.status, 400);
    assert.equal(pos(a).hands_off_until, keep);
  }
  // clear
  assert.deepEqual(S.setPositionHandsOff(a, null).hands_off_until, null);
  assert.equal(pos(a).hands_off_until, null);
  assert.equal(pos(a).hands_off_set_at, null);
  assert.equal(handsOffActive(pos(a)), false);
  // not held → refused; unknown → 404
  const free = mk("FREE", { hold: false });
  const nf = S.setPositionHandsOff(free, inH(5));
  assert.equal(nf.ok, false);
  assert.equal(nf.status, 409);
  assert.equal(pos(free).hands_off_until ?? null, null);
  assert.equal(S.setPositionHandsOff("NOPE_" + Date.now(), inH(5)).status, 404);
  // release clears it; a stamp written onto a released position has no effect
  S.setPositionHandsOff(a, inH(10));
  S.setPositionHold(a, false);
  assert.equal(pos(a).hands_off_until, null);
  pos(a).hands_off_until = inH(10); // a leftover stamp on a released position
  assert.equal(handsOffActive(pos(a)), false);
  assert.equal(heldPositionAction(pos(a), 5, 1).hands_off, undefined);
  // close clears it
  const c = mk("CLOSE");
  S.setPositionHandsOff(c, inH(10));
  S.recordClose(c, "test cleanup");
  assert.equal(pos(c).hands_off_until, null);
  assert.equal(S.setPositionHandsOff(c, inH(1)).status, 404);
  S.recordClose(a, "test cleanup");
  S.recordClose(free, "test cleanup");
}

// ── Thin-pool hold limit: a sequence that fires does not fire with hands-off ──────────
{
  const row = (pnl, bin) => ({ pnl_pct: pnl, active_bin: bin, pnl_basis: "sol", pnl_management_ready: true, total_value_usd: 100 + pnl });
  const T0 = Date.now();
  const feed = (a, pnl, bin, t) => S.noteHoldThinLimitReading(a, holdThinLimitReading(row(pnl, bin), pos(a)), m, { nowMs: T0 + t * SEC });
  const sequence = (a) => [feed(a, -20, 10, 0), feed(a, -26, 3, 5), feed(a, -27, 2, 40), feed(a, -28, 1, 75), feed(a, -30, 0, 110)];

  const plain = mk("THIN_PLAIN");
  const rp = sequence(plain);
  assert.equal(rp[3].ready, true);                                  // fires without hands-off
  S.recordClose(plain, "test cleanup");

  const a = mk("THIN_HO");
  S.setPositionHandsOff(a, new Date(T0 + 30 * MIN).toISOString());
  const r = sequence(a);
  assert.deepEqual(r.map((x) => x.event), ["hands_off", "hands_off", "hands_off", "hands_off", "hands_off"]);
  assert.equal(r[0].first_hands_off, true);
  assert.equal(r.slice(1).some((x) => x.first_hands_off), false); // logged once
  assert.equal(r.some((x) => x.ready), false);
  assert.equal(pos(a).hold_thin_limit, null);
  assert.equal(S.noteHoldThinLimitMark(a, {}, { confirm: true }), false); // no streak to stamp
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), false);
  // a stale stamp still opens nothing while hands-off is in force
  pos(a).hold_thin_limit = { ref: null, streak: { count: 3, confirmed_at: new Date(T0).toISOString() } };
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit", T0 + SEC), false);
  pos(a).hold_thin_limit = null;
  // after expiry the same sequence closes as before (the expired stamp is cleared lazily)
  const late = 31 * MIN / SEC;
  const r2 = [feed(a, -20, 10, late), feed(a, -26, 3, late + 5), feed(a, -27, 2, late + 40), feed(a, -28, 1, late + 75)];
  assert.equal(pos(a).hands_off_until, null);
  assert.equal(r2[3].ready, true);
  S.recordClose(a, "test cleanup");
}

// ── TVL exit: proof completes while hands-off → no exit, no stamp ─────────────────────
{
  const I = await import("../index.js");
  const { config } = await import("../config.js");
  const { tvlFloorExitConfig } = await import("../tvl-floor-exit.js");
  const prevMode = config.management.tvlFloorExitMode;
  config.management.tvlFloorExitMode = "enforce";
  const cfg = tvlFloorExitConfig(config.management);
  const below = (tvl) => ({ ok: true, tvl_usd: tvl });
  const chainLow = async () => ({ ok: true, tvl_usd: 5000 });
  const seed = (a) => {
    const now = Date.now();
    S.noteTvlFloorReading(a, below(9000), config.management, now - 7 * MIN);
    S.noteTvlFloorReading(a, below(8500), config.management, now - 3 * MIN);
  };
  const row = (a) => ({ position: a, pool: pos(a).pool, pair: pos(a).pool_name, pnl_pct: -40, tvl_floor_reading: below(8000) });

  const a = mk("TVL_HO");
  S.setPositionHandsOff(a, inH(8));
  seed(a);
  const ex = await I.checkTvlFloorExit(row(a), cfg, true, { chainTvl: chainLow });
  assert.equal(ex, null);
  assert.equal(pos(a).tvl_floor_exit.count, 3);                     // the streak stays truthful
  assert.equal(pos(a).tvl_floor_exit.confirmed_at ?? null, null);   // no HOLD-override stamp
  assert.equal(pos(a).tvl_floor_exit.alerted_at ?? null, null);     // no alert
  assert.ok(pos(a).tvl_floor_exit.hands_off_logged_at);             // logged once per streak
  assert.equal(holdOverrideActive(pos(a), config.management, "tvl_floor"), false);
  // a stale TVL stamp also opens nothing while hands-off is in force
  pos(a).tvl_floor_exit.confirmed_at = new Date().toISOString();
  assert.equal(holdOverrideActive(pos(a), config.management, "tvl_floor"), false);
  pos(a).tvl_floor_exit.confirmed_at = null;

  // after expiry the same proof closes as before
  pos(a).hands_off_until = new Date(Date.now() - SEC).toISOString();
  assert.equal(handsOffActive(pos(a)), false);
  pos(a).tvl_floor_exit.last_at = new Date(Date.now() - 2 * MIN).toISOString(); // next reading is a fresh "counted" one
  const ex2 = await I.checkTvlFloorExit(row(a), cfg, true, { chainTvl: chainLow });
  assert.equal(ex2?.action, "TVL_FLOOR");
  assert.equal(ex2.hold_override, "tvl_floor");
  assert.ok(pos(a).tvl_floor_exit.confirmed_at);
  assert.equal(holdOverrideActive(pos(a), config.management, "tvl_floor"), true);
  S.recordClose(a, "test cleanup");

  // control: no hands-off → closes on the first complete proof
  const b = mk("TVL_PLAIN");
  seed(b);
  const ex3 = await I.checkTvlFloorExit(row(b), cfg, true, { chainTvl: chainLow });
  assert.equal(ex3?.action, "TVL_FLOOR");
  S.recordClose(b, "test cleanup");
  config.management.tvlFloorExitMode = prevMode;
}

// ── Wiring ────────────────────────────────────────────────────────────────────────────
{
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const exe = fs.readFileSync(new URL("../tools/executor.js", import.meta.url), "utf8");
  const dlmm = fs.readFileSync(new URL("../tools/dlmm.js", import.meta.url), "utf8");
  const defs = fs.readFileSync(new URL("../tools/definitions.js", import.meta.url), "utf8");
  // the three HOLD guards all go through holdOverrideActive
  assert.match(idx, /holdOverrideActive\(heldNow, config\.management, act\.hold_override\)/);
  assert.match(exe, /tracked\?\.hold_mode === true && !holdOverrideActive\(tracked, config\.management, args\?\.hold_override\)/);
  assert.match(dlmm, /tracked\?\.hold_mode === true && _operator_override !== true && !holdOverrideActive\(tracked, config\.management, hold_override\)/);
  // management guard lets nothing but STAY through; claim_fees is refused in executeTool
  assert.match(idx, /handsOffActive\(heldNow\) && act\.action !== "STAY"/);
  assert.match(exe, /name === "claim_fees" && !operatorOverride && handsOffActive\(/);
  assert.match(idx, /heldPositionAction\(tracked, p\.unclaimed_fees_usd, holdClaimThresholdSol\)/);
  // endpoint, not an LLM tool, not a config key
  assert.match(idx, /url === "\/command\/set-hands-off"/);
  assert.doesNotMatch(defs, /hands_off|handsOff|hands-off/i);
  assert.doesNotMatch(exe, /handsOff[A-Za-z]*\s*:\s*\[/); // no CONFIG_MAP entry
}

console.log("OK — hands-off");
process.exit(0);
