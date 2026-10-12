// close-audit-group.js — audit positions of ONE token whose lifetimes overlap as a group.
//
// 2026-10-12 (operator approved). The close audit (close-audit.js) gives no verdict when another
// position in the same base token overlapped: the wallet's swaps of the token (fee swaps, exit
// swaps, zap buys) belong to both and cannot be split, so those records keep their MODELLED
// pnl_sol_net. A read-only study showed that the GROUP is attributable: summing every wallet
// transaction that touches a member's position account or the wallet's token account of the mint
// matches the ledger wherever the truth is known (150 groups whose members all carried an applied
// wallet figure: Σ|group − ledger| = ◎0.057, largest multi-position difference ◎0.0076), and on
// the last 7 days' unsettled sets the ledger was ◎0.234 above the wallet.
//
// What this module does (everything except fetchGroupFlows is pure):
//   buildCloseGroups     closed records of one base mint whose [first position tx … last position
//                        tx + tail] windows overlap or chain together
//   classifyGroup        is the group ready? (every member closed ≥ 10 min, individually audited,
//                        no OPEN position in the token overlapping → else it waits, from the
//                        position registry alone: no chain read)
//   fetchGroupFlows      every transaction of every member + the wallet's token account(s) of the
//                        mint over the group window, each counted once, through summarizeFlows
//   evaluateGroupAudit   group wallet net W vs the members' ledger figures; the residual is spread
//                        over the members that have no wallet figure of their own
//
// The group's wallet total is a MEASUREMENT. A member's share of the residual is an ALLOCATION
// (pro rata by capital): the chain cannot say which sibling paid which swap.

import { summarizeFlows, isPositionOperation, CLOSE_AUDIT_VERSION } from "./close-audit.js";

// Bump when the group method changes: stored group verdicts of an older version are redone.
export const CLOSE_AUDIT_GROUP_VERSION = 1;
export const GROUP_TAIL_SEC = 180;
export const GROUP_MODES = ["off", "shadow", "enforce"];

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const ms = (v) => { const t = new Date(v || NaN).getTime(); return Number.isFinite(t) ? t : null; };

export function normalizeGroupMode(v, fallback = "shadow") {
  return GROUP_MODES.includes(v) ? v : fallback;
}

/** What ledger-truth sums for a record that has no wallet figure: pnl_sol_net, else pnl_sol − gas. */
export function modelledNetOf(r) {
  const m = num(r?.pnl_sol_net_modelled);
  if (m != null) return m;
  const n = num(r?.pnl_sol_net);
  if (n != null) return n;
  const p = num(r?.pnl_sol);
  return p != null ? p - (num(r?.total_gas_sol) ?? 0) : null;
}

/** A member whose own audit put the wallet figure on the record: left untouched by the group. */
export function isIndividuallySettled(r) {
  return r?.chain_audit?.applied === true && r?.pnl_sol_net_source !== "wallet_group";
}

const capitalOf = (r) => num(r?.amount_sol) ?? num(r?.deposit_sol_true) ?? 0;

/**
 * A record's on-chain window in unix seconds. Exact when a chain read stored it (`tx_window`,
 * written by the close audit and by the group audit); otherwise an estimate from the record:
 * the close is at or before `recorded_at`, the first transaction at or before recorded_at −
 * minutes_held (10 min of slack: an adopted account is backdated from its on-chain age). The
 * estimate errs wide; the group audit replaces it with the exact window before it counts.
 */
export function recordWindow(r, { startSlackSec = 600 } = {}) {
  const w = r?.tx_window;
  if (w && num(w.t0) != null && num(w.t1) != null && w.t1 >= w.t0) return { t0: Number(w.t0), t1: Number(w.t1), exact: true };
  const end = ms(r?.recorded_at);
  if (end == null) return null;
  const held = Math.max(0, num(r?.minutes_held) ?? 0);
  return { t0: Math.floor(end / 1000 - held * 60 - startSlackSec), t1: Math.ceil(end / 1000), exact: false };
}

/** Stable name of a group: the base mint and its earliest member. */
export function groupId(mint, members) {
  return `${String(mint).slice(0, 8)}:${String(members[0]?.position || "").slice(0, 8)}`;
}

/**
 * Group closed records. Same base mint, windows [t0 … t1 + tailSec] overlapping or chaining
 * together (the transitive closure — for intervals that is one sweep in start order).
 * Returns every group, single-member ones included, oldest first.
 */
