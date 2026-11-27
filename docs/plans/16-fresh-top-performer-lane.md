# Plan 16 — Fresh top-performer lane (the WINSTON-SOL question)

Date: 2026-11-27. Status: **proposal, nothing built**. Author: session of 2026-11-27 (three
read-only studies: funnel forensics, history of this class of entry, data sources).

Operator's question: "I've caught WINSTON-SOL from the Meteora page and went straight into
deploying. How can this be done automatically by the bot? Please research and plan the refactor."

Short answer: the bot can be made to *see* and *enter* such pools with moderate work, and
detection is not the hard part. The hard part is that our own history says this class of entry
loses money on balance — for the bot's small probes and for the operator's manual entries
alike. The plan is therefore capture first (no trades), grade against a rule written in
advance, and go live at minimum size only if the rule is met.

---

## 1. Why the bot did not take WINSTON-SOL

WINSTON: token created 20:11 WIB on pump.fun (Token-2022), DLMM pool created 20:41 by a third
party (bin step 100, 3 % base fee), #1 on Meteora "Top Performers · DLMM" at every timeframe
from 5 m to 4 h. Operator entered 21:44 (two-sided, ◎2.0). The bot never saw the pool.

| # | Blocker (each one alone stops the deploy) | WINSTON | Rule | Where |
|---|---|---|---|---|
| 1 | Position cap counts operator positions | 4 open (3 the operator's) | 3 (now 6) | `position-cap.js`, `index.js` screening + opportunity poll, executor |
| 2 | Token-age floor in the discovery query | 1.5 h | ≥ 2 h (`minTokenAgeHours`) | `tools/screening.js` envelope filter |
| 3 | Pool TVL floor, scouts off | $14–22K | ≥ $100K (`minTvl`) | `admitByFeeRate`, executor `validateDeployPoolThresholds` |
| 4 | Bot-holder share | 41.6 % (21:50) | ≤ 38 % | `index.js` screening |
| 5 | Entry shape | operator: two-sided ±34 bins | bot: SOL-only ladder below price | executor (`amount_x = 0`, `bins_above = 0`) |
| 6 | Top-performer feed timeframe | #1 at 1 h, #2 at 2 h | bot reads the 24 h list (not in its top 20) | `fetchMeteoraTopPerformers` |

Because of #1 the screener did not run at all from 17:00 until the cap was raised at 21:51.
Because of #2 the earliest possible fetch was 22:11, 27 minutes after the operator's entry.

Not a blocker: speed. From "pool visible and passing" to a landed deploy the bot takes about
1–6 minutes (45 s poll, 15–35 s screening call, ~7 s transaction). Meteora's API showed the pool
within ~25 minutes of creation and its data is at most ~20 s old.

On #5: a SOL-only ladder below the price earns nothing while a token keeps running up and is
closed by the unfilled-ladder cap once price is ~28 % above the range. Copying the operator's
entry means a two-sided deposit, i.e. buying the token. The straddle code already has the
pieces (impact-capped Jupiter buy, two-sided `RebalanceLiquidity`), but the executor forbids it
for new deploys today.

Side note: the list's "+1,858 %" market-cap change compares against a time before the token
existed. The pool's own high-to-low over two hours was about 2×.

## 2. What our history says about this class of entry

Exploratory, on data already seen; cuts chosen after looking. Closes since 2026-09-26, rebalance
legs excluded. "Disaster" = closed at −10 % or worse.

| Class at entry | Owner | n | Net ◎ | Disasters | Median hold |
|---|---|---|---|---|---|
| Pool < 6 h old and TVL < $50K (WINSTON's class) | bot | 4 | +0.09 | 0 | 76 min |
| | operator | 38 | **−3.42** | 15 | 23 min |
| Pool < 24 h and TVL < $100K | bot (38 of 40 were 0.15 SOL scouts) | 40 | −0.61 | 5 | 56 min |
| | operator | 80 | **−4.57** | 21 | 52 min |
| Pool < 6 h, TVL ≥ $100K only | bot | 32 | +0.03 | 1 | 35 min |
| Pool ≥ 24 h and TVL ≥ $50K | operator | 76 | −0.42 | 7 | — |

- The operator's fresh, thin entries carry most of the operator's losses since 09-26, and the
  total stays negative without the two best and two worst positions (−2.98). The last 14 days
  are about break-even (n = 20, +0.30), carried by a few large wins and losses.
- The disasters are fast: all 21 reached −10 % at a median of **16 minutes** after entry, about
  11 minutes after their peak. A 60-minute time box alone would not avoid them.
- Peaks come early (median 32 min for the operator's, 47 min for the bot's).
- Pools the bot rejected only for being under the TVL floor while < 24 h old (228 pools):
  median market cap −24 % four hours after the first rejection, 42 % of them down more than
  30 %; 210 of the 228 have under $1K TVL today.
- No entry feature separates winners from disasters inside the class at a usable sample size
  (TVL, holders, base fee, bin step, organic score, size all show nothing; pool age and fee
  rate are confounded with who opened the position).
- Fresh age alone is not the problem: the bot's entries into pools under 6 hours old with TVL
  ≥ $100K were break-even with one disaster in 32.
- Earlier verdicts point the same way: the $60–100K TVL band was the worst band on record; the
  scout tier (small probes under the floor) made about zero over 41 closes and was switched off
  on 10-04; the 24 h pump gate was dropped because pumped entries were not worse.

What the data cannot show: the bot has only 4 entries like WINSTON; there are 13 two-sided
entries in total; fee timing is not measurable; rejected pools have no PnL, only price paths.

**Reading:** there is no evidence of an edge to automate, and clear evidence of a fat left
tail. That does not prove a carefully defined subset has no edge — the bot has simply never
recorded this class properly. So the first thing to build is the recording.

## 3. Principles

1. The main lane's floors (`minTvl`, `minTokenAgeHours`, bot-holder limit) are not loosened.
2. The lane is separate: own discovery pass, own budget, own size, own exits, own tag on every
   record. It can be switched off without touching anything else.
3. Capture before capital. Phase 1 sends no transaction.
4. The pass rule is registered in `docs/experiments/` before capture starts, and a pass leads
   to a proposal to the operator, never to an automatic switch-on.
5. If it ever trades: minimum size, one position at a time, never on HOLD, hard stop from the
   first reading.

## 4. Phases

### Phase 0 — slot accounting (independent of the lane; small)
Today every operator position takes a bot slot, which silently stops screening. Options:
(a) leave as is and manage `maxPositions` by hand (today's fix: 3 → 6);
(b) `maxPositionsExcludeHold = true` (exists; held positions stop counting);
(c) new: count only bot positions against the cap, operator positions against none or against
their own cap. Free SOL then becomes the only shared limit, which it already is in practice.
Needs the operator's choice. Files: `position-cap.js`, config, tests. ~0.5 day.

### Phase 1 — paper lane (capture only, no transactions)
- **Discovery:** one extra request per opportunity-poll tick (45 s; the API allows ~150
  requests per 10 s window): `category=top&timeframe=2h&filter_by=pool_type=dlmm` with the UI's
  own floors (market cap ≥ $70K, holders ≥ 15, volume ≥ $1K, fee ≥ $5, active TVL ≥ $10K) and
  no token-age floor. Runs even when the position cap is reached (read-only).
- **Lane definition (fixed before capture):** SOL-quoted DLMM pool; rank ≤ 5 on the 2 h list;
  token age ≤ 24 h; active TVL ≥ $10K; market cap ≥ $100K; holders ≥ 500; mint and freeze
  authority disabled; no transfer fee or hook; token fees ≥ 30 SOL; not blacklisted. Bot-holder
  share, bundlers, top-10 share, dev history, base fee tier and list rank are **recorded, not
  gated**, so the grading can look at them.
- **Paper entry:** on first qualification, store an entry snapshot (the whole API row, the
  Jupiter audit, pool and token creation times) and then the pool's path every poll for 6 hours
  (active bin, TVL, active TVL, cumulative fees, market cap).
- **Simulated position:** the bin-level model from `scripts/replay/bidask_flip_replay.js`
  (reproduces recorded close PnL to a median 0.02 pp) for two shapes — the operator's two-sided
  ±34 spot, and the bot's SOL-only ladder below — with fee income estimated from the pool's fee
  flow times the position's share of active liquidity, entry cost from a read-only buy quote
  (`getSwapQuote`, `skip_taker`), exit cost from a read-only sell quote at the simulated exit.
- **Simulated exits (one primary, fixed in advance):** hard stop −10 %, trailing 3 / 1.5, time
  box 120 min, TVL under $10K. Variants (60 min box, −15 % stop) are logged as secondary.
- **Also capture the operator's own entries in this class** with the same snapshot, so the two
  can be compared.
- Storage: its own table (`lane_paper_trades`, `lane_paper_ticks`), not the position registry.
  Log `[FRESH_LANE_SHADOW] would-enter …`. Key `freshLaneMode` off | shadow (no enforce built).
- Files: `tools/screening.js` (new fetch), new `fresh-lane.js` (definition, pure),
  `fresh-lane-paper.js` (capture + simulation), `index.js` poll hook, a migration, tests,
  `docs/experiments/fresh-top-lane.md`, grader definition. ~3–4 days.
- Weak point, stated up front: simulated fee income is an estimate. If the grading hinges on
  it, a handful of real ◎0.05 probes would calibrate it — that is live trading and needs a
  separate yes.

### Phase 2 — grading (pre-registered)
Proposed pass rule, to be registered before capture starts:
- at least 40 paper entries over at least 14 days;
- Σ simulated net > 0, and still > 0 without the two best entries;
- disaster rate (simulated net ≤ −10 %) at most 10 %;
- positive in both halves of the period;
- the result holds with simulated fee income halved.
Fail or 60 days without 40 entries → dropped and listed as rejected. Pass → a proposal with the
numbers; the operator decides.

### Phase 3 — live at minimum size (only after a pass and an explicit yes)
- Executor path for a lane deploy: two-sided entry reusing the straddle's impact-capped buy
  (`straddleBuyPreCheck`) if that is the shape that passed; SOL-quote rule; one lane position;
  size `freshLaneSizeSol` (proposal ◎0.1–0.2) from a separate budget; tagged `lane: "fresh"`.
- Exits: exactly the simulated set; stop active from the first trusted reading (no profit
  grace); TVL exit; the lane position cannot be put on hold by the bot.
- Exit cost awareness for 3 % pools: the exit swap may route through the same pool. The quote
  already includes that, but no gate reads `fee_pct` today — add it to the entry snapshot and
  the cost estimate.
- Revert rule: 10 lane closes with Σ net < 0, or 2 disasters in the first 10 → back to shadow.
- ~3 days plus independent review (money path).

### Phase 4 — earlier detection (only if Phase 2 shows entry time matters)
A DLMM pool-creation subscription in the socket monitor (today it only watches the wallet's own
positions). WINSTON's pool existed 63 minutes before the operator's entry and qualified for
the list within minutes, so this may buy little. ~2 days.

## 5. What this plan deliberately does not do
- Lower `minTvl`, `minTokenAgeHours` or the bot-holder limit for normal screening.
- Mirror the operator's manual entries automatically.
- Give the lane normal position size.
- Re-enable the scout tier (same population, already graded at about zero).

## 6. Decisions needed from the operator
1. Go ahead with Phase 1 (capture only)?
2. Phase 0: which slot rule — keep counting everything, exclude held positions, or count only
   the bot's positions?
3. Lane definition and the primary exit set in Phase 1 — accept as proposed, or change before
   it is registered (it cannot be changed after capture starts without restarting the count).
4. Whether real ◎0.05 calibration probes are acceptable during Phase 1.

## 7. Building blocks already in the repo
Discovery client and `condensePool`; the 45 s opportunity poll; `getTokenAudit` /
`getTokenHolders`; the straddle buy with impact cap; `lane` tagging; the SOL-quote rule; entry
and exit cost quotes; the bin-level replay model; the experiment registry, grader and board.
