/**
 * Telegram /settings menu — the ONE table of its items (2026-11-28, operator: "add a brief
 * explanation for each of the item's purpose and effects").
 *
 * Keyed by config key. Every key a menu button can reach (cfg:toggle / cfg:input / cfg:set)
 * must have an entry here and every entry must be on a page — test/settings-menu-help.test.js
 * enforces both directions. A new menu item therefore needs a help entry.
 *
 * Fields
 *   label     human name (prompt, Help message, header note)
 *   page      the page the item lives on (where a change returns to)
 *   kind      "number" (✏ prompt) | "toggle" (flips on tap) | "choice" (one button per value)
 *   unit      shown after the value ("SOL", "%", "pp", "$", "min", "×", "")
 *   digits    decimals on the ✏ button
 *   choices   for kind "choice"
 *   button    short prefix for choice buttons ("Exit" → "Exit: enforce ✓"); none = bare value
 *   nullable  true only where "off" (null) is really stored and means something
 *   check     menu-side input check { min, max, minExclusive, maxExclusive, integer } — ONLY for
 *             keys update_config does not validate itself, and only refusing values the code
 *             that reads the key would ignore, clamp away or choke on. Keys update_config
 *             validates (the distress gate, the bins clamps) have no check here: the value goes
 *             to update_config and its refusal is what the operator sees.
 *   help      1–3 plain sentences: what it does, what raising / lowering it changes, interactions
 *   accepts   the accepted input, in words
 *
 * The texts describe the code as of 2026-11-28; they are plain text (the menu escapes them).
 */

import { tvlDistressRangeText } from "./tvl-floor-distress.js";

const distressAccepts = (key, unit) => {
  const range = tvlDistressRangeText(key); // the validator's own wording, e.g. "−95 … −1"
  return `a number in the range ${range}${unit ? ` (${unit})` : ""}`;
};

export const SETTINGS_PAGES = Object.freeze({
  main: "Main",
  risk: "Risk",
  strategy: "Strategy",
  screen: "Screen",
  tvl: "TVL exit",
});

