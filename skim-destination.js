/**
 * Profit skimmer — the Telegram-set destination (2026-11-27, operator request; round 2 the
 * same day after an independent review). Pure except the injected orchestration at the end:
 * no RPC, no files, no clock unless passed in. I/O is in tools/transfer.js, wiring in index.js.
 *
 * Trust rule: the skim JOURNAL is the truth. Its newest `destination_change` line says which
 * address is in force (`to`, or null = back to .env), from when (`set_at`) and until when
 * the hold runs (`hold_until`); a later `destination_verified` line for that change marks it
 * verified. skim-destination.json is a copy that must match that line exactly (address,
 * set_at, hold_until, verified) — a mismatch, a file without any journal change line, or no
 * file while the journal has one refuses EVERYTHING (no fallback to .env). No change lines
 * and no file → .env, as before. The repair is the same two-step command again (a new line,
 * a fresh hold that never shortens the one in force).
 *
 * Hold: SKIM_ADDRESS_CHANGE_HOLD_HOURS (24; .env AUTO_SKIM_ADDRESS_HOLD_HOURS may only
 * lengthen it) after any change or reset; the hold in force is the max hold_until over every
 * journal change line. Test transfer: a Telegram-set address is unverified until
 * /skim address verified (needs a landed skim to it) — skims are capped at the minimum.
 *
 * Security trade-off (accepted by the operator): control of the Telegram chat is enough to
 * redirect a skim; the two-step code, the hold, the test transfer, the alert and the masked
 * echo compensate. Anything that can write the data dir can also append to the journal —
 * those actors can already read the wallet key.
 */
import { randomInt, timingSafeEqual } from "node:crypto";
import bs58 from "bs58";
import { checkSkimDestination, maskAddress, maskAddressesIn, testTransfersSince, SKIM_TEST_TRANSFER_SOL } from "./skim-policy.js";
import { fmtWib } from "./wib-time.js";