export function buildCloseGroups(records, { tailSec = GROUP_TAIL_SEC } = {}) {
  // One record per position: the LAST one, as every store lookup does (findPerfByPosition) —
  // a few 2026-09 positions carry two records.
  const last = new Map();
  for (const r of records || []) if (r?.position && r?.base_mint) last.set(r.position, r);
  const byMint = new Map();
  for (const r of last.values()) {
    const w = recordWindow(r);
    if (!w) continue;
    if (!byMint.has(r.base_mint)) byMint.set(r.base_mint, []);
    byMint.get(r.base_mint).push({ rec: r, ...w });
  }
  const groups = [];
  for (const [mint, list] of byMint) {
    list.sort((a, b) => (a.t0 - b.t0) || String(a.rec.position).localeCompare(String(b.rec.position)));
    let g = null;
    for (const m of list) {
      if (g && m.t0 <= g.t1 + tailSec) {
        g.members.push(m.rec); g.t1 = Math.max(g.t1, m.t1); g.exact = g.exact && m.exact;
      } else {
        g = { mint, t0: m.t0, t1: m.t1, exact: m.exact, members: [m.rec] };
        groups.push(g);
      }
    }
  }
  for (const g of groups) {
    g.id = groupId(g.mint, g.members);
    g.last_close_ms = Math.max(...g.members.map((r) => ms(r.recorded_at) ?? 0));
  }
  return groups.sort((a, b) => a.last_close_ms - b.last_close_ms);
}

/** Does this record still have an individual audit coming (the normal queue's rules)? */
export function awaitsIndividualAudit(r, { now = Date.now(), version = CLOSE_AUDIT_VERSION, maxAgeHours = 24 } = {}) {
  if (!r?.position || !r?.base_mint || r.rebalance_leg) return false; // never audited individually
  const t = ms(r.recorded_at);
  if (t == null || now - t > maxAgeHours * 3600_000) return false;    // out of the queue's reach
  const a = r.chain_audit;
  const current = a && a.status != null && a.version === version;
  if (!current) return true;
  if ((a.attempts ?? 0) >= 3) return false;
  return a.status === "pending" || a.retry === true;
}

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
const memberKey = (members) => members.map((r) => r.position).sort();
const settledKey = (members) => members.filter(isIndividuallySettled).map((r) => r.position).sort();

/** The stamp shared by every member, when it describes this very member set at this version. */
export function currentGroupStamp(group) {
  const members = memberKey(group.members);
  let first = null;
  for (const r of group.members) {
    const s = r.chain_audit?.group;
    if (!s || s.version !== CLOSE_AUDIT_GROUP_VERSION || s.audit_version !== CLOSE_AUDIT_VERSION) return null;
    if (!sameList(s.members, members)) return null;
    first ??= s;
  }
  return first;
}

/**
 * What to do with a group this cycle. Pure, and decided from the records and the position
 * registry alone — a group that waits costs no chain read:
 *   single       one member: the individual audit IS the group audit
 *   all_settled  every member already carries its own wallet figure
 *   young        a member closed < minAgeMin ago
 *   awaiting     a member's individual audit has not run yet (it decides who is settled)
 *   pending      an OPEN position in this token overlaps the window: wait until it closes
 *                (it then joins the group as a member)
 *   cached       a wallet total for exactly these members is stored: re-allocate without a read
 *   retry_later  an incomplete verdict that may be retried, not due yet
 *   final        an incomplete verdict that will not change (nothing to do)
 *   audit        read the chain
 */
export function classifyGroup(group, { openPositions = [], now = Date.now(), minAgeMin = 10, tailSec = GROUP_TAIL_SEC, retryGapMin = 30, maxAttempts = 3 } = {}) {
  if (group.members.length < 2) return { state: "single" };
  if (group.members.every(isIndividuallySettled)) return { state: "all_settled" };
  if (group.members.some((r) => now - (ms(r.recorded_at) ?? now) < minAgeMin * 60_000)) return { state: "young" };
  if (group.members.some((r) => awaitsIndividualAudit(r, { now }))) return { state: "awaiting" };
  // An open position in the same token whose life began before the group's window ended. Its
  // start is `deployed_at` (backdated from the on-chain age for an adopted account), 10 min wide.
  const open = (openPositions || []).filter((p) => p && !p.closed && p.base_mint === group.mint && p.position)
    .filter((p) => { const t = ms(p.deployed_at); return t == null || t / 1000 - 600 <= group.t1 + tailSec; })
    .map((p) => p.position).sort();
  if (open.length) return { state: "pending", open };
  const stamp = currentGroupStamp(group);
  if (stamp && (stamp.status === "group_ok" || stamp.status === "group_mismatch") && num(stamp.wallet_sol) != null) return { state: "cached", stamp };
  if (stamp && stamp.status === "group_incomplete") {
    if (stamp.retry !== true || (stamp.attempts ?? 1) >= maxAttempts) return { state: "final", stamp };
    if (now - (ms(stamp.at) ?? 0) < retryGapMin * 60_000) return { state: "retry_later", stamp };
    return { state: "audit", attempts: (stamp.attempts ?? 1) + 1 };
  }
  return { state: "audit", attempts: 1 };
}

