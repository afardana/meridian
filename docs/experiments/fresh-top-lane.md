---
id: fresh-top-lane
config_key: freshLaneMode / freshLanePollSec / freshLaneTrackHours
status: registered — capture starting
mode: shadow (paper capture only; no transaction, no LLM, no live rule touched)
registered_at: 2026-11-27
enforce_built: false
---

# Fresh top-performer lane (paper entries on Meteora's 2h Top Performers list)

## Claim
A separate lane that enters, at minimum size, pools that are in the top 5 of Meteora's
"Top Performers · DLMM · 2h" list while their token is under 24 h old — the class the operator
entered with WINSTON-SOL on 2026-11-26 — with a two-sided ±34-bin spot position and the primary
exit set below, ends with more SOL than it puts in, without a fat left tail.

## What was known at registration (2026-11-27)
`docs/plans/16-fresh-top-performer-lane.md` §2 (exploratory, cuts chosen after looking, so not
evidence for this claim): since 2026-09-26 the operator's entries into pools < 6 h old with TVL
< $50K netted −◎3.42 over 38 (15 at ≤ −10 %), < 24 h and < $100K −◎4.57 over 80 (21 disasters,
which reached −10 % a median 16 min after entry); the bot has only 4 entries like WINSTON. No
entry feature separated winners from disasters inside the class. The bot has never recorded
this class properly — this registration exists so it is recorded against a rule written first.
Operator decision 2026-11-27: "go ahead with phase 1, counting every positions, as well as the
lane definition and exit as written. Skip the probes" (no live calibration probes; Phase 0 = no
change, every position keeps counting toward the cap).

## Lane definition (fixed; changing any item restarts the count)
A pool qualifies at a lane poll when ALL of:
- it is on the list the Meteora UI requests for Top Performers · DLMM · 2h, fetched with the UI's
  own floors and no token-age floor, at rank ≤ 5 (its 1-based place in the answer; the rank
  counts every pool on the list, non-SOL-quoted ones included). The exact request (verified
  read-only 2026-11-27; the UI's `&&` joins must be sent URL-encoded inside ONE `filter_by`
  value — sent raw the API answers 400):
  `https://pool-discovery-api.datapi.meteora.ag/pools?page_size=50&timeframe=2h&category=top&filter_by=pool_type%3Ddlmm%26%26dlmm_collect_fee_mode%3Dboth%26%26base_token_market_cap%3E%3D70000%26%26base_token_holders%3E%3D15%26%26volume%3E%3D1000%26%26fee%3E%3D5%26%26active_tvl%3E%3D10000`
  (decoded `filter_by`: `pool_type=dlmm&&dlmm_collect_fee_mode=both&&base_token_market_cap>=70000&&base_token_holders>=15&&volume>=1000&&fee>=5&&active_tvl>=10000`);
- DLMM pool, token Y is wrapped SOL and token X is not;
- token age (now − `token_x.created_at`) ≤ 24 h;
- `active_tvl` ≥ $10,000; `token_x.market_cap` ≥ $100,000; `base_token_holders` ≥ 500;
- mint authority and freeze authority disabled — decided by the on-chain mint account
  (jsonParsed, `mintAuthority` and `freezeAuthority` null); the API's flags are only a pre-filter;
- no transfer fee and no transfer hook: a Token-2022 mint must have no `transferFeeConfig` with a
  non-zero bps (older or newer) and no `transferHook` with a program id; an SPL Token mint has no
  extensions;
- token fees ≥ 30 SOL (`global_fees_sol` from Jupiter's asset search via `getTokenInfo`, the same
  figure the main screening gate reads; GMGN-refined when the bot is configured for it);
- the base mint is not on the token blacklist and the dev (when the row names one) is not on the
  dev blocklist.
A failed or unavailable safety read never qualifies a pool (it is read again on a later poll).
Recorded, NOT gated: Jupiter's bot-holder share, bundler holding, top-10 share (row and audit),
dev migrations / mints / balance, base fee tier (`fee_pct`), dynamic fee, list rank, organic
score, Meteora's own `is_blacklisted`, pool and token creation times, the whole API row, and the
other risky Token-2022 extensions when the mint has them (permanent delegate, default account
state frozen, pausable, confidential transfer).

## Paper entries
- **One paper entry per pool per qualification episode:** a paper entry opens at the first poll
  at which the pool satisfies the definition AND no earlier paper entry of the same pool was
  entered within (its tracking hours + 6 h) before that poll — i.e. none is open (inside its
  tracking window, `freshLaneTrackHours`, 6 h at registration) and the last one's window ended
  at least 6 h ago. Rebuilt from the table at a restart (entries of the last 30 h); until that
  restore has succeeded (retried every 10 min — e.g. while migration 008 is not applied) nothing
  is captured, so an entry open in the table is never duplicated. An entry whose row could not be
  stored is forgotten (no tick is written for a trade that was never persisted).
