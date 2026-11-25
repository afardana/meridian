/**
 * Profit skimmer — orchestration with injected dependencies (2026-11-25), so index.js
 * keeps only the wiring and the Telegram texts and every flag path is testable.
 *
 *   skimBusyReasons(snapshot)     why a skim must wait (pure)
 *   createSkimFlow(deps)          { propose, confirm, cronTick, state }
 *
 * Flags: `state.proposeInFlight` / `state.confirmInFlight` serialise the two operations;
 * the close slot + poller pause are claimed by sendSkim (deps.claim / deps.unclaim, the
 * latter ownership-aware in index.js) only for the pre-broadcast window. Every flag is
 * reset in a `finally`. Nothing here talks to Telegram: the caller renders the results.
 */
import { confirmationRefusal, skimCommandRefusal, withDeadline, maskAddress } from "./skim-policy.js";

/** Why a skim must wait right now. `holdingCloseSlot` = the skimmer itself holds the close slot. */
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

export const SKIM_PENDING_ALERT_AFTER_MS = 10 * 60 * 1000;
export const SKIM_PENDING_ALERT_EVERY_MS = 6 * 60 * 60 * 1000;
export const SKIM_PROPOSAL_NOTIFY_EVERY_MS = 6 * 60 * 60 * 1000;

export function createSkimFlow(deps) {
  const {
    proposals,                 // createSkimProposalStore()
    evaluate,                  // ({ inFlight, runScan }) → { cfg, destination, decision }
    scan,                      // ({ conn, minContextSlot }) → true when it completed
    send,                      // (args, hooks) → sendSkim result
    reasons,                   // ({ holdingCloseSlot }) → string[]
    claim,                     // sync; throws when the close slot is taken
    unclaim,                   // sync; releases only what the skimmer claimed
    pollerTickActive,          // () → bool
    resolvePending,            // () → { landed, failed, pending }
    pendingSkims,              // () → journal skims with status pending
    log = () => {},
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    deadlineMs = 30_000,
    quietWaitMs = 20_000,
  } = deps;
  const state = { proposeInFlight: false, confirmInFlight: false, lastProposalNotifiedAt: 0, pendingAlertAt: new Map(), lastCronDecision: null };

  async function waitQuiet(fn, ms) {
    const until = now() + ms;
    for (;;) {
      const r = fn();
      if (r.length === 0 || now() >= until) return r;
      await sleep(500);
    }
  }

  /** Never sends. → { proposal, ev } | { ev } (refused) | { busy } | { error } */
  async function propose(source) {
    if (state.proposeInFlight) return { busy: "a skim check is already running" };
    state.proposeInFlight = true;
    try {
      await waitQuiet(() => reasons({}), quietWaitMs);
      const ev = await withDeadline(evaluate({ inFlight: () => reasons({}), runScan: scan }), deadlineMs, "skim check");
      if (!ev.decision.ok) {
        log("skim", `[SKIM] ${source} decision: no skim — ${ev.decision.reason}`);
        return { ev };
      }
      const p = proposals.create({ amountSol: ev.decision.amountSol, destination: ev.destination.address, destinationMasked: ev.destination.masked, source, now: now() });
      log("skim", `[SKIM] proposal ${p.id} (${source}): ◎${p.amountSol} to ${p.destinationMasked}, expires ${new Date(p.expiresAt).toISOString()}`);
      return { proposal: p, ev };
    } catch (e) {
      log("skim_warn", `[SKIM] ${source} check failed: ${e.message}`);
      return { error: e.message };
    } finally {
      state.proposeInFlight = false;
    }
  }

  /** → { refused } | { status, result, proposal } */
  async function confirm(id, msg, source) {
    const shape = skimCommandRefusal(msg);
    if (shape) { log("skim_warn", `[SKIM] confirm ${id} refused: ${shape}`); return { refused: shape }; }
    if (state.confirmInFlight) return { refused: "another skim confirmation is running" };
    state.confirmInFlight = true;
    try {
      const used = proposals.consume(id, now());
      if (!used.ok) { log("skim_warn", `[SKIM] confirm ${id} refused: ${used.reason}`); return { refused: used.reason, needNew: true }; }
      const p = used.proposal;
      await waitQuiet(() => reasons({}), quietWaitMs);
      const ev = await withDeadline(evaluate({ inFlight: () => reasons({}), runScan: scan }), deadlineMs, "skim re-check");
      const why = confirmationRefusal(p, ev.decision, ev.destination);
      if (why) { log("skim_warn", `[SKIM] confirm ${p.id} refused: ${why}`); return { refused: why }; }
      log("skim", `[SKIM] proposal ${p.id} confirmed (${source}) — sending ◎${p.amountSol} to ${p.destinationMasked}`);
      const result = await send(
        { amountSol: p.amountSol, proposalId: p.id, reserveSol: ev.cfg.minWalletReserveSol, reason: `profit_skim_${source}`, expectedFreeSol: ev.decision.figures?.freeSol ?? null },
        {
          acquire: claim,
          release: unclaim,
          waitReady: (ms) => waitQuiet(() => (pollerTickActive() ? ["PnL poller tick running"] : []), ms).then((r) => { if (r.length) throw new Error("the PnL poller tick did not finish"); }),
          preSendCheck: () => reasons({ holdingCloseSlot: true }),
          deadlineMs,
        },
      );
      log(result.status === "landed" || result.status === "dry_run" ? "skim" : "skim_error", `[SKIM] proposal ${p.id}: ${result.status}${result.signature ? ` tx ${result.signature}` : ""}${result.error ? ` — ${result.error}` : ""}`);
      return { status: result.status, result, proposal: p };
    } catch (e) {
      log("skim_error", `[SKIM] confirm ${id} failed: ${e.message}`);
      return { refused: e.message };
    } finally {
      try { unclaim(); } catch { /* ownership-aware: a no-op unless the skimmer still holds it */ }
      state.confirmInFlight = false;
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

  return { propose, confirm, cronTick, state };
}