/** Bound for applying a residual: same spirit as applyWalletNet's, on the capital it lands on. */
export function groupApplyBound(unsettledCapitalSol) {
  return Math.max(0.05, 0.05 * (num(unsettledCapitalSol) ?? 0));
}

/**
 * Spread `residual` over `unsettled` records pro rata by capital (amount_sol). This is an
 * allocation, not a measurement: the chain says what the GROUP netted, not which sibling paid
 * which swap, and capital is the only neutral key the records share (time held or fees would
 * each favour one kind of position). Members without a capital figure share equally. The shares
 * are rounded to 1e-6 and the last one takes the rounding remainder, so they sum to the residual.
 */
export function allocateResidual(unsettled, residual) {
  const out = {};
  if (!unsettled.length) return out;
  const caps = unsettled.map(capitalOf);
  const total = caps.reduce((s, c) => s + c, 0);
  const R = r6(residual);
  let left = R;
  unsettled.forEach((r, i) => {
    const share = i === unsettled.length - 1 ? r6(left) : r6(R * (total > 0 ? caps[i] / total : 1 / unsettled.length));
    out[r.position] = share;
    left -= share;
  });
  return out;
}

/**
 * Verdict for a group. `flows` is a summarizeFlows result over the union (plus the fetch's own
 * flags).
 * `{ stored: stamp }` re-allocates from a stored wallet total instead.
 *   group_ok          residual within the bound — spread over the unsettled members (enforce)
 *   group_mismatch    residual beyond max(◎0.05, 5 % of the unsettled capital): nothing applied
 *   group_incomplete  the group's flows are not attributable either: tokens do not net to zero
 *                     (an unsold remainder, tokens acquired outside), a position that is not a
 *                     member moved the token inside the window, or the history could not be read
 */