- **Tracking:** every poll (45 s), one batched request for every open entry at the 5-minute
  timeframe; one tick per entry (active bin from `pool_price`, TVL, active TVL, the raw 5m `fee`
  and `volume` with the 5-minute bucket they belong to — see "Pool fees" — volume, market cap,
  holders, list rank or null, SOL price); once per bucket a second batch at timeframe=1h stores
  `fee_1h_usd`. A poll at which the pool is missing from the answer is stored as an unseen tick.
  An entry ENDS when its 6 h window is over (`ended_reason: "window"`) or when the pool has been
  missing from 20 consecutive answers, ≈ 15 min (`"vanished"`).
- **Read-only quotes** (Jupiter `/order`, `skip_taker`, never executed): a buy of ◎0.5 → base,
  tried on the entry poll and the next 2 polls on which a quote may run (never later than 5 min
  after the entry); without a buy quote the entry is still recorded (`entry_quote: "missing"`)
  and the entry sell quote is taken anyway for ◎0.5 worth of base at the active-bin price. Then a
  sell of that base amount every 15 min while the entry is open; ≤ 4 quote calls per minute
  overall; a 429 is skipped and quotes pause 60 s. Quotes (not the discovery reads) are skipped
  while anything the bot's own restart-safety check treats as in flight is running (management
  or screening cycle, PnL-poller tick, dashboard close, a pending straddle flow, a deferred exit
  swap, a skim being sent).
