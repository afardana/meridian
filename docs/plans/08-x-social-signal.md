# Plan 08 — X (Twitter) Social Signal

**Status:** DESIGN. Follows the proven signal-integration pattern (organic-momentum is the
template: advisory candidate line → deploy capture → outcome validation → darwin/hard-filter).

---

## 1. What X adds that current intel lacks

The intel engine scores Safety / Yield / Momentum / Trust from on-chain + market data
(intel-score.js), narrative presence comes from Jupiter ChainInsight (`getTokenNarrative`), and
organic-momentum reads the *on-chain* crowd (traders/volume/holder deltas). What none of them
see: the **off-chain attention wave that precedes the on-chain one**. Meme flows start on CT
(crypto Twitter) minutes-to-hours before they hit swap counts. A cashtag/CA mention signal is a
leading indicator for exactly the pool-persistence question organic-momentum answers lagging.

## 2. Metrics (mirroring the organic-momentum shape)

Per candidate token (by ticker cashtag + contract address):
- `mention_velocity` — posts/hour now vs prior window → `mention_change_pct` (the GROWING /
  steady / DECAYING classification, same shape as organic-momentum)
- `unique_authors` — breadth floor (like `organicMomentumMinUniqueTraders`); 400 mentions from
  12 accounts = bot spam, not attention
- `kol_hits` — mentions from a curated CT-KOL list (`x-kols.json`, mirroring the
  smart-wallets.json pattern: address→handle, add/remove tools, hit = strong signal)
- `bot_ratio` (optional) — reply-guy/copy-pasta share; high ratio *downgrades* the signal
  (same philosophy as `maxBotHoldersPct` in holder auditing)
- Sentiment: **skip in v1** — engagement velocity + breadth beat sentiment models for memes,
  and sentiment APIs add cost/latency for dubious alpha.

## 3. Data-source options (the real decision)

| Source | Cost | Notes |
|---|---|---|
| X API v2 (Basic) | $200/mo | 10k reads/mo — too few for per-candidate polling at our cadence; Pro $5k/mo is out of scope |
| LunarCrush API | free–$24/mo tiers | pre-aggregated social volume/engagement per asset; cheapest viable; meme-token coverage is hit-or-miss for brand-new mints |
| twitterapi.io / apify scrapers | ~$0.15–0.4/1k tweets | pay-per-use search; good fit for our bounded enrichment (≤4 candidates/cycle × 2 windows); ToS-gray |
| Grok API (x.ai) live search | usage-priced | LLM-mediated X search; convenient but adds an LLM in a deterministic path — prefer raw counts |

**Recommendation:** start with a pay-per-use search API behind our own thin client with a 30-min
cache (the lpStudy pattern: `lpStudyMaxPools`-style bound, 429-degrades-silently). At
`xStudyMaxPools=4` candidates × 2 calls × 96 cycles/day worst case ≈ cheap; the cache and
post-filter placement cut it far below that in practice.

## 4. Integration blueprint (follows repo conventions exactly)

1. **`x-social.js`** (new, root): `analyzeXSocial(ticker, mint)` → `{ classification:
   GROWING|steady|DECAYING|thin, mention_change_pct, unique_authors, kol_hits }`. In-module
   30-min cache; any API failure → `null` (degrade silently, like lper-signal).
2. **Screening enrichment** (`runScreeningCycle`, index.js): deterministic, post-filter, bounded
   to the few surviving candidates — adds an `x:` line to the candidate block the SCREENER LLM
   sees (next to `momentum:`/`sim:`/`top_lpers:`): `x: GROWING (+180% mentions/h, 46 authors,
   2 KOL)`. ADVISORY first — the LLM weighs it, no hard gate.
3. **Deploy capture:** field on `signal_snapshot` (screening.js) → flows into the perf record
   automatically, like `organic_momentum`.
4. **Outcome validation:** `analyzeXSocialOutcomes()` in lessons.js (clone of
   `analyzeOrganicMomentumOutcomes`) — success-rate by classification over the recency window.
5. **Darwin staging:** register the signal in signal-weights so its influence is earned from
   outcomes, not assumed.
6. **Hard-filter (last):** `xSocialHardFilter` config (default OFF) exactly like
   `organicMomentumHardFilter` — only after validation shows separation with n≥15/side.
7. **Config keys** (screening section): `xSocialEnabled` (OFF until an API key is set),
   `xSocialMaxPools` (4), `xSocialMinUniqueAuthors` (15), `xSocialGrowPct` / `DecayPct`,
   `xSocialHardFilter` (false). Secrets (`X_SEARCH_API_KEY`) in `.env` only.
8. **Intel-score hook (optional, later):** fold a validated X sub-score into the Momentum
   dimension via its configurable weight rather than adding a 5th dimension — keeps the
   weighted-average contract intact.

## 5. Failure containment & costs

- Enrichment is post-filter + cached + capped → bounded spend; a dead API degrades to today's
  behavior (no `x:` line), never blocks screening.
- Bot-spam is the main false-positive: the breadth floor + KOL list + (later) bot_ratio are the
  defenses; validation (§4.4) is the arbiter.
- Rate limits: same 429-silent-degrade discipline as the LPAgent client.

## 6. Rollout

Phase 0: pick source, wire `x-social.js` + `.env` key, log-only (no candidate line) for 2–3 days
to sanity-check coverage on real candidates. Phase 1: advisory `x:` line + snapshot capture.
Phase 2: after ≥30 deploys with capture, run outcome validation; stage into darwin. Phase 3:
consider hard-filter / intel Momentum fold-in only on demonstrated separation.