export function evaluateGroupAudit(group, flows) {
  const members = group.members;
  const settled = members.filter(isIndividuallySettled);
  const unsettled = members.filter((r) => !isIndividuallySettled(r));
  const capital = members.reduce((s, r) => s + capitalOf(r), 0);
  const unsettledCapital = unsettled.reduce((s, r) => s + capitalOf(r), 0);
  // Applied members keep their own wallet figure; the others count at the modelled one.
  let ledger = 0;
  for (const r of settled) ledger += num(r.pnl_sol_net) ?? 0;
  for (const r of unsettled) ledger += modelledNetOf(r) ?? 0;
  const base = {
    id: group.id, members: memberKey(members), settled_individually: settledKey(members),
    capital_sol: r6(capital), unsettled_capital_sol: r6(unsettledCapital), ledger_sol: r6(ledger),
    version: CLOSE_AUDIT_GROUP_VERSION, audit_version: CLOSE_AUDIT_VERSION,
  };
  if (!flows) return { status: "group_incomplete", why: "no transactions read", ...base };
  if (flows.too_large) return { status: "group_incomplete", why: `the group needs ${flows.tx_needed} transaction reads (limit ${flows.tx_limit})`, ...base };
  let wallet, extra = {};
  if (flows.stored) {
    // A wallet total already measured for exactly these members (classifyGroup "cached"): the
    // chain data of a closed group does not change, so only the allocation is redone.
    const s = flows.stored;
    wallet = Number(s.wallet_sol);
    extra = {
      tx_count: s.tx_count ?? null, rpc_reads: s.rpc_reads ?? null, residual_tokens: s.residual_tokens ?? 0,
      ...(s.open_account_rent_sol ? { open_account_rent_sol: s.open_account_rent_sol } : {}),
      ...(s.released_account_rent_sol ? { released_account_rent_sol: s.released_account_rent_sol } : {}),
    };
  } else {
    if (!(flows.tx_count > 0)) return { status: "group_incomplete", why: "no transactions read", ...base };
    const openRent = Math.max(0, num(flows.open_account_rent_sol) ?? 0);
    const releasedRent = Math.max(0, num(flows.released_account_rent_sol) ?? 0);
    wallet = flows.net_sol + openRent - releasedRent;      // the v8 / v9 rent set-asides, once for the group
    const residualTok = num(flows.net_tokens) ?? 0;
    extra = {
      tx_count: flows.tx_count, rpc_reads: flows.rpc_reads ?? null, residual_tokens: r6(residualTok),
      ...(openRent > 0 ? { open_account_rent_sol: r6(openRent) } : {}),
      ...(releasedRent > 0 ? { released_account_rent_sol: r6(releasedRent) } : {}),
    };
    const part = { wallet_sol: r6(wallet), residual_sol: r6(wallet - ledger), ...extra, ...base };
    if (flows.history_complete === false) return { status: "group_incomplete", why: "the token account's history was not read back to the group's first transaction", ...part };
    if (flows.unreadable > 0) return { status: "group_incomplete", retry: true, why: `${flows.unreadable} position transaction(s) unreadable`, ...part };
    if (flows.closing_missing?.length) return { status: "group_incomplete", retry: true, why: `the closing transaction of ${flows.closing_missing.map((a) => String(a).slice(0, 8)).join(", ")} was not among those read`, ...part };
    // A position that is not a member moved this token inside the window: an untracked position
    // (opened and closed between two scans, never adopted), one without a closed record, or one
    // whose window estimate was too narrow (its exact window is stored now and it joins next time).
    if (num(flows.sibling_position_ops) > 0) {
      const who = (flows.foreign_positions || []).map((a) => String(a).slice(0, 8)).join(", ");
      return { status: "group_incomplete", retry: flows.foreign_known === true, why: `a position outside the group moved this token inside its window${who ? ` (${who})` : " (not a tracked position)"}`, ...part };
    }
    // The wallet acquired the token and no member deposited it (and no member straddled: a
    // straddle's buy is the position's own even when it was unwound instead of deposited).
    const straddled = members.some((r) => Number(r.straddle_count) > 0 || r.lane === "straddle");
    if (num(flows.wallet_bought_tokens) > 0 && !straddled) return { status: "group_incomplete", why: "the wallet acquired this token without depositing it into a member position", ...part };
    const px = num(flows.last_swap_sol_per_token);
    const residualSol = px != null ? Math.abs(residualTok) * px : null;
    const dustFloor = Math.max(0.0005, 0.001 * capital);
    const unpricedDust = residualSol == null && residualTok > 1e-6 && Math.abs(ledger - wallet) <= dustFloor;
    const residualMatters = !unpricedDust && Math.abs(residualTok) > 1e-6 && (residualSol == null || residualSol > Math.max(0.002, 0.005 * capital));
    if (residualMatters) {
      const why = flows.tail_cutoff_time != null ? "another position in this token started before the group's remainder was sold" : "token flows of the group do not net to zero";
      return { status: "group_incomplete", why, residual_token_sol: residualSol != null ? r6(residualSol) : null, ...part };
    }
  }
  const residual = wallet - ledger;
  const bound = groupApplyBound(unsettledCapital);
  const within = Math.abs(residual) <= bound;
  return {
    status: within ? "group_ok" : "group_mismatch",
    wallet_sol: r6(wallet), residual_sol: r6(residual), bound_sol: r6(bound),
    shares: within ? allocateResidual(unsettled, residual) : {},
    ...extra, ...base,
  };
}

