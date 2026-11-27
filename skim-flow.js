/**
 * Profit skimmer — orchestration with injected dependencies (2026-11-25), so index.js
 * keeps only the wiring and the Telegram texts and every flag path is testable.
 *
 *   skimBusyReasons(snapshot)     why a skim must wait (pure)
 *   createSkimFlow(deps)          { propose, confirm, cronTick, requestAbort, state }
 *   createCoalescer()             one run at a time; repeated taps join the running one
 *
 * Flags: `state.proposeInFlight` / `state.confirmInFlight` serialise the two operations;
 * the close slot + poller pause are claimed by sendSkim (deps.claim / deps.unclaim, the
 * latter ownership-aware in index.js) only for the pre-broadcast window. A confirm can be
 * stopped (requestAbort — /skim off, /skim cancel, the Cancel button) at every step up to
 * the final check right before the journal write; after that it is reported as already
 * being sent. Every flag is reset in a `finally`. Nothing here talks to Telegram.
 */
import { confirmationRefusal, skimCommandRefusal, withDeadline, maskAddress, maskAddressesIn, validateSkimSetting } from "./skim-policy.js";

/**
 * Which /skim subcommands / skim buttons need the private-chat shape check (private chat,
 * not forwarded, not a bot) — all of them except the read-only status card and journal
 * check, and the safe direction (off, cancel), which any authorised chat may use so that
 * stopping is never blocked.
 */
const SKIM_ANY_CHAT = new Set(["", "status", "refresh", "journal", "journal check", "off", "cancel", "address cancel"]);
export function skimCommandNeedsPrivate(sub) {
  return !SKIM_ANY_CHAT.has(String(sub ?? "").trim().toLowerCase());
}
/** Any message that is a /skim command — "/skim", "/Skim …", "/skim@MyBot …" — never reaches the LLM path. */
export const SKIM_COMMAND_RE = /^\/skim(@\w+)?(\s|$)/i;
export function isSkimCommandText(text) { return SKIM_COMMAND_RE.test(String(text ?? "")); }
/** The subcommand of a /skim message, original case ("address 7xKX…" keeps the address as typed). */
export function skimCommandArgs(text) { return String(text ?? "").replace(/^\/skim(@\w+)?/i, "").trim(); }
/** A text safe for the generic Telegram log / queue / live-message lines: a /skim message is masked. */
export function skimSafeLogText(text) {
  const t = String(text ?? "");
  return /^\s*\/skim/i.test(t) ? maskAddressesIn(t) : t;
}

/** Subcommand names the gate may log; anything else (an address, a typo) is logged as "other" — never raw input. */
const SKIM_GATE_LOG_NAMES = new Set(["", "status", "refresh", "on", "off", "now", "confirm", "cancel", "set", "resolve", "adopt", "journal", "journal check", "address", "address cancel"]);
export function skimGateLogName(gateKey) {
  const k = String(gateKey ?? "").trim().toLowerCase();
  return SKIM_GATE_LOG_NAMES.has(k) ? (k || "status") : "other";
}

/**
 * The gate key of a /skim subcommand line: "journal …" whole, "address cancel" (stop
 * direction, any chat), every other "address …" as "address" (private chat), else the first word.
 */
