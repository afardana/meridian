// Token accounts this process has just closed (2026-10-18). The dust sweep closes a swept mint's
// account, then its janitor pass lists the wallet's empty accounts: the listing (or the balance
// read behind a per-mint close) can still show the account for a moment after the close landed,
// so the same account was closed twice in one pass - the second transaction fails on chain
// (IncorrectProgramId: the account no longer exists), costing a fee and a WALLET_ERROR line.
// Every close path (closeEmptyTokenAccount, burnAndCloseTokenAccount, sweepEmptyTokenAccounts)
// notes its accounts here, and every listing / close checks it first. In memory, short TTL: an
// account re-created for the same mint later is eligible again.

export const RECENT_CLOSE_TTL_MS = 60_000;

export function createClosedAccountLedger({ ttlMs = RECENT_CLOSE_TTL_MS, now = Date.now } = {}) {
  const closed = new Map();
  const prune = () => {
    const t = now();
    for (const [addr, at] of closed) if (t - at > ttlMs) closed.delete(addr);
  };
  return {
    note(address) {
      if (!address) return;
      prune();
      closed.set(String(address), now());
    },
    has(address) {
      if (!address) return false;
      prune();
      return closed.has(String(address));
    },
    size() {
      prune();
      return closed.size;
    },
    clear() {
      closed.clear();
    },
  };
}

export const closedAccounts = createClosedAccountLedger();