export const SKIM_ADDRESS_CHANGE_HOLD_HOURS = 24;
/** Upper bound for the env value, so hold_until stays a valid date (10 years). */
export const SKIM_ADDRESS_HOLD_MAX_HOURS = 87_600;
export const SKIM_ADDRESS_CHANGE_TTL_MS = 10 * 60 * 1000;
export const SKIM_ADDRESS_CODE_LENGTH = 6;
export const SKIM_ADDRESS_MAX_TRIES = 3;
/** No 0/O, 1/I/L: the code is read off a phone screen. */
export const SKIM_ADDRESS_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** first8…last8 — shown ONLY in the two private-chat replies (request, confirm). */
export function maskAddressLong(address) {
  const s = String(address ?? "");
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-8)}` : maskAddress(s);
}

/** Hold length in hours: the code constant, lengthened (never shortened) by .env AUTO_SKIM_ADDRESS_HOLD_HOURS. */
export function skimAddressHoldHours(env = {}) {
  const raw = env?.AUTO_SKIM_ADDRESS_HOLD_HOURS;
  const v = raw == null || raw === "" ? NaN : Number(raw);
  if (!Number.isFinite(v) || v <= SKIM_ADDRESS_CHANGE_HOLD_HOURS) return SKIM_ADDRESS_CHANGE_HOLD_HOURS;
  return Math.min(v, SKIM_ADDRESS_HOLD_MAX_HOURS);
}

/**
 * Format checks on an address the operator typed: base58, 32–44 characters, decodes to
 * 32 bytes, then the destination rules (canonical, on curve, not a program / mint, not the
 * bot wallet). No error text ever contains the address.
 */
export function parseSkimAddressInput(raw, { walletAddress = null } = {}) {
  const s = String(raw ?? "").trim();
  if (!BASE58_RE.test(s)) return { ok: false, address: null, masked: null, error: "not a base58 address of 32–44 characters" };
  let bytes;
  try { bytes = bs58.decode(s); } catch { return { ok: false, address: null, masked: null, error: "not valid base58" }; }
  if (bytes.length !== 32) return { ok: false, address: null, masked: null, error: `decodes to ${bytes.length} bytes, not 32` };
  const r = checkSkimDestination(s, { walletAddress });
  return r.ok ? r : { ...r, error: maskAddressesIn(r.error) };
}

/** The on-chain state in words (request / confirm replies). */
export function onChainStateText(onChain) {
  if (!onChain) return "on-chain state unknown";
  return onChain.exists
    ? "exists, holds SOL"
    : "does not exist on chain yet (never received SOL) — check the address character by character";
}

const badFile = (error) => ({ exists: true, ok: false, address: null, error });

/**
 * The file's text → its content, shape-checked. `text` null = no file.
 * → { exists:false, ok:true } | { exists:true, ok:true, address|null, set_at, hold_until, holdUntilMs, verified, previous_masked }
 *   | { exists:true, ok:false, error }
 */
export function parseSkimDestinationOverride(text, { walletAddress = null } = {}) {
  if (text == null) return { exists: false, ok: true, address: null, hold_until: null, holdUntilMs: null };
  let o;
  try { o = JSON.parse(text); } catch { return badFile("not valid JSON"); }
  if (!o || typeof o !== "object" || Array.isArray(o)) return badFile("not a JSON object");
  if (o.source !== "telegram") return badFile('source is not "telegram"');
  const holdUntilMs = typeof o.hold_until === "string" ? Date.parse(o.hold_until) : NaN;
  if (!Number.isFinite(holdUntilMs)) return badFile("hold_until is missing or not a date");
  if (typeof o.set_at !== "string" || !Number.isFinite(Date.parse(o.set_at))) return badFile("set_at is missing or not a date");
  if (!("address" in o)) return badFile("address is missing");
  if (typeof o.verified !== "boolean") return badFile("verified is missing");
  if (o.address !== null) {
    if (typeof o.address !== "string") return badFile("address is not a string");
    const d = checkSkimDestination(o.address, { walletAddress });
    if (!d.ok) return badFile(`address refused: ${maskAddressesIn(d.error)}`);
    if (d.address !== o.address) return badFile("address is not in canonical form");
  }
  return {
    exists: true, ok: true, address: o.address, set_at: o.set_at, hold_until: o.hold_until, holdUntilMs,
    verified: o.verified, previous_masked: typeof o.previous_masked === "string" ? o.previous_masked : null,
  };
}

const isChange = (e) => e && e.type === "destination_change" && typeof e.set_at === "string" && typeof e.hold_until === "string" && (e.to === null || typeof e.to === "string");
const isVerified = (e) => e && e.type === "destination_verified" && typeof e.to === "string" && typeof e.change_set_at === "string";

/** destination_change lines (no signature; the skim reducer ignores them). */
export function journalDestinationChanges(events = []) {
  return (events || []).filter(isChange);
}

/**
 * The journal's destination state: the newest change line, whether it was verified, the
 * hold in force (max hold_until over every change line) and the file record that must match.
 */
export function journalDestinationState(events = []) {
  const changes = journalDestinationChanges(events);
  const newest = changes.length ? changes[changes.length - 1] : null;
  let holdUntilMs = null;
  for (const c of changes) {
    const t = Date.parse(c.hold_until);
    if (Number.isFinite(t) && (holdUntilMs == null || t > holdUntilMs)) holdUntilMs = t;
  }
  const verified = newest
    ? (newest.to === null ? true : (events || []).some((e) => isVerified(e) && e.to === newest.to && e.change_set_at === newest.set_at))
    : true;
  const fileRecord = newest
    ? { address: newest.to, set_at: newest.set_at, source: "telegram", previous_masked: newest.from_masked ?? null, hold_until: newest.hold_until, verified }
    : null;
  return { changes, newest, holdUntilMs, verified, fileRecord };
}

export function holdText(holdUntilMs, now) {
  const left = Math.max(0, holdUntilMs - now);
  const h = Math.floor(left / 3_600_000);
  const m = Math.ceil((left % 3_600_000) / 60_000);
  return `${fmtWib(holdUntilMs, "datetime")} (${h > 0 ? `${h} h ` : ""}${m} min left)`;
}

const MISMATCH_TAIL = "every skim is refused (no fallback to the .env address); re-send /skim address <address> or /skim address reset to repair (a new hold starts)";

/**
 * The effective destination.
 *   envDestination  checkSkimDestination(.env value)
 *   override        parseSkimDestinationOverride(file text)
 *   journal         { events, corrupt, error } — the loaded skim journal
 * → { ok, address, masked, source: "env"|"telegram"|null, error, hold_until, holdUntilMs,
 *     holdActive, verified, changed_at, corrupt (refuse everything), mismatch }
 * During the hold `ok` is false while `address` / `masked` stay filled in.
 */
export function resolveSkimDestination({ envDestination, override, journal = { events: [] }, now = Date.now() }) {
  const refuseAll = (why, extra = {}) => ({
    ok: false, address: null, masked: null, source: null, corrupt: true, mismatch: true, verified: false,
    hold_until: null, holdUntilMs: null, holdActive: false, changed_at: null,
    error: maskAddressesIn(why), ...extra,
  });
  if (journal?.error) return refuseAll(`the skim journal cannot be read (${journal.error}) — the destination is unknown, every skim is refused`);
  if (journal?.corrupt > 0) return refuseAll(`the skim journal has ${journal.corrupt} unreadable line(s) — the destination is unknown, every skim is refused`);
  const js = journalDestinationState(journal?.events || []);
  const holdUntilMs = js.holdUntilMs;
  const holdFields = { hold_until: Number.isFinite(holdUntilMs) ? new Date(holdUntilMs).toISOString() : null, holdUntilMs: Number.isFinite(holdUntilMs) ? holdUntilMs : null, holdActive: Number.isFinite(holdUntilMs) && now < holdUntilMs };

  if (!js.newest) {
    if (override?.exists) return refuseAll(`destination file does not match the journal (skim-destination.json exists but the journal has no destination change) — ${MISMATCH_TAIL}`);
    return { ...(envDestination || { ok: false, address: null, masked: null, error: "PIONEX_DEPOSIT_ADDRESS is not set in .env" }), source: "env", corrupt: false, mismatch: false, verified: true, changed_at: null, ...holdFields, holdActive: false };
  }
  if (!override?.exists) return refuseAll(`destination file does not match the journal (skim-destination.json is missing but the journal has a destination change) — ${MISMATCH_TAIL}`, { ...holdFields, changed_at: js.newest.set_at });
  if (!override.ok) return refuseAll(`destination file does not match the journal (skim-destination.json is unreadable or invalid: ${override.error}) — ${MISMATCH_TAIL}`, { ...holdFields, changed_at: js.newest.set_at });
  const diffs = [];
  if (override.address !== js.newest.to) diffs.push("address");
  if (override.set_at !== js.newest.set_at) diffs.push("set_at");
  if (override.holdUntilMs !== Date.parse(js.newest.hold_until)) diffs.push("hold_until");
  if (override.verified !== js.verified) diffs.push("verified");
  if (diffs.length) return refuseAll(`destination file does not match the journal (${diffs.join(", ")} differ) — ${MISMATCH_TAIL}`, { ...holdFields, changed_at: js.newest.set_at });

  const base = js.newest.to
    ? { ok: true, address: js.newest.to, masked: maskAddress(js.newest.to), error: null, source: "telegram" }
    : { ...(envDestination || { ok: false, address: null, masked: null, error: "PIONEX_DEPOSIT_ADDRESS is not set in .env" }), source: "env" };
  const out = { ...base, error: maskAddressesIn(base.error), corrupt: false, mismatch: false, verified: js.verified, changed_at: js.newest.set_at, ...holdFields };
  if (out.holdActive && out.ok) {
    out.ok = false;
    out.error = `the destination was changed — on hold until ${holdText(holdUntilMs, now)}; no skim is proposed or sent before then`;
  }
  return out;
}

/**
 * The journal line for a change. The hold never shortens the one in force
 * (`existingHoldUntilMs` = journalDestinationState(...).holdUntilMs).
 */
export function buildDestinationChangeLine({ kind, to, fromMasked, now, holdHours, existingHoldUntilMs = null }) {
  const fresh = now + holdHours * 3_600_000;
  const holdUntilMs = Number.isFinite(existingHoldUntilMs) ? Math.max(existingHoldUntilMs, fresh) : fresh;
  const at = new Date(now).toISOString();
  return { type: "destination_change", kind, at, set_at: at, from_masked: fromMasked ?? null, to: to ?? null, to_masked: to ? maskAddress(to) : "env", source: "telegram", hold_until: new Date(holdUntilMs).toISOString() };
}

/** Why an address change cannot be applied right now (null = go). A mismatched / corrupt file is NOT a refusal: this is its repair. */
export function destinationChangeRefusal({ journalCorrupt = 0, journalError = null, pendingSkims = 0, sendInFlight = false, confirmInFlight = false, proposeInFlight = false } = {}) {
  if (journalError) return `the skim journal cannot be read (${maskAddressesIn(journalError)})`;
  if (journalCorrupt > 0) return `the skim journal has ${journalCorrupt} unreadable line(s) — a pending skim could be hidden; repair the journal first (/skim journal check)`;
  if (pendingSkims > 0) return "a skim is unresolved in the journal — resolve it first";
  if (sendInFlight) return "a skim is being sent";
  if (confirmInFlight) return "a skim confirmation is running";
  if (proposeInFlight) return "a skim check is running — try again in a moment";
  return null;
}

/**
 * /skim address verified. `state` = journalDestinationState(events), `current` = the resolved
 * destination, `skims` = the reduced journal, `lastIsVerifyOfNewest` = the newest destination
 * line in the journal is this change's destination_verified (its file write failed — re-sending
 * the command rewrites the file from the journal). null = go.
 */
export function verifyRefusal({ state, current, skims = [], lastIsVerifyOfNewest = false }) {
  if (!state?.newest || state.newest.to === null) return "the destination is the .env address — it needs no verification";
  if (state.verified) {
    if (current?.mismatch && lastIsVerifyOfNewest) return null;
    return current?.mismatch ? current.error : "the destination is already verified";
  }
  if (current?.mismatch) return current.error;
  if (current?.holdActive) return "the destination is on hold after a change — verify it after the hold";
  // The test transfer must be one sent AFTER this change (A → reset → A needs a new one).
  if (!testTransfersSince(skims, state.newest.to, state.newest.set_at).some((s) => s.status === "landed")) return "no skim to this address has landed since the change — send the test transfer first, check it arrived, then verify";
  return null;
}

/**
 * Pending address changes: one at a time (a new one replaces the old), a 6-character
 * code from the CSPRNG, a 10-minute expiry, compared in constant time; three wrong codes
 * burn it. In memory only — a restart drops it (the safe direction).
 */
export function createSkimAddressChangeStore({ ttlMs = SKIM_ADDRESS_CHANGE_TTL_MS, maxTries = SKIM_ADDRESS_MAX_TRIES, randomCode } = {}) {
  let current = null;
  const makeCode = randomCode || (() => {
    let s = "";
    for (let i = 0; i < SKIM_ADDRESS_CODE_LENGTH; i++) s += SKIM_ADDRESS_CODE_ALPHABET[randomInt(SKIM_ADDRESS_CODE_ALPHABET.length)];
    return s;
  });
  const pub = (c) => (c ? { kind: c.kind, to: c.to, toMasked: c.toMasked, toLong: c.toLong, fromMasked: c.fromMasked, fromSource: c.fromSource, onChain: c.onChain, createdAt: c.createdAt, expiresAt: c.expiresAt, tries: c.tries } : null);
  return {
    /** kind "set" (to = address) or "reset" (to = the .env address). → the change incl. its code. */
    create({ kind, to, toMasked, fromMasked, fromSource = null, onChain = null, now = Date.now() }) {
      if (kind !== "set" && kind !== "reset") throw new Error("kind must be set or reset");
      if (!to) throw new Error("a change needs a target address");
      const replaced = current !== null;
      current = { kind, to, toMasked: toMasked || maskAddress(to), toLong: maskAddressLong(to), fromMasked: fromMasked || null, fromSource, onChain, code: String(makeCode()).toUpperCase(), createdAt: now, expiresAt: now + ttlMs, tries: 0 };
      return { ...pub(current), code: current.code, replaced };
    },
    peek(now = Date.now()) {
      if (current && now > current.expiresAt) current = null;
      return pub(current);
    },
    /** Takes the change out of the store on success (one use). */
    confirm(code, now = Date.now()) {
      if (!current) return { ok: false, reason: "no address change is pending" };
      if (now > current.expiresAt) { current = null; return { ok: false, reason: "the address change expired — start again", burned: true }; }
      const want = Buffer.from(current.code, "utf8");
      const given = Buffer.from(String(code ?? "").trim().toUpperCase(), "utf8");
      const same = given.length === want.length ? timingSafeEqual(given, want) : (timingSafeEqual(want, want) && false);
      if (!same) {
        current.tries += 1;
        if (current.tries >= maxTries) { current = null; return { ok: false, reason: `wrong code — ${maxTries} wrong codes, the pending change is cancelled`, burned: true }; }
        const left = maxTries - current.tries;
        return { ok: false, reason: `wrong code (${left} tr${left === 1 ? "y" : "ies"} left)` };
      }
      const c = pub(current);
      current = null;
      return { ok: true, change: c };
    },
    cancel() { const had = current !== null; current = null; return had; },
  };
}

/**
 * Addresses a skim entry may have been sent to: its own `destination` when it records one;
 * otherwise the .env address or any destination_change target in the journal — narrowed to
 * those matching a recorded mask (`destination_masked`, or a baseline `destination` that is
 * a mask or a full address).
 */
export function skimEntryDestinations(entry, { envAddress = null, journalEvents = [] } = {}) {
  if (entry?.destination && typeof entry.destination === "string" && !entry.destination.includes("…")) return [entry.destination];
  const all = [...new Set([envAddress, ...journalDestinationChanges(journalEvents).map((e) => e.to)].filter(Boolean))];
  const recorded = entry?.destination_masked ?? (typeof entry?.destination === "string" ? entry.destination : null);
  if (typeof recorded === "string" && recorded.includes("…")) return all.filter((a) => maskAddress(a) === recorded);
  return all;
}

// ─── Telegram texts (HTML; 4…4 everywhere except the two private-chat replies: 8…8) ─────
const esc = (v) => maskAddressesIn(String(v ?? "")).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const SKIM_DEST_SOURCE_LABEL = { env: ".env", telegram: "set by /skim address" };
export const SKIM_ADDRESS_USAGE = "<i><code>/skim address &lt;address&gt;</code> sets it · <code>/skim address confirm &lt;code&gt;</code> · <code>/skim address reset</code> back to .env · <code>/skim address verified</code> after the test transfer · <code>/skim address cancel</code></i>";

/** "• Destination: …" for the status card and /skim address. */
export function skimDestinationLineText(d, now = Date.now(), { testTransferSol = SKIM_TEST_TRANSFER_SOL } = {}) {
  const addr = d?.masked ? `<code>${esc(d.masked)}</code>` : "<i>not set</i>";
  const src = d?.source ? ` (${esc(SKIM_DEST_SOURCE_LABEL[d.source] || d.source)})` : "";
  const unverified = d?.verified === false && !d?.mismatch ? ` · ⚠️ unverified — one test transfer of ◎${testTransferSol}, then <code>/skim address verified</code>` : "";
  if (d?.holdActive && !d?.mismatch) return `• <b>Destination:</b> ${addr}${src} ⏸️ on hold until ${esc(holdText(d.holdUntilMs, now))} — no skim before then${unverified}`;
  return `• <b>Destination:</b> ${addr}${src}${d?.ok ? " ✅" : ` ❌ ${esc(d?.error || "")}`}${unverified}`;
}

/** /skim address (no argument). */
export function skimAddressStatusText(d, pending, { holdHours = SKIM_ADDRESS_CHANGE_HOLD_HOURS, now = Date.now(), testTransferSol = SKIM_TEST_TRANSFER_SOL } = {}) {
  const lines = ["💸 <b>Skim destination</b>", skimDestinationLineText(d, now, { testTransferSol })];
  if (pending) lines.push(`• Pending ${pending.kind === "reset" ? "reset" : "change"}: <code>${esc(pending.fromMasked || "none")}</code> → <code>${esc(pending.toMasked)}</code>, expires ${esc(fmtWib(pending.expiresAt, "time"))}`);
  lines.push(`• After any change or reset: no skim for ${holdHours} h; a new address gets one test transfer of ◎${testTransferSol}, then <code>/skim address verified</code> once it arrived (check the exchange's minimum deposit first).`);
  lines.push(SKIM_ADDRESS_USAGE);
  return lines.join("\n");
}