export function skimGateKey(sub) {
  const s = String(sub ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (s.startsWith("journal")) return s;
  if (s === "address cancel") return s;
  return s.split(" ")[0];
}
/** null when `msg` may run `sub`, else the refusal text. */
export function skimCommandGate(sub, msg) {
  return skimCommandNeedsPrivate(sub) ? skimCommandRefusal(msg) : null;
}

/**
 * Operator setting (/skim on|off|set, Enable/Disable buttons). `apply(field, value)` →
 * { persisted, inMemory, error } (tools/transfer.js applySkimSetting). "off" ALWAYS stops a
 * running confirm and stays off in memory even when the file write failed.
 * → { ok, field, value, persisted, stopNote, warning } | { ok:false, error }
 */
export function operatorSetSkim({ name, value, current = {}, env = {}, apply, stop, forceOff = () => {} }) {
  const v = validateSkimSetting(name, value, current, { env });
  if (!v.ok) return { ok: false, error: v.error };
  const isOff = v.field === "enabled" && v.value === false;
  let res;
  try { res = apply(v.field, v.value) || { persisted: false, inMemory: false, error: new Error("no result") }; }
  catch (e) { res = { persisted: false, inMemory: false, error: e }; }
  if (isOff && !res.persisted && !res.inMemory) { try { forceOff(); } catch { /* last resort */ } }
  let stopNote = null;
  if (isOff) { try { stopNote = stop("the skimmer was turned off"); } catch (e) { stopNote = `stop failed: ${e.message}`; } }
  if (!res.persisted) {
    const why = res.error?.message || "unknown error";
    if (isOff) return { ok: true, field: v.field, value: false, persisted: false, stopNote, warning: `user-config.json could not be written (${why}) — the skimmer is OFF in memory and stays off (reloads cannot turn it back on) until a successful /skim on or /skim off; fix the file` };
    return { ok: false, error: `user-config.json could not be written (${why}) — nothing changed` };
  }
  return { ok: true, field: v.field, value: v.value, persisted: true, stopNote };
}

/** Why a skim must wait right now. `holdingCloseSlot` = the skimmer's confirm holds the close slot itself. */
export function skimBusyReasons(s = {}) {
  const r = [];
  if (s.managementBusy) r.push("management cycle running");
  if (s.screeningBusy) r.push("screening cycle running");
  if (s.chatBusy) r.push("agent chat running");
  if (s.pollerTick) r.push("PnL poller tick running");
  if (s.closeInFlight && !s.holdingCloseSlot) r.push("a close is in flight");
  if (s.positionsUnreadable) r.push("position state unreadable");
  if ((s.positions || []).some((p) => p?.pending_flow)) r.push("a straddle / re-range flow is pending");
  if (s.deferredSwapPending) r.push("a deferred exit swap is pending");
  return r;
}

/** One run at a time; a call while one runs joins it (its onResult gets the same result). */
export function createCoalescer() {
  let running = null;
  let listeners = [];
  return {
    get running() { return running !== null; },
    run(fn, onResult) {
      if (onResult) listeners.push(onResult);
      if (running) return running;
      running = (async () => {
        let result, error;
        try { result = await fn(); } catch (e) { error = e; }
        const ls = listeners;
        listeners = [];
        running = null;
        for (const l of ls) { try { await l(result, error); } catch { /* a reply failure never breaks the others */ } }
        if (error) throw error;
        return result;
      })();
      return running;
    },
  };
}

export const SKIM_PENDING_ALERT_AFTER_MS = 10 * 60 * 1000;
export const SKIM_PENDING_ALERT_EVERY_MS = 6 * 60 * 60 * 1000;
export const SKIM_PROPOSAL_NOTIFY_EVERY_MS = 6 * 60 * 60 * 1000;

export function createSkimFlow(deps) {
  const {
    proposals,                 // createSkimProposalStore()
    evaluate,                  // ({ inFlight, runScan }) → { cfg, destination, decision }
    scan,                      // ({ conn, minContextSlot, signal }) → true when it completed (incremental, inside evaluate)
    warmScan = null,           // ({ signal }) → the bounded pre-skim deposit scan, BEFORE the 30 s window
    send,                      // (args, hooks) → sendSkim result
    reasons,                   // ({ holdingCloseSlot }) → string[]
    claim,                     // sync; throws when the close slot is taken
    unclaim,                   // sync; releases only what the skimmer claimed
    pollerTickActive,          // () → bool
    isEnabled = () => true,    // live config.autoSkim.enabled === true
    resolvePending,            // () → { landed, failed, pending }
    pendingSkims,              // () → journal skims with status pending
    log: rawLog = () => {},
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    deadlineMs = 30_000,
    scanDeadlineMs = 90_000,
    quietWaitMs = 20_000,
  } = deps;
  const log = (c, m) => rawLog(c, maskAddressesIn(String(m)));
  const state = {
    proposeInFlight: false, confirmInFlight: false, lastProposalNotifiedAt: 0, pendingAlertAt: new Map(), lastCronDecision: null,
    // the running confirm
    activeProposalId: null, abort: null, committed: false, broadcast: false,
  };

  async function waitQuiet(fn, ms) {
    const until = now() + ms;
    for (;;) {
      const r = fn();
      if (r.length === 0 || now() >= until) return r;
      await sleep(500);
    }
  }

  /** A scan bounded by a deadline that is cancelled (between transactions) when the deadline passes. */
  async function boundedScan(run, ms, label) {
    const ctrl = new AbortController();
    try { return await withDeadline(run(ctrl.signal), ms, label); }
    catch (e) { ctrl.abort(); throw e; }
  }

  /** evaluate() under the 30 s deadline; its incremental scan is cancelled with it. */
  async function boundedEvaluate(inFlight, label) {
    const ctrl = new AbortController();
    try {
      return await withDeadline(evaluate({ inFlight, runScan: (o) => scan({ ...o, signal: ctrl.signal }) }), deadlineMs, label);
    } catch (e) { ctrl.abort(); throw e; }
  }

  /** Never sends. → { proposal, ev } | { ev } (refused) | { busy } | { error } */
  async function propose(source) {
    if (state.confirmInFlight) return { busy: "a skim is being sent" };
    if (state.proposeInFlight) return { busy: "a skim check is already running" };
    state.proposeInFlight = true;
    try {
      await waitQuiet(() => reasons({}), quietWaitMs);
      if (warmScan) await boundedScan((signal) => warmScan({ signal }), scanDeadlineMs, "deposit scan");
      const ev = await boundedEvaluate(() => reasons({}), "skim check");
      if (state.confirmInFlight) return { busy: "a skim is being sent" };
      if (!ev.decision.ok) {
        log("skim", `[SKIM] ${source} decision: no skim — ${ev.decision.reason}`);
        return { ev };
      }
      const p = proposals.create({ amountSol: ev.decision.amountSol, destination: ev.destination.address, destinationMasked: ev.destination.masked, destinationSource: ev.destination.source ?? null, testTransfer: ev.decision.testTransfer === true, source, now: now() });
      log("skim", `[SKIM] proposal ${p.id} (${source}): ◎${p.amountSol} to ${p.destinationMasked}, expires ${new Date(p.expiresAt).toISOString()}`);
      return { proposal: p, ev };
    } catch (e) {
      log("skim_warn", `[SKIM] ${source} check failed: ${e.message}`);
      return { error: maskAddressesIn(e.message) };
    } finally {
      state.proposeInFlight = false;
    }
  }

  /** Why the running confirm must stop now (null = go on). */
  function stopReason() {
    if (state.abort) return state.abort;
    if (!isEnabled()) return "the skimmer was turned off";
    return null;
  }

  /**
   * /skim off, /skim cancel, the Cancel button. `proposalId` (optional) must match the
   * running confirm. → { inFlight:false } | { inFlight, aborted, proposalId } | { inFlight, alreadySent, proposalId }
   */
  function requestAbort(reason = "cancelled by the operator", proposalId = null) {
    if (!state.confirmInFlight) return { inFlight: false };
    if (proposalId && state.activeProposalId && String(proposalId).toLowerCase() !== state.activeProposalId) return { inFlight: true, mismatch: true, proposalId: state.activeProposalId };
    if (state.committed || state.broadcast) return { inFlight: true, alreadySent: true, proposalId: state.activeProposalId };
    state.abort = reason;
    log("skim", `[SKIM] stop requested for proposal ${state.activeProposalId || "-"}: ${reason}`);
    return { inFlight: true, aborted: true, proposalId: state.activeProposalId };
  }

  /** → { refused } | { status, result, proposal } */
  async function confirm(id, msg, source) {
    const shape = skimCommandRefusal(msg);
    if (shape) { log("skim_warn", `[SKIM] confirm ${id} refused: ${shape}`); return { refused: shape }; }
    if (state.confirmInFlight) return { refused: "another skim confirmation is running" };
    state.confirmInFlight = true;
    state.abort = null; state.committed = false; state.broadcast = false; state.activeProposalId = null;
    const stopped = () => { const r = stopReason(); if (r) { log("skim", `[SKIM] confirm ${id} stopped: ${r}`); return { refused: r, stopped: true }; } return null; };
    try {
      const used = proposals.consume(id, now());
      if (!used.ok) { log("skim_warn", `[SKIM] confirm ${id} refused: ${used.reason}`); return { refused: used.reason, needNew: true }; }
      const p = used.proposal;
      state.activeProposalId = p.id;
      let s = stopped(); if (s) return s;
      await waitQuiet(() => reasons({}), quietWaitMs);
      s = stopped(); if (s) return s;
      if (warmScan) await boundedScan((signal) => warmScan({ signal }), scanDeadlineMs, "deposit scan");
      s = stopped(); if (s) return s;
      const ev = await boundedEvaluate(() => reasons({}), "skim re-check");
      s = stopped(); if (s) return s;
      const why = confirmationRefusal(p, ev.decision, ev.destination);
      if (why) { log("skim_warn", `[SKIM] confirm ${p.id} refused: ${why}`); return { refused: why }; }
      log("skim", `[SKIM] proposal ${p.id} confirmed (${source}) — sending ◎${p.amountSol} to ${p.destinationMasked}`);
      const stopList = () => { const r = stopReason(); return r ? [r] : []; };
      const result = await send(
        { amountSol: p.amountSol, proposalId: p.id, reserveSol: ev.cfg.minWalletReserveSol, reason: `profit_skim_${source}`, expectedFreeSol: ev.decision.figures?.freeSol ?? null, expectedDestination: p.destination },
        {
          acquire: claim,
          release: unclaim,
          waitReady: (ms) => waitQuiet(() => (pollerTickActive() ? ["PnL poller tick running"] : []), ms).then((r) => { if (r.length) throw new Error("the PnL poller tick did not finish"); }),
          preSendCheck: () => [...reasons({ holdingCloseSlot: true }), ...stopList()],
          finalCheck: () => { const r = stopList(); if (!r.length) state.committed = true; return r; },
          onBroadcast: () => { state.broadcast = true; },
          deadlineMs,
        },
      );
      log(result.status === "landed" || result.status === "dry_run" ? "skim" : "skim_error", `[SKIM] proposal ${p.id}: ${result.status}${result.signature ? ` tx ${result.signature}` : ""}${result.error ? ` — ${result.error}` : ""}`);
      const stopWhy = result.status === "refused" ? stopReason() : null;
      if (stopWhy) return { refused: stopWhy, stopped: true };
      return { status: result.status, result, proposal: p };
    } catch (e) {
      log("skim_error", `[SKIM] confirm ${id} failed: ${e.message}`);
      return { refused: maskAddressesIn(e.message) };
    } finally {
      try { unclaim(); } catch { /* ownership-aware: a no-op unless the skimmer still holds it */ }
      state.confirmInFlight = false;
      state.activeProposalId = null; state.abort = null; state.committed = false; state.broadcast = false;
    }
  }

  /**
   * Every 30 min, enabled or not: resolve pending skims and raise the pending alert;
   * then, when enabled, the cheap pre-check and (≤ every 6 h) a proposal — or, only with
   * the .env waiver, an unattended send through the same confirm path.
   * → { resolved, alerts, action: "none"|"proposal"|"unattended", out?, result? }
   */
  async function cronTick({ enabled }) {
    const res = { resolved: null, alerts: [], action: "none" };
    try { res.resolved = await withDeadline(resolvePending(), deadlineMs, "pending resolution"); } catch (e) { log("skim_warn", `[SKIM] pending resolution failed: ${e.message}`); }
    const t = now();
    for (const s of pendingSkims()) {
      const age = t - (new Date(s.created_at || 0).getTime() || t);
      const last = state.pendingAlertAt.get(s.signature) || 0;
      if (age >= SKIM_PENDING_ALERT_AFTER_MS && t - last >= SKIM_PENDING_ALERT_EVERY_MS) {
        state.pendingAlertAt.set(s.signature, t);
        res.alerts.push({ signature: s.signature, amountSol: s.amount_sol, ageMin: Math.round(age / 60000) });
        log("skim_warn", `[SKIM] skim ${maskAddress(s.signature)} pending for ${Math.round(age / 60000)} min — operator alerted`);
      }
    }
    if (!enabled) return res;
    let pre;
    try { pre = await withDeadline(evaluate({ inFlight: () => reasons({}) }), deadlineMs, "skim pre-check"); } catch (e) { log("skim_warn", `[SKIM] cron pre-check failed: ${e.message}`); return res; }
    const key = pre.decision.ok ? `ok:${pre.decision.amountSol}` : pre.decision.reason;
    if (key !== state.lastCronDecision) {
      state.lastCronDecision = key;
      log("skim", `[SKIM] cron decision: ${pre.decision.ok ? `may skim ◎${pre.decision.amountSol}` : `no skim — ${pre.decision.reason}`} (profit ◎${pre.decision.figures?.profitSol ?? "?"}, capital ◎${pre.decision.figures?.adjustedCapital ?? "?"})`);
    }
    if (!pre.decision.ok) return res;
    if (pre.cfg.requireConfirmation !== false) {
      if (t - state.lastProposalNotifiedAt < SKIM_PROPOSAL_NOTIFY_EVERY_MS) return res;
      const out = await propose("cron");
      if (!out.proposal) return res;
      state.lastProposalNotifiedAt = t;
      return { ...res, action: "proposal", out };
    }
    // Only with .env AUTO_SKIM_REQUIRE_CONFIRMATION=false (read raw by skimConfig).
    const out = await propose("cron-unattended");
    if (!out.proposal) return res;
    const result = await confirm(out.proposal.id, { chat: { type: "private" }, from: { is_bot: false } }, "cron-unattended");
    return { ...res, action: "unattended", out, result };
  }

  return { propose, confirm, cronTick, requestAbort, state };
}
