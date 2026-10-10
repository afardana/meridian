// Deploy sizing rules shared by the executor's safety checks and the screening cycle
// (2026-10-10, operator). Pure — no config, state or network — so both are testable.
//
// The probe tier (0.25 SOL clamp, one slot, `probeTierEnabled`) is gone. A safety-clean
// candidate the screener is less sure about is deployed at the MINIMUM deploy amount
// (`deployAmountSol`) instead; a full-conviction pick keeps the computeDeployAmount size.
// The weak-hour timing size-down is floored at the same minimum, so the executor never
// refuses the amount the goal told the model to use.

/** The minimum deploy amount the executor enforces (the same expression its check uses). */
export function minDeployAmountSol(deployAmountSol) {
  return Math.max(0.1, deployAmountSol);
}

/**
 * Tags only the executor may set. A caller (the LLM, a manual /deploy) passing any of
 * them would falsely label the position, so they are dropped before any check runs.
 */
export function stripCallerDeployTags(args) {
  delete args.scout;
  delete args.probe;
  delete args.low_conviction;
  return args;
}

/**
 * Did the caller ask for the lower-conviction size? `conviction: "low"` is the tool
 * parameter; the retired `tier: "probe"` is accepted as the same thing so an old-habit
 * call is corrected, not refused (agent.js allows one deploy_position attempt per cycle).
 */
export function isLowConvictionRequest(args) {
  const conviction = String(args?.conviction ?? "").trim().toLowerCase();
  const tier = String(args?.tier ?? "").trim().toLowerCase();
  return conviction === "low" || tier === "probe";
}

/**
 * Consume the `conviction` / `tier` parameters (deployPosition does not take them) and,
 * for a lower-conviction request, set the SOL amount to the minimum deploy amount —
 * whatever was passed, larger or smaller — and tag the position. No slot cap.
 * `skip` leaves the amount alone (scouts keep their own, smaller clamp).
 * @returns {{ requested: boolean, applied: boolean, from: number|null, to: number|null }}
 */
export function applyLowConvictionSize(args, minDeploySol, { skip = false } = {}) {
  const requested = isLowConvictionRequest(args);
  delete args.conviction;
  delete args.tier;
  const none = { requested, applied: false, from: null, to: null };
  if (!requested || skip) return none;
  const to = Number(minDeploySol);
  if (!Number.isFinite(to) || to <= 0) return none;
  const from = Number(args.amount_y ?? args.amount_sol ?? 0);
  if (args.amount_y != null || args.amount_sol == null) args.amount_y = to;
  if (args.amount_sol != null) args.amount_sol = to;
  args.low_conviction = true;
  return { requested, applied: true, from: Number.isFinite(from) ? from : null, to };
}

/**
 * Weak-hour timing size-down: amount × multiplier, never below the minimum deploy
 * amount and never above the un-reduced amount.
 * @returns {{ amount: number, floored: boolean }}
 */
export function timingSizeDownAmount(amount, multiplier, minDeploySol) {
  const full = Number(amount);
  const reduced = Math.round(full * Number(multiplier) * 1000) / 1000;
  const floor = Number(minDeploySol);
  if (!Number.isFinite(floor) || !(reduced < floor)) return { amount: Math.min(reduced, full), floored: false };
  return { amount: Math.min(floor, full), floored: true };
}
