/**
 * limit-order-menu.js — text and keyboards of the Telegram /orders menu and the
 * "order closed" notice. Pure rendering: the handlers in index.js fetch the feed rows
 * (limit-orders.js listOpenLimitOrders), re-read each order on chain at every tap
 * (tools/limit-order-close.js inspectLimitOrder) and run the close.
 *
 * Callback data: ord:list · ord:dismiss · ord:view:<order> · ord:confirm:<order> ·
 * ord:go:<order> (≤ 56 bytes; Telegram allows 64).
 */
import { escapeHTML, solscanTx, solscanAcct } from "./telegram.js";
import { CANCEL_BINS_PER_TX } from "./tools/limit-order-close.js";

const fmtAmount = (v, max = 6) => (Number(v) || 0).toLocaleString("en-US", { maximumFractionDigits: max });
const fmtSol = (v) => `◎${(Number(v) || 0).toFixed(4)}`;
const sideWord = (side) => (side === "ask" ? "sell" : side === "bid" ? "buy" : "order");
const shortAddr = (a) => (a ? `${String(a).slice(0, 4)}…${String(a).slice(-4)}` : "?");

/** "Withdraw proceeds" once nothing is left to cancel, else "Cancel order". */
export function closeActionLabel(fullyFilled) {
  return fullyFilled ? "Withdraw proceeds" : "Cancel order";
}

function rowLine(o) {
  const value = o.value_usd > 0 ? `${fmtSol(o.value_sol)} ($${o.value_usd.toFixed(2)})` : fmtSol(o.value_sol);
  return `${escapeHTML(o.pair || shortAddr(o.pool))} · ${sideWord(o.side)} ${fmtAmount(o.input_amount)} ${escapeHTML(o.input_token || "")} · ${fmtAmount(o.filled_pct, 1)}% filled · ${value}`;
}

export function renderOrdersMenu(orders) {
  const list = Array.isArray(orders) ? orders : [];
  const closable = list.filter((o) => o.address && o.pool);
  const uiOnly = list.filter((o) => !(o.address && o.pool));
  const lines = [
    `📒 <b>Meteora limit orders</b> (${list.length} open)`,
    ``,
    list.length
      ? `<i>Tap an order to review it. Closing cancels what is unfilled and withdraws what is filled; the tokens stay in the wallet.</i>`
      : `<i>No open limit orders for the bot wallet.</i>`,
  ];
  if (uiOnly.length) {
    lines.push(``, `<b>Close in the Meteora UI</b> (the feed gives no order address)`);
    for (const o of uiOnly) lines.push(`• ${rowLine(o)}`);
  }
  const buttons = closable.map((o) => [{
    text: `${o.pair || shortAddr(o.pool)} · ${sideWord(o.side)} ${fmtAmount(o.input_amount, 2)} ${o.input_token || ""} · ${fmtAmount(o.filled_pct, 0)}% · ${fmtSol(o.value_sol)}`.slice(0, 60),
    callback_data: `ord:view:${o.address}`,
  }]);
  const controls = [[{ text: "🔄 Refresh", callback_data: "ord:list" }, { text: "❌ Close Menu", callback_data: "ord:dismiss" }]];
  return { text: lines.join("\n"), keyboard: [...buttons, ...controls] };
}

function chainLines(chain) {
  const s = chain.summary;
  const out = [
    `• <b>Side:</b> ${s.side === "ask" ? "ask (sell)" : "bid (buy)"}`,
    `• <b>Filled:</b> ${fmtAmount(s.filled_pct, 2)}%`,
    `• <b>Bins:</b> ${chain.bins} open of ${s.bin_count}`,
    `• <b>Returns now:</b> ${fmtAmount(s.expected.base)} ${escapeHTML(s.base_symbol || "base")} + ${fmtSol(s.expected.sol)}`,
    `• <b>Rent back:</b> ≈ ${fmtSol(chain.rent_sol)}`,
  ];
  if (s.expected.quote) out.splice(4, 0, `• <b>Quote:</b> ${fmtAmount(s.expected.quote.amount)} ${escapeHTML(s.expected.quote.symbol || "")}`);
  return out;
}

