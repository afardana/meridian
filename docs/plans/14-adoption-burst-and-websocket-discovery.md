# Plan 14 — Manual-position adoption burst and WebSocket discovery

## Objective

Detect manually deployed DLMM positions promptly, adopt them without bypassing
the existing safety gates, and reduce expensive owner-wide discovery scans while
keeping a reliable fallback.

## Implemented in this change

- Queue newly discovered untracked positions as adoption candidates.
- Check only queued candidate accounts every 5 seconds.
- Preserve the 10-second adoption dwell, final liveness check, closed-state
  recheck, and post-adoption valid-tick arming.
- Expire candidates after a bounded 120-second burst window.
- Add a wallet-filtered PositionV2 `programSubscribe` on the existing PnL
  WebSocket connection. An unknown account change requests an immediate,
  coalesced discovery scan.
- When the filtered subscription is healthy, slow owner-wide discovery to a
  5-minute safety fallback; revert to the normal 30-second cadence when the
  subscription is unavailable.

## Follow-up nice-to-haves, prioritized

### P1 — WebSocket health and recovery

- Detect subscription disconnects/errors explicitly and feed health into the
  fallback scheduler.
- Re-subscribe with bounded backoff and jitter.
- Emit metrics for subscription uptime, reconnects, hints, and missed fallback
  scans.
- Acceptance: a dropped stream returns owner discovery to 30 seconds and a
  recovered stream returns it to the configured fallback interval.

### P1 — Adoption observability and UI

- Persist `discovery_seen_at`, `adoption_started_at`, `adopted_at`, and
  `adoption_latency_ms` in the audit/event trail.
- Surface `Adoption pending` in Telegram/dashboard without treating it as a
  managed position yet.
- Include the discovery slot/signature and valuation quality in diagnostics.
- Acceptance: every candidate has a clear terminal state: adopted, closed,
  expired, or valuation-incomplete.

### P2 — Adaptive candidate cadence

- Use 2-second checks for the first 10 seconds, then 5-second checks until the
  burst expires.
- Keep a per-wallet/per-process concurrency cap so several manual deployments
  cannot create an RPC burst.
- Acceptance: faster median adoption without increasing 429s or starving the
  normal PnL poller.

### P2 — Transaction/account event correlation

- Correlate PositionV2 account changes with the wallet's recent confirmed
  signatures to distinguish manual deploy, bot deploy, close, and account
  churn.
- Use the event as a hint only; final adoption must still use direct liveness
  and state checks.

### P3 — Stronger event source

- Evaluate Helius `transactionSubscribe` or wallet/account subscriptions as a
  complementary signal if filtered `programSubscribe` proves incomplete.
- Keep the PositionV2 program filter as the low-cost baseline and retain the
  periodic owner scan for correctness.

### P3 — AUM and chart refinement

- Add a live `adoption_pending` AUM component to the dashboard before the next
  persisted sample.
- Keep it in the in-memory/live chart segment only; do not persist 5-second
  samples into `balance_history`.
- Add a visible sample-quality marker when a historical point was repaired or
  intentionally skipped.

## Safety constraints

- Never run owner-wide discovery every 5 seconds.
- Never auto-close or auto-claim solely from the WebSocket hint.
- Retain final account liveness, local-state recheck, adoption dwell, and the
  existing post-adoption valid-tick requirement.
- Retain the periodic owner-wide fallback because WebSocket delivery is not the
  sole source of truth.
