// modelled-net.js — the record's MODELLED net result, composed in one place (2026-11-25).
//
//   pnl_sol_net (modelled) = pnl_sol − gas − exit-swap gas − exit slippage − entry premium
//
// Before this date the modelled figure was pnl_sol − total_gas_sol − exit_slippage_sol. Two costs
// the bot already measures were left out (docs/research/2026-11-25-wallet-vs-modelled-gap.md, 85
// wallet-audited bot closes, 30 days):
//   exit-swap gas  `exit_swap.gas_sol` — the after-close swap's own transaction fee; it is not in
//                  `total_gas_sol` (that is the position's transactions up to the close).
//                  ◎0.0015 over the 85.
//   entry premium  `entry_cost_sol` when `entry_cost_source` is "measured" (a Meteora-UI zap or
//                  re-range, read from chain) or "straddle" (the bot's own stage-B buy): SOL paid
//                  for the base side − the tokens × the active-bin price the deposit is booked at.
//                  SIGNED (a buy below the bin price is a gain). Meteora's closed pnl values the
//                  deposit at the pool price and the straddle's own-flow basis (noteFlow) uses that
//                  same price, so the premium is in neither; the flow-basis offset only carries the
//                  move between that price and the landing price. ◎0.067 over the 85.
// Wallet-audited records keep the wallet figure as their net result; this is the figure they keep
// in `pnl_sol_net_modelled` and the one the close audit compares against. Stored records are not
// recomputed: readers keep reading the stored fields.

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** Entry-cost sources whose figure is a measurement of what was paid (not "none" / "unavailable"). */
export const ENTRY_PREMIUM_SOURCES = new Set(["measured", "straddle"]);

/**
 * The parts of the modelled net. Pure. null when the record has no gross SOL result.
 * @returns {{ gross:number, gas:number, exit_swap_gas:number, exit_slippage:number, entry_premium:number, net:number }|null}
 */
export function modelledNetComponents(rec) {
  const gross = num(rec?.pnl_sol);
  if (gross == null) return null;
  const gas = num(rec?.total_gas_sol ?? rec?.gas_cost_sol) ?? 0;
  const swapGas = Math.max(0, num(rec?.exit_swap?.gas_sol) ?? 0);
  const slip = num(rec?.exit_slippage_sol) ?? 0;
  const premium = ENTRY_PREMIUM_SOURCES.has(rec?.entry_cost_source) ? (num(rec?.entry_cost_sol) ?? 0) : 0;
  return {
    gross: r6(gross), gas: r6(gas), exit_swap_gas: r6(swapGas), exit_slippage: r6(slip), entry_premium: r6(premium),
    net: r6(gross - gas - swapGas - slip - premium),
  };
}

/** Record fields: `pnl_sol_net` (modelled) + `pnl_sol_net_components` (without `net`). null when not computable. */
export function modelledNetFields(rec) {
  const c = modelledNetComponents(rec);
  if (!c) return null;
  const { net, ...components } = c;
  return { pnl_sol_net: net, pnl_sol_net_components: components };
}
