process.env.OPENAI_API_KEY = "mock-key";
process.env.OPENROUTER_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import assert from "node:assert/strict";
import fs from "node:fs";

console.log("=== Thin-pool hold limit: per-position exemption ===");

const { holdThinLimitReading, holdThinLimitCardFields, parseThinLimitExemptBody, thinLimitExemptRefusal } = await import("../hold-thin-limit.js");
const { holdOverrideActive } = await import("../hold-override.js");
const S = await import("../state.js");
await S.ensureStateInitialized();

const SEC = 1000;
const T0 = Date.parse("2026-10-11T03:00:00Z");
const m = { holdThinPoolLimitMode: "enforce" };
let seq = 0;
const mk = (tag, { hold = true, entry_tvl = 42622.68 } = {}) => {
  const addr = `TEST_THIN_EXEMPT_${tag}_${Date.now()}_${seq++}`;
  S.trackPosition({ position: addr, pool: "POOL_TE_" + tag, pool_name: tag + "-SOL", amount_sol: 1.48, strategy: "spot", entry_tvl, bin_step: 100 });
  if (hold) S.setPositionHold(addr, true);
  return addr;
};
const pos = (a) => S.getTrackedPosition(a);
const row = (pnl, bin) => ({ pnl_pct: pnl, active_bin: bin, pnl_basis: "sol", pnl_management_ready: true, total_value_usd: 100 + pnl });
const feed = (a, pnl, bin, t) => S.noteHoldThinLimitReading(a, holdThinLimitReading(row(pnl, bin), pos(a)), m, { nowMs: T0 + t * SEC });
// A full qualifying sequence: above the limit, a plausible crossing, then held under for 70 s.
const sequence = (a) => [feed(a, -20, 10, 0), feed(a, -26, 3, 5), feed(a, -27, 2, 40), feed(a, -28, 1, 75), feed(a, -30, 0, 110)];

// ── Un-exempt: fires as before ────────────────────────────────────────────────────────
{
  const a = mk("PLAIN");
  assert.equal(pos(a).hold_thin_limit_exempt ?? false, false);
  const r = sequence(a);
  assert.deepEqual(r.map((x) => x.event), ["above", "started", "counted", "counted", "counted"]);
  assert.equal(r[3].ready, true);
  assert.equal(S.noteHoldThinLimitMark(a, {}, { confirm: true }), true);
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), true);
  S.recordClose(a, "test");
}

// ── Exempt: never a reference, a streak, a ready verdict or a stamp ───────────────────
{
  const a = mk("EX");
  assert.equal(S.setHoldThinLimitExempt(a, true), true);
  assert.equal(pos(a).hold_thin_limit_exempt, true);
  assert.ok(pos(a).hold_thin_limit_exempt_at);
  const r = sequence(a);
  assert.deepEqual(r.map((x) => x.event), ["exempt", "exempt", "exempt", "exempt", "exempt"]);
  assert.deepEqual(r.map((x) => x.first_exempt), [true, false, false, false, false]); // logged once
  assert.ok(r.every((x) => x.ready === false && x.streak === null && x.thin === true));
  assert.equal(pos(a).hold_thin_limit, null);
  assert.equal(S.noteHoldThinLimitMark(a, {}, { confirm: true }), false); // nothing to stamp
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), false);
  assert.equal(pos(a).hold_mode, true);

  // Cleared by the operator: the rule is back, from a fresh reference.
  assert.equal(S.setHoldThinLimitExempt(a, false), true);
  assert.equal(pos(a).hold_thin_limit_exempt, false);
  assert.equal(pos(a).hold_thin_limit_exempt_at, null);
  assert.equal(sequence(a)[3].ready, true);

  // Setting it mid-streak drops the streak and an authorisation already stamped.
  assert.equal(S.noteHoldThinLimitMark(a, {}, { confirm: true }), true);
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), true);
  S.setHoldThinLimitExempt(a, true);
  assert.equal(pos(a).hold_thin_limit, null);
  assert.equal(holdOverrideActive(pos(a), m, "hold_limit"), false);
  assert.equal(feed(a, -40, 0, 200).first_exempt, true); // a new exemption is logged once again

  // Hold release clears it; a later hold starts un-exempt and fires as before.
  S.setPositionHold(a, false);
  assert.equal(pos(a).hold_thin_limit_exempt, false);
  assert.equal(pos(a).hold_thin_limit_exempt_at, null);
  S.setPositionHold(a, true);
  assert.equal(pos(a).hold_thin_limit_exempt, false);
  assert.equal(sequence(a)[3].ready, true);

  // A repeated hold on an already-held position (new reason) keeps the exemption.
  S.setHoldThinLimitExempt(a, true);
  S.setPositionHold(a, true, "again");
  assert.equal(pos(a).hold_thin_limit_exempt, true);

  // Close clears it; a closed or unknown position cannot be switched.
  S.recordClose(a, "test close");
  assert.equal(pos(a).hold_thin_limit_exempt, false);
  assert.equal(S.setHoldThinLimitExempt(a, true), false);
  assert.equal(S.setHoldThinLimitExempt("NOPE_" + Date.now(), true), false);
}

