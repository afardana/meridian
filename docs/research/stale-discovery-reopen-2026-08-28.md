# Stale discovery snapshot reopened a closed position

Date: 2026-08-28

## Incident

Position `8tFpk9whBdjhtwWujFAVEhZoXecDgLKu8steQs31XRRC` (`BULLSHIT-SOL`) was a
normal bot deployment using the resolved `spot` strategy. Its trailing take-profit
signal was valid and confirmed at 17:05:44 WIB. The close transaction confirmed,
and a direct account read showed the position account was absent. Local state was
marked closed at 17:05:50 WIB.

At 17:07:00 WIB, scheduled reconciliation emitted an orphan-adoption alert and
reopened the same position. The direct account check later confirmed it was still
closed on-chain.

## Root cause

The owner-wide discovery path uses a cached result in `tools/pnl.js`:

1. Incremental `getProgramAccountsV2` scans use `changedSinceSlot`.
2. The incremental address set is built as the union of the previous addresses
   and newly returned addresses, so deletions are not represented until a full
   scan.
3. When no new address was detected, `computePositions()` returned the previous
   `_positionDiscovery.lastResult`, which still contained the position from before
   the close.
4. The fast PnL discovery path had a direct liveness check, but
   `reconcileStateWithChain()` trusted the stale discovery result and adopted the
   closed row without rechecking the account.

The earlier orphan-provenance fix was therefore incomplete: it preserved the
correct strategy when adoption was legitimate, but it did not invalidate the
separate discovery snapshot after a confirmed close or protect the scheduled
reconciliation path.

## Remediation

- Added `invalidatePositionDiscovery()` to remove a confirmed-closed address from
  both the incremental address set and cached discovery result.
- Called discovery invalidation after confirmed relay and local closes.
- Added a direct `isPositionAccountLive()` check before reconciliation changes
  state. A live account is left open; a closed account may be auto-closed or
  ignored as a stale orphan; an unavailable check defers the change.
- Repaired the affected PostgreSQL row after a backup and verified its account was
  absent on-chain.

## Operational lessons

- A confirmed on-chain mutation must invalidate every dependent cache, not only
  the PnL/deposit cache.
- Owner discovery is a candidate snapshot, not authoritative proof of account
  liveness. Reconciliation must perform a fresh direct account read before
  auto-closing or re-adopting a position.
- Provider failure or incomplete discovery must be fail-safe: defer state changes
  rather than turning an incomplete result into a close or adoption.
- After a state-changing fix, inspect PostgreSQL state, the exact position account,
  and the next discovery/reconciliation log cycle; PM2 being online alone is not
  sufficient verification.

## Verification

- Bot fix committed and pushed as `399637c`.
- PostgreSQL backup completed before the live row repair.
- `meridian` restarted on the new code; `meridian-dashboard` and co-tenant
  services were not restarted.
- Post-restart discovery found six positions and did not re-adopt the closed
  address; the persisted row remained closed.