/** The wallet's associated token accounts of a mint (SPL Token and Token-2022). */
export function walletTokenAccounts(PublicKey, wallet, mint) {
  const ata = new PublicKey(ATA_PROGRAM);
  return [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map((p) =>
    PublicKey.findProgramAddressSync([new PublicKey(wallet).toBuffer(), new PublicKey(p).toBuffer(), new PublicKey(mint).toBuffer()], ata)[0].toBase58());
}

const keysOf = (tx) => (tx?.transaction?.message?.accountKeys || []).map((k) => (k?.pubkey ?? k)?.toString?.() ?? String(k));
const CLOSES_POSITION = /Instruction: ClosePosition/;

/** Keep what summarizeFlows reads (a session holds transactions across cycles). */
function trimTx(tx, sigInfo, wallet) {
  const own = (l) => (l || []).filter((b) => b?.owner === wallet);
  return {
    signature: sigInfo.signature, slot: tx.slot ?? sigInfo.slot, blockTime: tx.blockTime ?? sigInfo.blockTime,
    transaction: { message: { accountKeys: keysOf(tx) } },
    meta: {
      err: tx.meta?.err ?? null, preBalances: tx.meta?.preBalances, postBalances: tx.meta?.postBalances,
      preTokenBalances: own(tx.meta?.preTokenBalances), postTokenBalances: own(tx.meta?.postTokenBalances),
      logMessages: (tx.meta?.logMessages || []).filter((l) => typeof l === "string" && /Instruction: /.test(l)),
    },
  };
}

/**
 * Pure half of the fetch: flows of the group from its transactions.
 *   memberTxs  Map(position → [tx]) — each member's own transactions
 *   tokenTxs   transactions of the wallet's token account(s) of the mint in the window
 * A transaction listed more than once (two members, or a member and the token account) is
 * counted ONCE, by signature.
 */
export function summarizeGroupFlows({ members, memberTxs, tokenTxs = [], wallet, baseMint, knownAddresses = [] }) {
  const pos = new Map();
  const windows = {};
  const closingMissing = [];
  for (const r of members) {
    const txs = (memberTxs.get(r.position) || []).filter(Boolean);
    const times = txs.map((t) => Number(t.blockTime) || 0).filter((t) => t > 0);
    if (times.length) windows[r.position] = { t0: Math.min(...times), t1: Math.max(...times) };
    // The close must be among the transactions read (a rate-limited listing can come back
    // short): the account's closing instruction, or a transaction within 5 min of the record.
    const closedAt = (ms(r.recorded_at) ?? 0) / 1000;
    const sawClose = txs.some((t) => (t.meta?.logMessages || []).some((l) => CLOSES_POSITION.test(l)));
    if (!sawClose && !(times.length && closedAt - Math.max(...times) <= 300)) closingMissing.push(r.position);
    for (const t of txs) pos.set(t.signature ?? `${t.slot}:${pos.size}`, t);
  }
  const walletTxs = [];
  const seen = new Set(pos.keys());
  for (const t of tokenTxs) {
    if (!t || seen.has(t.signature)) continue;
    seen.add(t.signature);
    walletTxs.push(t);
  }
  const flows = summarizeFlows({ posTxs: [...pos.values()], walletTxs, wallet, baseMint });
  // Which positions do the wallet-side position operations belong to?
  const memberSet = new Set(members.map((r) => r.position));
  const known = new Set(knownAddresses);
  const foreign = new Set();
  for (const t of walletTxs) {
    if (!isPositionOperation(t)) continue;
    for (const k of keysOf(t)) if (known.has(k) && !memberSet.has(k)) foreign.add(k);
  }
  return { ...flows, windows, closing_missing: closingMissing, foreign_positions: [...foreign], foreign_known: foreign.size > 0 };
}

/**
 * Read a group's transactions. `rpc(fn)` runs fn(connection) on the read pool.
 *
 * Cost: one signature listing per member, one or more per token account (two accounts: SPL and
 * Token-2022 — the wallet's transactions that touch the mint are exactly those of its token
 * account, so the wallet's whole history is not paged), then one read per transaction, each
 * transaction once. `session` (a plain object the caller keeps between cycles) holds what has
 * been read, so a group larger than `maxReads` continues next cycle instead of starting over;
 * a group needing more than `maxTxTotal` reads gets no verdict.
 *
 * @returns {{ partial:true, read:number, total:number } | object} flows for evaluateGroupAudit
 */
export async function fetchGroupFlows({ rpc, PublicKey, wallet, group, tailSec = GROUP_TAIL_SEC, maxReads = 250, maxTxTotal = 2500, maxTokenPages = 5, session = {}, knownAddresses = [], sleepMs = 120 }) {
  const key = `${group.id}|${memberKey(group.members).join(",")}`;
  if (session.key !== key) {
    // A new member set: the listings are read again, but transactions already read stay (a
    // group that was regrouped after its first read shares most of them with its successor).
    const keep = session.txs instanceof Map && session.txs.size < 5000 ? session.txs : new Map();
    for (const k of Object.keys(session)) delete session[k];
    session.key = key; session.txs = keep; session.reads = 0;
  }
  const count = async (fn) => { session.reads++; return rpc(fn); };
  const sleep = (t) => new Promise((r) => setTimeout(r, t));
  if (!session.sigs) {
    const memberSigs = new Map();
    let t0 = Infinity, t1 = -Infinity;
    for (const r of group.members) {
      const sigs = (await count((c) => c.getSignaturesForAddress(new PublicKey(r.position), { limit: 1000 }))).reverse();
      memberSigs.set(r.position, sigs);
      for (const s of sigs) if (!s.err && s.blockTime) { t0 = Math.min(t0, s.blockTime); t1 = Math.max(t1, s.blockTime); }
    }
    if (!Number.isFinite(t0)) return null;
    const inPos = new Set([...memberSigs.values()].flat().map((s) => s.signature));
    const tokenSigs = [];
    let complete = true;
    for (const acct of walletTokenAccounts(PublicKey, wallet, group.mint)) {
      let before, reached = false;
      for (let page = 0; page < maxTokenPages; page++) {
        const batch = await count((c) => c.getSignaturesForAddress(new PublicKey(acct), { limit: 1000, before }));
        if (!batch.length) { reached = true; break; }
        for (const s of batch) if (!s.err && s.blockTime >= t0 && s.blockTime <= t1 + tailSec && !inPos.has(s.signature)) tokenSigs.push(s);
        before = batch[batch.length - 1].signature;
        if (batch[batch.length - 1].blockTime < t0 || batch.length < 1000) { reached = true; break; }
      }
      if (!reached) complete = false;
    }
    session.sigs = { memberSigs, tokenSigs: [...new Map(tokenSigs.map((s) => [s.signature, s])).values()], complete, t0, t1 };
  }
  const { memberSigs, tokenSigs, complete, t0, t1 } = session.sigs;
  const wanted = new Map();
  for (const sigs of memberSigs.values()) for (const s of sigs) if (!s.err) wanted.set(s.signature, s);
  for (const s of tokenSigs) wanted.set(s.signature, s);
  if (wanted.size > maxTxTotal) return { too_large: true, tx_needed: wanted.size, tx_limit: maxTxTotal, rpc_reads: session.reads };
  let budget = maxReads;
  for (const s of wanted.values()) {
    if (session.txs.has(s.signature)) continue;
    if (budget <= 0) return { partial: true, read: [...wanted.keys()].filter((k) => session.txs.has(k)).length, total: wanted.size, rpc_reads: session.reads };
    budget--;
    let tx;
    for (let attempt = 0; attempt < 3 && !tx; attempt++) {
      try { tx = await count((c) => c.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 })); }
      catch (e) { if (/version/i.test(String(e?.message))) break; }
      if (!tx) await sleep(400 * (attempt + 1));
    }
    session.txs.set(s.signature, tx ? trimTx(tx, s, wallet) : null);
    if (sleepMs) await sleep(sleepMs);
  }
  const memberTxs = new Map();
  for (const [position, sigs] of memberSigs) {
    // an unreadable position transaction is counted as such; an unreadable token-account one is dropped
    memberTxs.set(position, sigs.filter((s) => !s.err).map((s) => session.txs.get(s.signature) ?? { signature: s.signature, slot: s.slot, blockTime: s.blockTime, meta: { err: "unreadable" } }));
  }
  const tokenTxs = tokenSigs.map((s) => session.txs.get(s.signature)).filter(Boolean);
  const flows = summarizeGroupFlows({ members: group.members, memberTxs, tokenTxs, wallet, baseMint: group.mint, knownAddresses });
  return { ...flows, history_complete: complete, group_t0: t0, group_t1: t1, rpc_reads: session.reads };
}