// ── The TVL exit does not read the exemption ──────────────────────────────────────────
{
  const tvl = fs.readFileSync(new URL("../tvl-floor-exit.js", import.meta.url), "utf8");
  assert.doesNotMatch(tvl, /hold_thin_limit_exempt/);
  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const fn = idx.slice(idx.indexOf("async function checkTvlFloorExit"), idx.indexOf("function checkHoldThinLimit"));
  assert.ok(fn.length > 500);
  assert.doesNotMatch(fn, /exempt/);
  assert.match(idx, /if \(res\.event === "exempt"\) \{\s*if \(res\.first_exempt\) log\("hold_thin_limit", `\[HOLD_THIN_LIMIT\] \$\{p\.pair\}: exempt by the operator`\);\s*return null;/);
}

// ── Endpoint: input validation (400) and refusals (404 / 409) ─────────────────────────
{
  const ADDR = "9Zy1FnQm3o1wYkq2aXh5c7T8uVbN4rDsEfGhJkLmNpQr";
  assert.deepEqual(parseThinLimitExemptBody({ position: ` ${ADDR} `, exempt: true }), { ok: true, position: ADDR, exempt: true });
  assert.deepEqual(parseThinLimitExemptBody({ position: ADDR, exempt: false }), { ok: true, position: ADDR, exempt: false });
  for (const bad of [{}, { exempt: true }, { position: "short", exempt: true }, { position: 5, exempt: true }, { position: ADDR.replace("9", "0"), exempt: true }]) {
    const r = parseThinLimitExemptBody(bad);
    assert.equal(r.ok, false);
    assert.match(r.error, /`position`/);
  }
  for (const bad of [undefined, null, "true", 1, 0]) {
    assert.deepEqual(parseThinLimitExemptBody({ position: ADDR, exempt: bad }), { ok: false, error: "`exempt` must be a boolean" });
  }

  assert.deepEqual(thinLimitExemptRefusal(null, m), { status: 404, error: "Position is not open in the bot" });
  assert.equal(thinLimitExemptRefusal({ closed: true, hold_mode: true, entry_tvl: 5000 }, m).status, 404);
  const notHeld = thinLimitExemptRefusal({ hold_mode: false, entry_tvl: 42622 }, m);
  assert.equal(notHeld.status, 409);
  assert.match(notHeld.error, /not on hold/);
  const deep = thinLimitExemptRefusal({ hold_mode: true, entry_tvl: 336184 }, m);
  assert.equal(deep.status, 409);
  assert.match(deep.error, /not a thin-pool position — pool TVL at entry \$336,184 is at or above the \$100,000 bar/);
  const unknown = thinLimitExemptRefusal({ hold_mode: true, entry_tvl: null }, m);
  assert.equal(unknown.status, 409);
  assert.match(unknown.error, /not a thin-pool position — its pool TVL at entry is unknown/);
  assert.equal(thinLimitExemptRefusal({ hold_mode: true, entry_tvl: 42622 }, m), null);
  // On tracked positions, too.
  const held = mk("EP"), free = mk("EPF", { hold: false }), big = mk("EPB", { entry_tvl: 336184 });
  assert.equal(thinLimitExemptRefusal(pos(held), m), null);
  assert.equal(thinLimitExemptRefusal(pos(free), m).status, 409);
  assert.equal(thinLimitExemptRefusal(pos(big), m).status, 409);
  for (const a of [held, free, big]) S.recordClose(a, "test");

  const idx = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(idx, /req\.method === "POST" && url === "\/command\/set-thin-limit-exempt"/);
  const h = idx.slice(idx.indexOf("async function handleCommandSetThinLimitExempt"), idx.indexOf("async function runLimitOrderClose"));
  assert.match(h, /req\.headers\["x-meridian-token"\] !== COMMAND_TOKEN/);
  assert.match(h, /if \(!input\.ok\) return commandJson\(res, 400,/);
  assert.match(h, /if \(refusal\) return commandJson\(res, refusal\.status,/);
  assert.match(h, /success: true,\s*position: input\.position,\s*pair: tracked\.pool_name \?\? null,\s*exempt: input\.exempt,/);
  assert.doesNotMatch(h, /executeTool|closePosition|sendHTML/); // no transaction, no message
}

// ── Card fields: position scan + dashboard-report doc ─────────────────────────────────
{
  const FIELDS = ["thin_pool", "entry_tvl_usd", "hold_thin_limit_exempt", "hold_thin_limit_pct", "hold_thin_limit_mode"];
  assert.deepEqual(holdThinLimitCardFields({ entry_tvl: 42622.68, hold_thin_limit_exempt: true }, {}),
    { thin_pool: true, entry_tvl_usd: 42622.68, hold_thin_limit_exempt: true, hold_thin_limit_pct: -25, hold_thin_limit_mode: "enforce" });
  assert.deepEqual(holdThinLimitCardFields({ entry_tvl: 336184 }, { holdThinPoolLimitMode: "shadow", holdThinPoolLimitPct: -30 }),
    { thin_pool: false, entry_tvl_usd: 336184, hold_thin_limit_exempt: false, hold_thin_limit_pct: -30, hold_thin_limit_mode: "shadow" });
  assert.deepEqual(holdThinLimitCardFields(null, { holdThinPoolLimitMode: "off" }),
    { thin_pool: false, entry_tvl_usd: null, hold_thin_limit_exempt: false, hold_thin_limit_pct: -25, hold_thin_limit_mode: "off" });
  assert.deepEqual(Object.keys(holdThinLimitCardFields({}, {})), FIELDS);

  const pnl = fs.readFileSync(new URL("../tools/pnl.js", import.meta.url), "utf8");
  assert.match(pnl, /hold_peak_pnl_pct: [^\n]+\n[\s\S]{0,260}\.\.\.holdThinLimitCardFields\(tracked, config\.management\),/);

  const rep = fs.readFileSync(new URL("../report.js", import.meta.url), "utf8");
  assert.match(rep, /hold_peak_pnl_pct: [^\n]+\n\s*\.\.\.reportThinLimitFields\(p\),/); // inside posOut
  const { reportThinLimitFields } = await import("../report.js");
  const scanRow = (tracked) => ({ pair: "T-SOL", pnl_pct: -3, ...holdThinLimitCardFields(tracked, {}) });
  const out = [scanRow({ entry_tvl: 42622.68, hold_thin_limit_exempt: true }), scanRow({ entry_tvl: 336184 }), { pair: "BARE-SOL" }].map((p) => reportThinLimitFields(p, {}));
  for (const p of out) assert.deepEqual(Object.keys(p), FIELDS);
  assert.deepEqual(FIELDS.map((k) => out[0][k]), [true, 42622.68, true, -25, "enforce"]);
  assert.deepEqual(FIELDS.map((k) => out[1][k]), [false, 336184, false, -25, "enforce"]);
  assert.deepEqual(FIELDS.map((k) => out[2][k]), [false, null, false, -25, "enforce"]); // a row without the fields: safe defaults
  assert.equal(reportThinLimitFields({}, { holdThinPoolLimitMode: "shadow", holdThinPoolLimitPct: -30 }).hold_thin_limit_mode, "shadow");
}

// ── Telegram texts name the control ───────────────────────────────────────────────────
{
  const I = await import("../index.js");
  const { sanitizeTelegramHTML } = await import("../telegram.js");
  const a = I.thinPoolAdoptionAlertText({ pair: "F-SOL", amountSol: 1, entryTvlUsd: 42622.68, mgmt: {} });
  assert.match(a, /closes it at -25% PnL \(you can exempt it from the dashboard card\)/);
  assert.doesNotMatch(I.thinPoolAdoptionAlertText({ pair: "F-SOL", amountSol: 1, entryTvlUsd: 42622.68, mgmt: { holdThinPoolLimitMode: "shadow" } }), /exempt/);
  const v = { rule: "stop_loss", threshold_pct: -15, pnl_pct: -15.4 };
  const b = I.holdDownsideAlertText({ pair: "F-SOL", verdict: v, heldMin: 3, tracked: { entry_tvl: 42622.68 }, mgmt: {} });
  assert.match(b, /closes it at -25% — exempt it from the dashboard card to keep holding\./);
  const bx = I.holdDownsideAlertText({ pair: "F-SOL", verdict: v, heldMin: 3, tracked: { entry_tvl: 42622.68, hold_thin_limit_exempt: true }, mgmt: {} });
  assert.match(bx, /exempt from the -25% thin-pool limit \(dashboard card\) — it will not be closed there\./);
  assert.doesNotMatch(bx, /closes it at/);
  for (const t of [a, b, bx]) assert.equal(sanitizeTelegramHTML(t), t);
}

console.log("OK — thin-pool hold limit exemption");
process.exit(0);
