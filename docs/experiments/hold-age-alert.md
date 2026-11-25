---
id: hold-age-alert
config_key: null
status: not_met
mode: none (event study only)
registered_at: 2026-11-25
enforce_built: false
---

# Hold-age alert (a held position past a pool-age-scaled age tends to lose from there)

## Claim
A position still on HOLD past T hours after it was opened, with T set by the pool's age at
entry, ends lower than it stood at T more often than not. An alert at T ("this hold is past the
age at which tokens of this age usually halve") would be worth sending.

## What was known at registration (2026-11-25)
The T values come from the token-death study of the same day (≈ 176 entries in 38 pools, hourly
candles): price ≥ 50 % under entry within 6 / 24 / 48 h in 22 / 61 / 78 % of entries into pools
under 24 h old, 0 / 2–5 / 12–21 % for pools 3–30 d old; positions held > 24 h saw the market cap
halve during the hold in 42 % vs ≈ 3 % for shorter ones. Those are PRICE paths of pools the bot
and the operator traded — the same universe as the population below, so T is partly fitted to
it. The held positions' own PnL after T has not been looked at.

## Method (event study; nothing is built)
- **Population:** every position on HOLD at any time since 2026-09-01, closed, with a tick path.
- **T (registered):** pool age at entry < 24 h → **6 h**; 24–72 h → **24 h**; ≥ 72 h or
  unknown → **48 h**. Age of the position counts from `deployed_at` (the account's creation for
  an adopted one). Pool age from the death study's pool-creation data, else GeckoTerminal.
- **Event:** the first trusted reading at or after T while the position is on HOLD. A position
  not held at T, or closed before T, has no event.
- **Outcome:** Δ = final SOL result − SOL result at the event, on the capital in the position at
  the event (capital added later is reported separately). "At the event" is net of 1.5 % of the
  base side held then.

## Pass rule
Registered 2026-11-25, before any held position's path after T was read.
1. ≥ 15 events — else `insufficient`.
2. Final below the event figure in ≥ 60 % of events.
3. Σ (event − final) > 0 SOL, and > 0 without the largest term.
4. The median Δ is negative.
5. Checks 2–3 also hold on the events of pools under 72 h old at entry alone, or that group has
   fewer than 8 events (then reported, not required).

`met` → a Telegram-only alert (one per position, text with the pool-age figures; no exit, HOLD
untouched) is proposed in the session. Not met → no alert; the figures are added here.

## Revert rule
None — an alert changes no position.

## Grading log

### 2026-11-25 — **not_met** (event study, 32 events)
- Population: 105 positions with a HOLD on/after 2026-09-01; 32 events, 73 without: 50 closed
  before T (position age < T), 12 held at T but the percent basis at T unknown, 4 not held at T,
  3 basis does not reconcile with the record, 2 no performance record, 2 still open.
- Result: final below the event figure in 18 of 32 (56 %); Σ (event − final) ◎−0.6505, without
  the largest term (CRAWL-SOL 69F2FsPS −◎2.6616) ◎+2.0111; median Δ −◎0.0551. Without the two
  seen positions: 57 %, Σ −0.7067, without the largest +1.9549.
  1. ≥ 15 events: PASS (32)
  2. final below event in ≥ 60 %: **FAIL** (56 %)
  3. Σ (event − final) > 0 and > 0 without the largest: **FAIL**
  4. median Δ < 0: PASS
  5. pools under 72 h at entry (n 20, below 12 = 60 %, Σ +◎0.5800, without the largest +◎3.2416): PASS
- Deviation: the two seen JIMMY positions (9gH8jqU9, CYCbgJBm) are in the 32 (the spec lists no
  exclusions); an event needs a reading on a known percent basis within 30 min of T.
- Not part of the verdict: the T = 6 h group alone (18 events, 61 %, Σ +◎3.10, +1.82 without the
  largest); era split — before 10-04 final below the event in 72 % of 18, from 10-04 in 36 % of 14.

No alert is built.