/** Reply to /skim address <x> and /skim address reset (private chat): 8…8 + on-chain state + the code. */
export function skimAddressPendingText(c, { holdHours = SKIM_ADDRESS_CHANGE_HOLD_HOURS, testTransferSol = SKIM_TEST_TRANSFER_SOL } = {}) {
  const reset = c.kind === "reset";
  return [
    `🔐 <b>Skim destination ${reset ? "reset" : "change"} — not applied yet</b>`,
    `<code>${esc(c.fromMasked || "none")}</code> → <code>${esc(c.toLong || c.toMasked)}</code>${reset ? " (.env)" : ""}`,
    reset ? "This goes back to the .env address." : `On chain: ${esc(onChainStateText(c.onChain))}.`,
    reset ? null : "Compare the first 8 and last 8 characters with the address you meant — base58 has no checksum.",
    `Confirm with <code>/skim address confirm ${esc(c.code)}</code> before ${esc(fmtWib(c.expiresAt, "time"))} (one use, ${SKIM_ADDRESS_MAX_TRIES} tries)${c.replaced ? " — this replaces the earlier pending change" : ""}.`,
    `After the change no skim is proposed or sent for ${holdHours} h${reset ? "" : `; then one test transfer of ◎${testTransferSol} (check the exchange's minimum deposit), and <code>/skim address verified</code> once it arrived`}. <code>/skim address cancel</code> drops it.`,
  ].filter(Boolean).join("\n");
}

/** Reply to a successful /skim address confirm (private chat): 8…8 + the on-chain state seen at the request. */
export function skimAddressConfirmedText(r, change) {
  const reset = r.kind === "reset";
  return [
    r.stillRefused
      ? `⚠️ <b>Destination ${reset ? "reset" : "change"} journalled, but the skimmer still refuses</b>: <code>${esc(change?.toLong || r.toMasked)}</code>\nWhy: ${esc(r.stillRefused)}`
      : `✅ <b>Destination ${reset ? "reset to .env" : "change"} applied</b>: <code>${esc(change?.toLong || r.toMasked)}</code>`,
    reset ? null : `On chain (at the request): ${esc(onChainStateText(change?.onChain))}.`,
    r.warning ? `⚠️ ${esc(r.warning)}` : null,
  ].filter(Boolean).join("\n");
}

/** The alert sent once a change or reset is applied (4…4). */
export function skimDestinationChangedText(r, { testTransferSol = SKIM_TEST_TRANSFER_SOL } = {}) {
  return [
    "⚠️ <b>Skim destination changed</b>",
    `<code>${esc(r.fromMasked)}</code> → <code>${esc(r.toMasked)}</code>${r.kind === "reset" ? " (.env)" : ` (unverified: one test transfer of ◎${testTransferSol} first)`}`,
    `No skim will be proposed or sent to it before ${esc(fmtWib(r.holdUntilMs, "datetime"))}. Any open proposal was cancelled.`,
    "If this was not you: <code>/skim off</code>, then <code>/skim address reset</code>.",
  ].join("\n");
}

/**
 * /skim address orchestration with injected I/O (index.js wires the live functions; the
 * private-chat gate runs before it — skim-flow.js skimGateKey / skimCommandGate).
 *   store             createSkimAddressChangeStore()
 *   getDestination    () → the effective destination (tools/transfer.js getSkimDestination)
 *   getEnvDestination () → the .env destination, format-checked
 *   checkCandidate    async (raw) → format + on-chain checks (RPC failure refuses), with onChain
 *   apply             (change) → applySkimDestinationChange(change, …)
 *   verify            () → applySkimDestinationVerified(…)
 * handle(arg) → the replies (HTML strings, sent in order). No reply or log line carries a
 * full address; only the request / confirm replies show 8…8.
 */
export function createSkimAddressCommands({ store, getDestination, getEnvDestination, checkCandidate, apply, verify = () => ({ ok: false, error: "not available" }), holdHours = () => SKIM_ADDRESS_CHANGE_HOLD_HOURS, testTransferSol = () => SKIM_TEST_TRANSFER_SOL, log: rawLog = () => {}, now = () => Date.now() }) {
  const log = (c, m) => rawLog(c, maskAddressesIn(String(m)));
  const pendingText = (c) => skimAddressPendingText(c, { holdHours: holdHours(), testTransferSol: testTransferSol() });
  const changedText = (r) => skimDestinationChangedText(r, { testTransferSol: testTransferSol() });
  const no = (why) => `❌ <b>Destination not changed</b>: ${esc(why)}`;

  function status() {
    return skimAddressStatusText(getDestination(), store.peek(now()), { holdHours: holdHours(), now: now(), testTransferSol: testTransferSol() });
  }
  function cancel() {
    const had = store.cancel();
    log("skim", `[SKIM] address change cancel: ${had ? "pending change dropped" : "nothing pending"}`);
    return had ? "✖️ <b>Pending destination change dropped.</b> Nothing changed." : "Nothing pending — nothing changed.";
  }
  function confirm(code) {
    const used = store.confirm(code, now());
    if (!used.ok) { log("skim_warn", `[SKIM] address change confirm refused: ${used.reason}`); return [no(used.reason)]; }
    const r = apply(used.change);
    if (!r?.ok) return [no(r?.error || "unknown error"), ...(r?.journalled ? [changedText(r)] : [])];
    return [skimAddressConfirmedText(r, used.change), changedText(r)];
  }
  function reset() {
    const cur = getDestination();
    if (!cur.mismatch && cur.source === "env") return no("there is no Telegram-set destination — it already is the .env address");
    const envDest = getEnvDestination();
    if (!envDest?.ok) return no(`the .env destination is not usable (${envDest?.error || "not set"})`);
    const c = store.create({ kind: "reset", to: envDest.address, toMasked: envDest.masked, fromMasked: cur.masked || (cur.mismatch ? "unknown (file mismatch)" : null), fromSource: cur.source, now: now() });
    log("skim", `[SKIM] address reset requested: ${cur.masked || "unknown"} → ${envDest.masked} (.env), pending confirmation`);
    return pendingText(c);
  }
  async function set(raw) {
    const cur = getDestination();
    let cand;
    try { cand = await checkCandidate(raw); } catch (e) { cand = { ok: false, error: e.message }; }
    if (!cand?.ok) { log("skim_warn", `[SKIM] address change refused: ${cand?.error}`); return `❌ <b>Address refused</b>: ${esc(cand?.error || "unknown")}`; }
    if (!cur.mismatch && cur.address && cand.address === cur.address) return no(`${cand.masked} already is the destination`);
    const c = store.create({ kind: "set", to: cand.address, toMasked: cand.masked, fromMasked: cur.masked || (cur.mismatch ? "unknown (file mismatch)" : null), fromSource: cur.source, onChain: cand.onChain ?? null, now: now() });
    log("skim", `[SKIM] address change requested: ${cur.masked || "none"} → ${cand.masked} (${cand.onChain?.exists ? "exists on chain" : "not on chain yet"}), pending confirmation`);
    return pendingText(c);
  }
  function verified() {
    const r = verify();
    if (!r?.ok) { log("skim_warn", `[SKIM] address verify refused: ${r?.error}`); return `❌ <b>Not verified</b>: ${esc(r?.error || "unknown")}`; }
    if (r.stillRefused) return `⚠️ <b>Verification journalled, but the skimmer still refuses</b>: <code>${esc(r.masked)}</code>\nWhy: ${esc(r.stillRefused)}`;
    return `✅ <b>Destination verified</b>: <code>${esc(r.masked)}</code> — skims are no longer capped at the test transfer.${r.warning ? `\n⚠️ ${esc(r.warning)}` : ""}`;
  }
  async function handle(arg) {
    const a = String(arg ?? "").trim();
    const lower = a.toLowerCase();
    if (a === "") return [status()];
    if (lower === "cancel") return [cancel()];
    const m = /^confirm\s+(\S+)$/i.exec(a);
    if (m) return confirm(m[1]);
    if (lower === "confirm") return [no("give the code: /skim address confirm <code>")];
    if (lower === "reset") return [reset()];
    if (lower === "verified" || lower === "verify") return [verified()];
    if (/\s/.test(a)) return ["❌ <b>Address refused</b>: one address, no spaces"];
    return [await set(a)];
  }
  return { handle, status, cancel, confirm, reset, set, verified };
}