/** Telegram line for a group settled in enforce mode. */
export function groupSummaryText(pair, verdict, appliedCount) {
  const s = (v) => `◎${v >= 0 ? "+" : "−"}${Math.abs(Number(v) || 0).toFixed(6)}`;
  return `🧾 <b>Group audit</b> ${pair}: ${verdict.members.length} positions (${appliedCount} settled by the group), wallet ${s(verdict.wallet_sol)} vs ledger ${s(verdict.ledger_sol)}. Residual ${s(verdict.residual_sol)} spread pro rata by capital.`;
}

export function groupMismatchText(pair, verdict) {
  const s = (v) => `◎${v >= 0 ? "+" : "−"}${Math.abs(Number(v) || 0).toFixed(6)}`;
  return `🧾 <b>Group audit mismatch</b>\n${pair}: ${verdict.members.length} overlapping positions net ${s(verdict.wallet_sol)} on chain but the ledger says ${s(verdict.ledger_sol)} (residual ${s(verdict.residual_sol)}, bound ◎${Number(verdict.bound_sol).toFixed(6)}).\nToo large to apply automatically — the records are unchanged and worth a look.`;
}

/**
 * One management cycle of group audits. Everything it touches is injected, so it runs the same
 * against the live stores and against a test's arrays:
 *   getRecords()    closed perf records (live objects: the store functions mutate them)
 *   getPositions()  tracked positions, open and closed
 *   store           { recordGroup(verdict, { mode }), notePending(group, open, versions),
 *                     noteWindows({ position: { t0, t1 } }), clearGroup(position) }
 *   chain()         → { rpc, PublicKey, wallet } | null — asked for only when a group is read
 *
 * Per cycle: groups with a stored wallet total are re-allocated without a chain read (at most
 * `maxRewrites` writes — it is also what applies shadow verdicts after a switch to enforce), and
 * ONE group is read from the chain, at most `maxReads` transactions; a larger group continues
 * next cycle from `session`. A group that waits is decided from the records and the position
 * registry alone. Returns what happened, for the caller's log and the tests.
 */