- **Operator entries** (`lane: "operator"`, not counted by the pass rule): an operator position the
  bot adopts whose pool passes the row checks other than the rank at adoption (the adoption
  enricher's own row; no network call on the adoption path) is recorded and tracked the same way,
  with its rank on the latest 2h list (≤ 10 min old) and `qualifies_full` (the whole definition,
  rank and safety reads included), so real and paper entries in the class can be compared. The
  note is kept in `fresh-lane-pending.json` (data dir) until the next poll processes it, so a
  restart in between does not lose it (notes older than 6 h are dropped).

## Simulated positions (scripts/experiments/fresh_lane_sim.js)
Unit capital ◎1; passive bin model of `scripts/replay/bidask_flip_replay.js` (a bin's value is
its SOL once the price is above it, its tokens at the current price once below).
- **Shape P (primary):** two-sided spot ±34 bins around the entry active bin (69 bins, the
  operator's shape): ◎0.5 in SOL over the 34 bins below and half of the active bin, the base side
  bought with ◎0.5 over the 34 bins above and the other half. Entry cost = ◎0.5 − the buy quote's
  tokens × the active-bin price at the quote. **No buy quote (registered assumption): entry cost
  = (the pool's base fee % + 1.0 pp) of the ◎0.5 bought** (base fee unknown → 3 %); such entries
  are INCLUDED in every result and reported in their own column.
- **Shape S (secondary, reported, not graded):** SOL-only spot ladder over the active bin and the
  68 bins below it (69 bins — the bot's single-account ladder ends at the active bin), ◎1/69 per
  bin, no entry cost.
- **Pool fees.** At timeframe=5m the API's `fee` / `volume` are NOT a rolling last-5-minutes figure:
  they are the fees / volume so far in the CURRENT clock-aligned 5-minute bucket — they only rise
  inside a bucket and restart near 0 when the next one starts. Verified live 2026-11-27 (every
  15–30 s on 8 pools, server Date header): WINSTON-SOL 24.62 → 29.05 → 48.09 → 49.12 → 77.81
  (16:17:43 → 16:20:15 UTC), then 13.16 at 16:20:45; at 16:25:12 still the old bucket, at 16:25:27
  the new one — the answer rolls over 12–27 s AFTER the clock boundary. Each tick therefore stores
  the raw reading and the bucket it belongs to, taken from the response's Date header minus 30 s
  (`fee_bucket_start`, `fee_time_source: "server"`; the local clock only when the header is
  missing). The pool's fee over tick interval (k−1, k] is rebuilt as: the rise of the reading
  inside one bucket; the whole reading when a new bucket starts (the reading fell, or the bucket
  moved by ≥ 2); for every bucket the ticks skipped entirely, the latest stored 1h fee ÷ 12 at
  or before the gap (the entry is flagged `fee_gap`; no 1h figure → nothing is added). The first
  reading of an entry is its baseline (fees before the entry are not counted).
- **Fee income estimate** per interval = that pool fee × share ÷ SOL price, share = our liquidity
  in the active bin of tick k−1 ÷ (that + the pool's active-bin liquidity), the pool's active-bin
  liquidity ≈ `active_tvl` ÷ SOL price ÷ 69 (the pool's active TVL taken as spread over 69 bins
  like ours). Halved-fee stress = the same with fee income × 0.5 (the whole path recomputed).
- **PnL path** = position value + fees − ◎1, in % of ◎1 (gross of the exit cost, like the live
  exit rules read).

## Primary exit set (graded) and variants (logged, not graded)
Evaluated on every captured reading in this order, first hit wins: pool TVL (`tvl`) < $10,000 →
exit; PnL ≤ −10 % → hard stop; trailing 3 / 1.5 (armed once the running peak of the PnL path ≥ 3 %,
fires at a reading ≤ peak − 1.5 pp); time box 120 min since entry. The fill is that reading: **a gap
through the stop fills at the first captured reading at or under it** (no interpolation, so a
wick between readings is missed and a fast fall fills at the first reading past −10 %). Data
ending before any exit → exit at the last captured reading (`data_end`, counted and reported).
Exit cost = token value held at the exit × the slippage ratio of the LATEST read-only sell quote
taken at or before the simulated exit time (never a later one; the entry sell quote counts), ratio
= 1 − quoted SOL out ÷ (tokens × the active-bin price at that quote), clamped to [0, 0.5]; no sell
quote at or before the exit → the entry cost ratio (buy quote, or base fee + 1.0 pp). Gas ◎0.0002
per trade. **Net = value at exit + fees − exit cost − gas − ◎1.**
Secondary variants: time box 60 min; stop −15 %.

## Pass rule
Registered 2026-11-27, before any capture code ran (amended the same day after an independent
review, still before any capture: fee buckets, entries without a buy quote, no look-ahead on the
exit cost, ENDED entries only). Paper entries only, shape P, primary exits; graded = every ENDED
paper entry (window complete, or the pool vanished), entries without a buy quote included; an
entry still inside its tracking window is never graded and not counted.
1. ≥ 40 ended paper entries over ≥ 14 days (first to last entry) — else `insufficient`; 60 days
   from the first capture day without 40 ended entries → `drop`.
2. Σ simulated net > 0 SOL, and still > 0 without the two best entries.
3. Disaster rate (simulated net ≤ −10 % of capital) ≤ 10 %.
4. Σ net > 0 in both halves of the entries by entry time (the first ⌊n/2⌋ and the rest).
5. Checks 2–4 still pass with simulated fee income halved.

Any of checks 2–5 failing at the threshold → `drop`: the lane is listed as rejected and not looked
at again without new evidence. `met` → a proposal to the operator (`build_enforce`-style: Phase 3
of the plan, live at minimum size after an explicit yes); never an automatic promotion. The first
capture day is the day the lane poll first runs in prod (written into the Grading log when it
happens); the schedule's time arm (2027-01-26) assumes 2026-11-27 and moves with it.

## Known weaknesses (stated at registration)
- Fee income is an estimate: the pool's active-bin liquidity is inferred from `active_tvl` over an
  assumed 69-bin spread (narrower LP positions make our share smaller → optimistic), and the
  protocol's share of the fee is not deducted (optimistic). Against that, the bucket rebuild
  loses the fees each bucket earns after its last reading — at a 45 s cadence ≈ 22.5 s of 300 s,
  about 7.5 % of the pool's fees (≈ 10 % in the synthetic test) — and a new bucket whose first
  reading already exceeds the old bucket's total is read as a continuation (undercount); a bucket
  skipped entirely is filled from the 1h figure ÷ 12 (flagged), which averages over the hour.
  The bucket assignment assumes the answer rolls over ≤ 30 s after the boundary (12–27 s seen).
- Entries without a buy quote get an assumed entry cost (base fee + 1.0 pp), not a measured one.
- Capture cadence (45 s) misses sub-minute wicks: stop fills are optimistic in a dump between
  readings (handled only by filling at the first reading at or under the stop), and a trailing fire
  is seen up to 45 s late.
- The sell quote is for the base amount bought at entry (or ◎0.5 worth), not for what the simulated
  position holds at the exit (more after a dump, less after a pump); the slippage ratio is carried
  over as is, and quotes are skipped while the bot may be sending a transaction, so the latest
  quote at or before an exit can be older than 15 min.
- The list's rank is Meteora's opaque ordering and can change without notice; the UI's floors in
  the query are copied as of 2026-11-27.
- A pool that disappears from the API ends its path at the last reading (`data_end`), which is
  optimistic for a rug.

## Revert rule
None while it is paper capture (nothing to revert). If Phase 3 ever runs live: 10 lane closes with
Σ net < 0, or 2 disasters in the first 10 → back to shadow (plan §4 Phase 3).

## Grading log

### 2026-11-27 — **registered** (registration)
Registered with the capture code (`fresh-lane.js`, `fresh-lane-paper.js`, migration 008,
`scripts/experiments/fresh_lane_sim.js`); no capture has run. Amended the same day, before any
capture, after an independent review (fee buckets F1, entries without a buy quote F2, no
look-ahead on the exit cost F3, graded = ended entries); frozen from here on. First capture day:
to be written here when the lane poll first runs in prod.