/** `row` is the feed row, `chain` the fresh inspectLimitOrder result (status "open"). */
export function renderOrderCard(row, chain) {
  const action = closeActionLabel(chain.summary.fully_filled);
  const text = [
    `📒 <b>${escapeHTML(chain.summary.pool_name || row.pair || "Limit order")}</b>`,
    ``,
    `• <b>Order:</b> <a href="${solscanAcct(row.address)}">${shortAddr(row.address)}</a>`,
    ...chainLines(chain),
    row.value_sol > 0 ? `• <b>Value (feed):</b> ${fmtSol(row.value_sol)}${row.value_usd > 0 ? ` ($${row.value_usd.toFixed(2)})` : ""}` : null,
    ``,
    `<i>Figures are read from the order account just now.</i>`,
  ].filter((l) => l !== null).join("\n");
  return {
    text,
    keyboard: [
      [{ text: `🧾 ${action}`, callback_data: `ord:confirm:${row.address}` }],
      [{ text: "⬅️ Back", callback_data: "ord:list" }],
    ],
  };
}

export function renderConfirmOrderCard(row, chain, { dryRun = false } = {}) {
  const action = closeActionLabel(chain.summary.fully_filled);
  const s = chain.summary;
  const text = [
    `⚠️ <b>Confirm: ${action}</b> — ${escapeHTML(s.pool_name || row.pair || "")}`,
    ``,
    `${s.fully_filled ? "Withdraw" : "Cancel the unfilled part and withdraw"} ${fmtAmount(s.expected.base)} ${escapeHTML(s.base_symbol || "base")} + ${fmtSol(s.expected.sol)} to the wallet?`,
    ``,
    `<i>${chain.bins > CANCEL_BINS_PER_TX ? `${Math.ceil(chain.bins / CANCEL_BINS_PER_TX)} transactions` : "One transaction"}, simulated first. The order account is closed and its rent returned. The returned tokens are not swapped.</i>`,
    dryRun ? `🧪 <i>DRY_RUN: the transaction will be simulated, not sent.</i>` : null,
  ].filter((l) => l !== null).join("\n");
  return {
    text,
    keyboard: [
      [{ text: `🔴 Yes, ${action.toLowerCase()}`, callback_data: `ord:go:${row.address}` }],
      [{ text: "❌ Cancel", callback_data: `ord:view:${row.address}` }],
    ],
  };
}

function returnedLine(result) {
  const r = result.returned || {};
  const parts = [];
  if (Number(r.base) > 0) parts.push(`${fmtAmount(r.base)} ${escapeHTML(r.base_symbol || "base")}`);
  if (Number(r.sol) > 0) parts.push(`◎${Number(r.sol).toFixed(6)}`);
  if (Number(r.quote?.amount ?? r.quote) > 0) parts.push(`${fmtAmount(r.quote?.amount ?? r.quote)} ${escapeHTML(r.quote?.symbol || "quote")}`);
  return parts.length ? parts.join(" + ") : "nothing";
}

const txLinks = (txs) => (txs || []).filter(Boolean).map((tx, i, a) => `<a href="${solscanTx(tx)}">tx${a.length > 1 ? i + 1 : ""}</a>`).join(" · ");

/** Result text for the /orders menu and (on a real close) the dashboard-triggered notice. */
export function renderOrderCloseResult(result, { pair = null, source = null } = {}) {
  const name = escapeHTML(result?.pool_name || pair || "limit order");
  if (!result?.success) {
    const landed = (result?.txs || []).length ? `\n• Landed before the failure: ${txLinks(result.txs)}` : "";
    return `❌ <b>Limit order not closed</b> — ${name}\n<code>${escapeHTML(result?.error || "unknown error")}</code>${landed}`;
  }
  if (result.already_closed) return `ℹ️ <b>${name}:</b> the order was already closed.`;
  const side = result.side ? ` (${result.side}, ${fmtAmount(result.filled_pct, 2)}% filled)` : "";
  if (result.dry_run) {
    return `🧪 <b>DRY_RUN — ${name}</b>${side}\nSimulation passed; nothing was sent.\n• Would return: ${returnedLine(result)}\n• Rent back: ≈ ${fmtSol(result.rent_sol)}`;
  }
  return [
    `📒 <b>Limit order closed — ${name}</b>${side}`,
    `• Returned: ${returnedLine(result)}`,
    `• Rent back: ◎${(Number(result.rent_sol) || 0).toFixed(6)}`,
    source ? `• Via: ${escapeHTML(source)}` : null,
    (result.txs || []).length ? `🔗 ${txLinks(result.txs)}` : null,
  ].filter(Boolean).join("\n");
}