export async function runGroupAuditCycle({
  mode = "shadow", since = null, now = Date.now(), horizonDays = 45, maxReads = 250, maxRewrites = 3, session = {},
  getRecords, getPositions = () => [], store, chain, log = () => {}, send = () => {}, escape = (x) => x, sleepMs = 120,
}) {
  const out = { groups: 0, pending: 0, rewritten: 0, read: null, applied: 0 };
  if (!GROUP_MODES.includes(mode) || mode === "off") return out;
  const sinceMs = since ? new Date(since).getTime() : now - 24 * 3600_000;
  const horizon = Math.min(Number.isFinite(sinceMs) ? sinceMs : now, now) - horizonDays * 86400_000;
  // Grouping looks further back than `since`: a group whose last close is recent can chain back
  // through positions closed days earlier.
  const inHorizon = () => (getRecords() || []).filter((r) => (ms(r.recorded_at) ?? 0) >= horizon);
  const groups = buildCloseGroups(inHorizon()).filter((g) => g.last_close_ms >= (Number.isFinite(sinceMs) ? sinceMs : now - 24 * 3600_000));
  out.groups = groups.length;
  if (!groups.length) return out;
  const positions = getPositions() || [];
  const open = positions.filter((p) => p && !p.closed);
  const pairOf = (g) => g.members[0]?.pool_name || g.mint.slice(0, 8);
  const sol = (v) => `◎${Number(v) >= 0 ? "+" : ""}${Number(v).toFixed(6)}`;
  const ledgerNow = (r) => (num(r.pnl_sol_net) != null ? Number(r.pnl_sol_net) : (num(r.pnl_sol) ?? 0) - (num(r.total_gas_sol) ?? 0));
  const put = (g, verdict) => {
    // What the ledger holds for these records now. It differs from the verdict's ledger_sol
    // (applied wallet figures + MODELLED figures) when a member still carries an older wallet
    // figure its re-audit no longer stands behind; the wallet total minus this is the effect.
    const booked = g.members.reduce((s, r) => s + ledgerNow(r), 0);
    const res = store.recordGroup(verdict, { mode });
    if (!res || !res.changed) return res;
    const tag = `${pairOf(g)} ${g.id} (${g.members.length} positions, ${g.members.length - verdict.settled_individually.length} unsettled)`;
    if (verdict.status === "group_ok") {
      const shares = Object.entries(verdict.shares || {}).map(([p, v]) => `${p.slice(0, 8)} ${sol(v)}`).join(", ");
      log(`[CLOSE_AUDIT_GROUP] ${mode === "enforce" ? "applied" : "would-apply"} ${tag}: wallet ${sol(verdict.wallet_sol)} vs ledger ${sol(verdict.ledger_sol)}, residual ${sol(verdict.residual_sol)} (bound ◎${verdict.bound_sol}) → ${shares || "nothing to spread"}; ledger effect ${sol(mode === "enforce" ? res.ledger_delta_sol : verdict.wallet_sol - booked)}${res.kept_applied ? ` — ${res.kept_applied} earlier allocation(s) left as they are (shadow)` : ""}${verdict.rpc_reads != null ? `; ${verdict.rpc_reads} RPC reads` : ""}`);
      // one Telegram line per group settled in enforce; shadow stays silent
      if (mode === "enforce" && res.applied > 0) send(groupSummaryText(escape(pairOf(g)), verdict, res.applied));
      out.applied += res.applied;
    } else if (verdict.status === "group_mismatch") {
      log(`[CLOSE_AUDIT_GROUP] MISMATCH ${tag}: wallet ${sol(verdict.wallet_sol)} vs ledger ${sol(verdict.ledger_sol)}, residual ${sol(verdict.residual_sol)} beyond the bound ◎${verdict.bound_sol} — nothing applied`);
      if (mode === "enforce") send(groupMismatchText(escape(pairOf(g)), verdict));
    } else {
      log(`[CLOSE_AUDIT_GROUP] incomplete ${tag}: ${verdict.why}${verdict.retry ? ` (attempt ${verdict.attempts ?? 1}/3)` : ""}`);
    }
    return res;
  };
  for (const g of groups) {
    const c = classifyGroup(g, { openPositions: open, now });
    if (c.state === "single") {
      // a record that used to be in a group (its window was corrected): the allocation goes
      const r = g.members[0];
      if (r.chain_audit?.group && (mode === "enforce" || r.pnl_sol_net_source !== "wallet_group") && store.clearGroup(r.position)) {
        log(`[CLOSE_AUDIT_GROUP] ${pairOf(g)} ${r.position.slice(0, 8)} is no longer part of a group — stamp cleared`);
      }
    } else if (c.state === "pending") {
      out.pending++;
      if (store.notePending(g, c.open, { version: CLOSE_AUDIT_GROUP_VERSION, auditVersion: CLOSE_AUDIT_VERSION })) {
        log(`[CLOSE_AUDIT_GROUP] pending ${pairOf(g)} ${g.id}: ${g.members.length} closed positions wait for ${c.open.length} open position(s) in the token (${c.open.map((p) => p.slice(0, 8)).join(", ")})`);
      }
    } else if (c.state === "cached") {
      if (out.rewritten >= maxRewrites) continue;
      const res = put(g, evaluateGroupAudit(g, { stored: c.stamp }));
      if (res?.changed) out.rewritten++;
    } else if (c.state === "audit" && !out.read) {
      out.read = { id: g.id, members: g.members.length };
      const attempts = c.attempts ?? 1;
      try {
        const ctx = await chain();
        if (!ctx) { out.read.status = "no_wallet"; continue; }
        const known = [...inHorizon(), ...positions].filter((r) => r?.base_mint === g.mint && r.position).map((r) => r.position);
        const flows = await fetchGroupFlows({ ...ctx, group: g, maxReads, session, knownAddresses: known, sleepMs });
        if (flows?.partial) {
          out.read.status = "partial";
          log(`[CLOSE_AUDIT_GROUP] reading ${pairOf(g)} ${g.id}: ${flows.read}/${flows.total} transactions — continues next cycle`);
          continue;
        }
        // Exact windows replace the estimates the grouping started from. When they change who
        // belongs together, this read is not a verdict: the corrected group is taken next cycle.
        if (flows?.windows) {
          store.noteWindows(flows.windows);
          const mine = buildCloseGroups(inHorizon().filter((r) => r.base_mint === g.mint)).find((x) => x.members.some((r) => r.position === g.members[0].position));
          if (!mine || memberKey(mine.members).join(",") !== memberKey(g.members).join(",")) {
            out.read.status = "regrouped";
            log(`[CLOSE_AUDIT_GROUP] ${pairOf(g)} ${g.id}: exact windows regroup ${g.members.length} → ${mine ? mine.members.length : 0} positions — redone next cycle`);
            continue;
          }
        }
        // A tracked position outside the group moved the token inside its window: its window
        // estimate was too narrow. Its own history gives the exact one (one listing each).
        for (const addr of flows?.foreign_positions || []) {
          try {
            const sigs = (await ctx.rpc((conn) => conn.getSignaturesForAddress(new ctx.PublicKey(addr), { limit: 1000 }))).filter((x) => !x.err && x.blockTime);
            if (sigs.length) store.noteWindows({ [addr]: { t0: Math.min(...sigs.map((x) => x.blockTime)), t1: Math.max(...sigs.map((x) => x.blockTime)) } });
          } catch { /* next attempt */ }
        }
        const verdict = evaluateGroupAudit(g, flows);
        out.read.status = verdict.status;
        out.read.rpc_reads = flows?.rpc_reads ?? null;
        // only an incomplete verdict counts attempts (it is what the retry policy reads)
        put(g, verdict.status === "group_incomplete" ? { ...verdict, attempts } : verdict);
      } catch (e) {
        // an RPC failure is an incomplete verdict that is retried (30 min apart, 3 times)
        out.read.status = "error";
        log(`[CLOSE_AUDIT_GROUP] ${pairOf(g)} ${g.id}: ${e.message} (attempt ${attempts}/3)`, true);
        store.recordGroup({ ...evaluateGroupAudit(g, null), why: `read failed: ${String(e.message).slice(0, 120)}`, retry: true, attempts }, { mode });
      }
    }
  }
  return out;
}