export const SETTINGS_HELP = Object.freeze({
  // ─── Main ───────────────────────────────────────────────────────────────
  solMode: {
    label: "SOL mode", page: "main", kind: "toggle",
    help: "Shows positions, PnL and balances in SOL (on) or USD (off); the exit rules always read the SOL PnL. Not display-only: with it off, operator positions adopted from then on get no SOL capital baseline (amount_sol), and the fee-claim check compares fees in USD with minClaimAmount instead of converting that to SOL. The legacy *_usd fields and pnl % of records closed from then on follow this mode, so switching it mixes units in the history.",
    accepts: "tap to switch on / off",
  },

  // ─── Risk ───────────────────────────────────────────────────────────────
  deployAmountSol: {
    label: "Deploy SOL", page: "risk", kind: "number", unit: "SOL", digits: 2,
    check: { min: 0, minExclusive: true },
    help: "Smallest deploy size: any deploy under the larger of this and 0.1 SOL is refused (manual /deploy too), so a value under 0.1 acts as 0.1. The bot's size is (wallet SOL − gas reserve) × positionSizePct (default 0.5), kept between this and Max SOL; a lower-conviction pick deploys at exactly this. Screening is skipped while the wallet holds less than this + the gas reserve.",
    accepts: "a number of SOL above 0",
  },
  gasReserve: {
    label: "Gas reserve", page: "risk", kind: "number", unit: "SOL", digits: 2,
    check: { min: 0 },
    help: "SOL always left in the wallet for fees. A deploy needs its amount + this in the wallet, and the automatic deploy size is computed from the wallet minus this. Raising it makes deploys smaller, or skips them when SOL is short.",
    accepts: "a number of SOL, 0 or more",
  },
  maxPositions: {
    label: "Max positions", page: "risk", kind: "number", unit: "", digits: 0,
    check: { min: 0, integer: true },
    help: "Most open positions at once, bot and operator positions together. At the cap the screener does not run and every new deploy is refused (manual /deploy too); held positions count unless Excl HOLD from Max Pos is on. 0 = no new deploys.",
    accepts: "a whole number, 0 or more",
  },
  maxPositionsExcludeHold: {
    label: "Excl HOLD from Max Pos", page: "risk", kind: "toggle",
    help: "On: positions on HOLD do not count toward Max positions, so the bot can open new ones beside them, and total exposure is then limited only by free SOL. Off (the default): held positions use up slots.",
    accepts: "tap to switch on / off",
  },
  maxDeployAmount: {
    label: "Max SOL", page: "risk", kind: "number", unit: "SOL", digits: 2,
    check: { min: 0, minExclusive: true },
    help: "Largest size of one position in SOL. A deploy above it is refused (manual /deploy too) and the automatic deploy size never exceeds it.",
    accepts: "a number of SOL above 0",
  },
  takeProfitPct: {
    label: "TP %", page: "risk", kind: "number", unit: "%", digits: 1,
    check: { min: 0, minExclusive: true },
    help: "Fixed take-profit: closes a position once its PnL on capital reaches this %. Bot and operator positions; not checked on HELD positions, inside a profit grace, or on a suspect reading.",
    accepts: "a % above 0 (\"off\" is not accepted: it would turn into the default 35 % on the next restart)",
  },
  stopLossPct: {
    label: "SL %", page: "risk", kind: "number", unit: "%", digits: 1,
    check: { max: 0, maxExclusive: true },
    help: "Stop loss: closes a position once its PnL on capital is at or under this % (a negative number). Bot and operator positions; never run on HELD positions and paused inside a profit grace (profitGraceStopLossMode=paused, the default). A lower number waits for a deeper loss.",
    accepts: "a negative %, e.g. -15 (\"off\" is not accepted: it would turn into the default -15 % on the next restart)",
  },
  trailingTakeProfit: {
    label: "Trailing TP", page: "risk", kind: "toggle",
    help: "On: once a position's confirmed peak reaches Trail trigger, it is closed when PnL falls Trail drop points below that peak. Off: no position arms it any more, but one already armed keeps its trailing exit. Bot and operator positions; never on HELD positions or inside a profit grace.",
    accepts: "tap to switch on / off",
  },
  trailingTriggerPct: {
    label: "Trail trigger", page: "risk", kind: "number", unit: "%", digits: 1,
    check: { min: 0, minExclusive: true },
    help: "Confirmed peak PnL (%) at which the trailing take-profit arms. Lower arms it on smaller gains; higher leaves positions that peak under it without a trailing exit. Ignored while Trailing TP is off (no position arms then).",
    accepts: "a % above 0",
  },
  trailingDropPct: {
    label: "Trail drop", page: "risk", kind: "number", unit: "pp", digits: 1,
    check: { min: 0, minExclusive: true },
    help: "Once armed, a position is closed when PnL falls this many percentage points below its confirmed peak (1.5 → a peak of 5 % closes at 3.5 %). Smaller keeps more of the peak but exits on smaller dips. Applies to armed positions: with Trailing TP off no new position arms, but one already armed still uses this.",
    accepts: "a number of percentage points above 0",
  },
  trailingMinPnlPct: {
    label: "Trail floor", page: "risk", kind: "number", unit: "%", digits: 1, nullable: true,
    help: "Optional PnL floor for an armed trailing exit: it closes at whichever is higher, peak − Trail drop or this floor, so a floor makes it close sooner, never later. Off (the default) = no floor. Applies to armed positions: with Trailing TP off no new position arms, but one already armed still uses this.",
    accepts: "a % (may be negative), or \"off\" to clear",
  },
  trailingOvershootPct: {
    label: "Trail overshoot", page: "risk", kind: "number", unit: "pp", digits: 1,
    check: { min: 0 },
    help: "An armed trailing breach is normally confirmed on a second reading; a first reading at least this many points under the threshold closes at once (0 = always wait). Applies to armed positions: with Trailing TP off no new position arms, but one already armed still uses this.",
    accepts: "a number of percentage points, 0 or more",
  },
  toxicConversionEnabled: {
    label: "Toxic Conv Guard", page: "risk", kind: "toggle",
    help: "Closes a position that has turned at least Toxic Conv % of its value into the token within 20 minutes of deploy while its fees are under 1.5 %. Off by default since 2026-09-25: its only two live fires closed operator dip ladders that were doing what they were placed to do.",
    accepts: "tap to switch on / off",
  },
  toxicConversionThresholdPct: {
    label: "Toxic Conv %", page: "risk", kind: "number", unit: "%", digits: 0,
    check: { min: 0, max: 100 },
    help: "Share of the position's value (%) that must have turned into the token for the toxic-conversion guard to close it. Ignored while Toxic Conv Guard is off (the default).",
    accepts: "a % from 0 to 100",
  },

  // ─── Screen ─────────────────────────────────────────────────────────────
  topPerformersEnabled: {
    label: "Top Performers", page: "screen", kind: "toggle",
    help: "Adds up to Top limit pools from Meteora's Top Performers (24h) list to each screening's candidates. They pass the same safety gates as any pool, except the −20 % window-dump rule. One that is deployed without bins from the model gets 69 bins spot, overriding Min / Max bins and Strategy for that deploy.",
    accepts: "tap to switch on / off",
  },
  topPerformersRequireTrend: {
    label: "Top Trend Filter", page: "screen", kind: "toggle",
    help: "Inert: no code reads this key since the Top-Performer trend gate was removed with fee-rate admission (2026-09-26); switching it changes nothing. The harvest straddle has its own trend check (harvestStraddleTrend*).",
    accepts: "tap to switch on / off (no effect)",
  },
  topPerformerTrendTimeframe: {
    label: "Top TF", page: "screen", kind: "choice", choices: ["5m", "15m"], button: "Top TF",
    help: "Inert: candle timeframe of the removed Top-Performer trend gate; no code reads this key since 2026-09-26.",
    accepts: "5m or 15m (no effect)",
  },
  topPerformersMinTvl: {
    label: "Top min TVL ($)", page: "screen", kind: "number", unit: "$", digits: 0,
    check: { min: 0 },
    help: "Inert: no code reads this key. Top Performers are held to the same TVL rules as every other pool (the $10,000 rug floor and minTvl).",
    accepts: "a $ amount, 0 or more (no effect)",
  },
  topPerformersLimit: {
    label: "Top limit", page: "screen", kind: "number", unit: "", digits: 0,
    check: { min: 1, max: 20, integer: true },
    help: "How many pools from the Top Performers list are added per screening (one request returns at most 20). Ignored while Top Performers is off.",
    accepts: "a whole number from 1 to 20",
  },
  topPerformerTrendCandles: {
    label: "Top trend candles", page: "screen", kind: "number", unit: "", digits: 0,
    check: { min: 1, integer: true },
    help: "Inert: candle count of the removed Top-Performer trend gate; no code reads this key since 2026-09-26.",
    accepts: "a whole number, 1 or more (no effect)",
  },
  minTxPerMin: {
    label: "Min Tx/min", page: "screen", kind: "number", unit: "swaps/min", digits: 1,
    check: { min: 0 },
    help: "Minimum swaps per minute (over the screening window) for a pool to be admitted or deployed into. The window caps it: at the 1h timeframe (the default) anything above 2 acts as 2, at 24h as 0.8; only 5m uses it as set. New deploys only, not the re-check before a straddle; 0 = off.",
    accepts: "a number, 0 or more",
  },
  minVolumeTvlRatio: {
    label: "Min Vol/TVL", page: "screen", kind: "number", unit: "× TVL", digits: 2,
    check: { min: 0 },
    help: "Minimum pool volume over the screening window divided by pool TVL (0.05 = volume of 5 % of TVL). Pools under it are not admitted and a deploy into one is refused, including the re-check before a straddle. 0 = off.",
    accepts: "a ratio, 0 or more (0.05 = 5 % of TVL)",
  },
  blockPvpSymbols: {
    label: "PVP hard block", page: "screen", kind: "toggle",
    help: "On: a candidate whose token symbol is also used by a rival token with a real pool is removed before the screening model sees it. Off: it stays, marked as a PVP risk for the model. Needs avoidPvpSymbols (on by default).",
    accepts: "tap to switch on / off",
  },
  managementIntervalMin: {
    label: "Manage interval", page: "screen", kind: "number", unit: "min", digits: 0,
    check: { min: 1, max: 60, integer: true },
    help: "How often the management cycle runs (pool-data exits such as the TVL exit, fee claims, the management model); the PnL poller checks prices every few seconds regardless. Only divisors of 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60) give an even schedule: others run at the minutes divisible by it in each hour (45 → :00 and :45). The schedule restarts at once.",
    accepts: "whole minutes from 1 to 60",
  },
  screeningIntervalMin: {
    label: "Screen interval", page: "screen", kind: "number", unit: "min", digits: 0,
    check: { min: 1, max: 60, integer: true },
    help: "How often screening looks for a new deploy (it also starts after a management cycle when a slot is free); each run can call the screening model. Only divisors of 60 (1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60) give an even schedule: others run at the minutes divisible by it in each hour (7 → a short gap at the top of the hour). The schedule restarts at once.",
    accepts: "whole minutes from 1 to 60",
  },

  // ─── Strategy ───────────────────────────────────────────────────────────
  strategy: {
    label: "Strategy", page: "strategy", kind: "choice", choices: ["spot", "bid_ask"],
    help: "Liquidity shape of new bot deploys: spot spreads the SOL evenly over the range, bid_ask puts more of it toward the lower end, away from the price. The screening model is told to always use it, but a shape the model passes or the Top-Performer hint (spot) overrides it for that deploy.",
    accepts: "spot or bid_ask",
  },
  minBinsBelow: {
    label: "Min bins", page: "strategy", kind: "number", unit: "bins", digits: 0,
    check: { integer: true },
    help: "Narrowest range a new deploy may use, in bins below the price. The screener scales the width from Min bins (calm pools) to Max bins (volatility 5 and up), and a deploy narrower than this is refused.",
    accepts: "a whole number (values outside 35–69 are clamped to it)",
  },
  maxBinsBelow: {
    label: "Max bins", page: "strategy", kind: "number", unit: "bins", digits: 0,
    check: { integer: true },
    help: "Widest range the screener picks, in bins below the price, used for the most volatile pools (volatility 5 and up). Never above 69 (one position account) and never below Min bins.",
    accepts: "a whole number (values outside 35–69 are clamped to it)",
  },
  rebalanceMaxCount: {
    label: "Rebal max count", page: "strategy", kind: "number", unit: "", digits: 0,
    check: { min: 0, integer: true },
    help: "Cap on a position's re-range count + straddle count; the re-range count also counts the operator's own re-ranges in the Meteora UI, so an operator position re-ranged that often is no longer straddled by the bot. At the cap the harvest → straddle is refused and the harvest closes to cash; the operator's /rebalance ignores the cap.",
    accepts: "a whole number, 0 or more",
  },
  rebalanceBinsBelow: {
    label: "Rebal bins below", page: "strategy", kind: "number", unit: "bins", digits: 0,
    check: { integer: true },
    help: "Inert: nothing reads this key. /rebalance always uses 35 bins below and 34 above, and the harvest straddle uses harvestStraddleBins; the /config snapshot still prints it as Target Bins.",
    accepts: "a whole number (values outside 1–69 are clamped to it; no effect)",
  },
  rebalanceBinsAbove: {
    label: "Rebal bins above", page: "strategy", kind: "number", unit: "bins", digits: 0,
    check: { integer: true },
    help: "Inert: nothing reads this key. /rebalance always uses 35 bins below and 34 above, and the harvest straddle uses harvestStraddleBins; the /config snapshot still prints it as Target Bins.",
    accepts: "a whole number (values outside 1–69 are clamped to it; no effect)",
  },

  // ─── TVL exit ───────────────────────────────────────────────────────────
  tvlFloorExitMode: {
    label: "TVL exit", page: "tvl", kind: "choice", choices: ["off", "shadow", "enforce"], button: "Exit",
    help: "Closes a position and sells the remainder when its pool's TVL stays under TVL min on Min readings over Min minutes, the on-chain reserves agree and (with the distress gate on enforce) the pool also shows distress. Bot and operator positions; overrides HOLD, but not hands-off. shadow = only logs a would-close; off = never.",
    accepts: "off, shadow or enforce",
  },
  tvlFloorExitDistressMode: {
    label: "Distress gate", page: "tvl", kind: "choice", choices: ["off", "shadow", "enforce"], button: "Distress",
    help: "enforce (the default since 2026-11-28): the TVL exit closes only when the pool also shows distress (the Loss or Dump test) on Min readings over Min minutes. shadow: TVL alone closes and the gate is only logged; off: TVL alone closes. It changes closes only while TVL exit is enforce.",
    accepts: "off, shadow or enforce",
  },
  tvlFloorExitUsd: {
    label: "TVL min", page: "tvl", kind: "number", unit: "$", digits: 0,
    check: { min: 0, minExclusive: true },
    help: "Pool TVL in $ under which the TVL exit counts readings. Also the bar for the 'pool already under the TVL-exit minimum' adoption warning and for the log-only relative TVL exit. Raising it makes the exit act on larger pools.",
    accepts: "a $ amount above 0 (0 or less would read as 10,000)",
  },
  tvlFloorExitMinReadings: {
    label: "Min readings", page: "tvl", kind: "number", unit: "readings", digits: 0,
    check: { min: 2, integer: true },
    help: "How many readings in a row (one per management cycle) must be under TVL min before the exit acts; the distress gate needs as many distress readings. More readings = later but surer.",
    accepts: "a whole number, 2 or more (fewer would read as 3)",
  },
  tvlFloorExitMinMinutes: {
    label: "Min minutes", page: "tvl", kind: "number", unit: "min", digits: 0,
    check: { min: 0 },
    help: "Shortest time those readings must span, in minutes; the distress readings must span it too. With the default 3-minute management cycle, 3 readings already span about 6 minutes.",
    accepts: "a number of minutes, 0 or more",
  },
  tvlFloorExitLossPct: {
    label: "Loss ≤ %", page: "tvl", kind: "number", unit: "%", digits: 1,
    help: "Distress by loss: the position's PnL on capital at or under this % (the thin-pool hold limit's figure, so a partial withdrawal cannot fake it). Lower waits for a deeper loss before a thin pool is exited. No effect on closes unless the distress gate is enforce.",
    accepts: distressAccepts("tvlFloorExitLossPct", "%"),
  },
  tvlFloorExitPriceDropPct: {
    label: "No-PnL price ≤ %", page: "tvl", kind: "number", unit: "%", digits: 1,
    help: "Used instead of the loss test on a reading without a usable PnL: the price since entry at or under this % counts as distress. No effect on closes unless the distress gate is enforce. With no recorded entry bin, \"since entry\" means since the first reading under the minimum.",
    accepts: distressAccepts("tvlFloorExitPriceDropPct", "%"),
  },
  tvlFloorExitDumpTurnover: {
    label: "Dump turnover", page: "tvl", kind: "number", unit: "× TVL", digits: 2,
    help: "Distress by dump: the pool's hourly volume at least this many × pool TVL, with the price at or under Dump price % since entry. Higher needs heavier selling; no effect on closes unless the distress gate is enforce. With no recorded entry bin, \"since entry\" means since the first reading under the minimum.",
    accepts: distressAccepts("tvlFloorExitDumpTurnover", "× pool TVL per hour"),
  },
  tvlFloorExitDumpPricePct: {
    label: "Dump price ≤ %", page: "tvl", kind: "number", unit: "%", digits: 1,
    help: "The price fall since entry (%) the dump test needs together with Dump turnover. Lower needs a bigger fall; no effect on closes unless the distress gate is enforce. With no recorded entry bin, \"since entry\" means since the first reading under the minimum.",
    accepts: distressAccepts("tvlFloorExitDumpPricePct", "%"),
  },
});

/** The help entry for a config key, or null. */
export function settingHelp(key) {
  return Object.prototype.hasOwnProperty.call(SETTINGS_HELP, key) ? SETTINGS_HELP[key] : null;
}
