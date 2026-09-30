process.env.OPENAI_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

// Balance audit 2026-09-30: the operator's Meteora limit orders sit outside AUM, so the
// wallet reconciliation read the JEANPHIL-SOL order (0.917 SOL placed 09-21, 1.306 SOL
// withdrawn 09-22) as +1.19 SOL of drift; and the deposit scan could skip a
// transaction for good when the RPC returned null for it.
import { test } from "node:test";
import assert from "node:assert/strict";

const { getOpenLimitOrderValue, getLimitOrderFlows, orderFlowsBetween } = await import("../limit-orders.js");
const { reconcile } = await import("../ledger-truth.js");
const { walkSignaturesInOrder } = await import("../tools/wallet.js");

const H = 3600e3;
const t0 = Date.parse("2026-09-22T21:11:00Z");
const jeanphil = { address: "LO1", pool: "P1", status: "closed", opened_ms: t0 - 34 * H, deposit_sol: 0.9174, closed_ms: t0 + 0.4 * H, withdrawal_sol: 1.3062 };
const sellOrder = { address: "LO2", pool: "P2", status: "open", opened_ms: t0 + 2 * H, deposit_sol: 0.8886, closed_ms: null, withdrawal_sol: 0 };

test("order flows: placement out, withdrawal in, realized P&L of orders closed in the window", () => {
  const f = orderFlowsBetween([jeanphil, sellOrder], t0, t0 + 24 * H);
  assert.equal(f.placed, 1);
  assert.equal(f.closed, 1);
  assert.ok(Math.abs(f.out_sol - 0.8886) < 1e-9);
  assert.ok(Math.abs(f.in_sol - 1.3062) < 1e-9);
  assert.ok(Math.abs(f.realized_sol - (1.3062 - 0.9174)) < 1e-9, "placed before the window, still realized inside it");
  assert.deepEqual(orderFlowsBetween([jeanphil], t0 + 24 * H, t0 + 48 * H), { out_sol: 0, in_sol: 0, realized_sol: 0, placed: 0, closed: 0 });
});

test("reconcile: a limit-order withdrawal is a transfer in, not unexplained drift", () => {
  // The day ending 09-23: AUM +1.061 with the order's 1.306 landing in the wallet.
  const without = reconcile({ aumStart: 1.121, aumEnd: 2.182, ledgerNet: -0.005, unrealStart: 0, unrealEnd: -0.123 });
  const withOrders = reconcile({ aumStart: 1.121, aumEnd: 2.182, ordersIn: 1.3062, ledgerNet: -0.005, unrealStart: 0, unrealEnd: -0.123 });
  assert.ok(without.drift > 1.1);
  assert.ok(Math.abs(withOrders.drift) < 0.15, `got ${withOrders.drift}`);
  assert.equal(withOrders.limit_orders_in, 1.3062);
  // A placement moves AUM down by the escrow; booked as a transfer out it nets to zero.
  assert.equal(reconcile({ aumStart: 2.0, aumEnd: 1.5, ordersOut: 0.5 }).drift, 0);
});

const page = (data) => ({ ok: true, json: async () => ({ total: data.length, pages: 1, current_page: 1, page_size: 100, data }) });

test("open-order value sums the pool summaries and survives a feed blip for a while", async () => {
  const pools = [
    { pool: { pool_address: "P2" }, total_orders: 1, total_current_value_sol: "0.0145", total_current_value_usd: "1.72" },
    { pool: { pool_address: "P3" }, total_orders: 1, total_current_value_sol: "0.0365", total_current_value_usd: "4.33" },
  ];
  const v = await getOpenLimitOrderValue("WALLET_V", { fetchImpl: async () => page(pools), now: 1_000_000 });
  assert.ok(Math.abs(v.sol - 0.051) < 1e-9);
  assert.equal(v.count, 2);
  const down = async () => ({ ok: false, status: 503 });
  const stale = await getOpenLimitOrderValue("WALLET_V", { fetchImpl: down, now: 1_000_000 + 5 * 60e3 });
  assert.equal(stale.stale, true);
  assert.ok(Math.abs(stale.sol - 0.051) < 1e-9);
  assert.equal(await getOpenLimitOrderValue("WALLET_V", { fetchImpl: down, now: 1_000_000 + 20 * 60e3 }), null);
});

test("order history reads open and closed orders with their timestamps and SOL values", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/open/pools/P2")) return page([{ limit_order_address: "LO2", opened_at: 1789962731, input_amount_sol: "0.8886" }]);
    if (url.includes("/open/pools")) return page([{ pool: { pool_address: "P2" }, total_orders: 1 }]);
    if (url.includes("/closed/pools/P1")) return page([{ limit_order_address: "LO1", opened_at: 1789987544, total_deposit_sol: "0.9174", last_closed_at: 1790112876, total_withdrawal_sol: "1.3062" }]);
    if (url.includes("/closed/pools")) return page([{ pool: { pool_address: "P1" } }]);
    throw new Error(`unexpected ${url}`);
  };
  const orders = await getLimitOrderFlows("WALLET_F", { fetchImpl, now: 1 });
  const lo1 = orders.find((o) => o.address === "LO1");
  const lo2 = orders.find((o) => o.address === "LO2");
  assert.equal(lo1.closed_ms, 1790112876 * 1000);
  assert.equal(lo1.withdrawal_sol, 1.3062);
  assert.equal(lo2.closed_ms, null);
  assert.equal(lo2.deposit_sol, 0.8886);
});

test("deposit scan stops at an unfetchable transaction and checkpoints before it", async () => {
  const sigs = ["s1", "s2", "s3", "s4"].map((signature) => ({ signature }));
  const seen = [];
  const walk = await walkSignaturesInOrder(sigs, async (s) => (s.signature === "s3" ? null : { tx: s.signature }), (s) => seen.push(s.signature));
  assert.deepEqual(seen, ["s1", "s2"]);
  assert.equal(walk.checkpoint, "s2", "the next scan resumes after s2, so s3 is retried");
  assert.equal(walk.stoppedAt, "s3");
  const all = await walkSignaturesInOrder(sigs, async (s) => ({ tx: s.signature }), () => {});
  assert.equal(all.checkpoint, "s4");
  assert.equal(all.stoppedAt, null);
  const none = await walkSignaturesInOrder(sigs, async () => null, () => {});
  assert.equal(none.checkpoint, null, "nothing handled → the old checkpoint is kept");
});
