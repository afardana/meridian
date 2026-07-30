# PROMPT — Design "Charon-RH": a first-class autonomous LP platform for Robinhood Chain

> Paste everything below this line into a fresh session.

---

You are designing a **new autonomous liquidity-provision platform for Uniswap v3 on Robinhood Chain** (an Arbitrum Orbit L2, EVM). This is a green-field design informed by a battle-tested predecessor. Your deliverable is a design document + phased build plan, not code.

## Who this is for

A solo operator (Angga) running **Meridian**, an autonomous Meteora DLMM LP agent on Solana, ~$450 AUM, 280+ closed positions of recorded history. Production runs 24/7 on an Oracle Cloud Always-Free VM (Ubuntu 24.04, **aarch64/ARM**, 4 OCPU / 24 GB), Node.js under PM2, PostgreSQL 16 (co-tenant with other services), Telegram as the ops surface, LLM inference via OpenRouter + Claude Code CLI (subscription OAuth, per-role models). The new platform will co-tenant on the same VM beside Meridian. Solana memecoin LP volume has migrated to Robinhood Chain (community evidence: active LPers now posting Uniswap v3 RH positions, $50–400 position sizes, quick fee-harvest flips on memecoins paired against WETH). Prior art exists — "UniCrit" by the same author as Meridian's upstream — but it is young and buggy; this design should be first-class, not a clone.

## Mission

An agent that autonomously: discovers candidate pools on RH-chain Uniswap v3 → screens them with deterministic filters + LLM judgment → deploys concentrated-liquidity positions → manages them with a layered mechanical exit stack → closes, accounts honestly, and learns from every outcome. Small-capital retail scale (0.05–0.5 ETH positions). Capital preservation outranks yield capture.

## Part 1 — Verify the ground truth first (your knowledge may be stale)

Before designing, research and pin down with current sources:

1. Robinhood Chain specifics: chain ID, public RPC endpoints (and rate limits), gas token and typical L2 gas costs, canonical bridge(s) and bridge latency/cost from Solana or mainnet, block time, explorer, WebSocket availability.
2. Uniswap v3 deployment on RH: factory/NonfungiblePositionManager/router addresses, available fee tiers, whether Universal Router and Permit2 are deployed, subgraph availability (hosted? self-index?).
3. Pool discovery options: does GeckoTerminal / DEX Screener / DefiLlama index RH chain? Is there a trending API? If not, design discovery from on-chain events (PoolCreated, Swap volume aggregation) — state the cost of self-indexing.
4. Swap/quote infrastructure: on-chain QuoterV2 vs any aggregator presence on RH. MEV landscape on an Orbit L2 (sequencer ordering, private lanes if any).
5. EVM tooling for Node.js on ARM: viem vs ethers v6 — pick one and justify.

Do not proceed on assumptions; every Part-1 fact should carry a source.

## Part 2 — Architecture to inherit from Meridian (proven over ~7 weeks of production)

Carry these patterns; adapt names/mechanics to EVM:

1. **Three agent roles with tool whitelists** — SCREENER (find/deploy), MANAGER (manage/close), GENERAL (manual/chat). The LLM only sees the tools its role permits. A ReAct loop over an OpenAI-compatible API; per-role model selection (judgment-heavy screening on a strong model, mechanical management on a cheap one); 502/529 fallback chain; a calm "no tool call" fallback path (models sometimes answer in prose — retry ×3 then treat as no-action, never crash the cycle).
2. **Deterministic money path, LLM at the edges.** Every exit that protects capital (stop-loss, trailing TP, crash detection) is pure JS evaluated on a fast poller — the LLM is never on the critical path of an exit. The LLM decides entries and handles free-text instructions; mechanical rules close positions. This is the single most important property.
3. **Executor safety layer.** Tool dispatch goes through one executor with WRITE_TOOLS gating and hard pre-deploy checks: duplicate pool, duplicate base token, max positions (force-fresh count — TOCTOU races are real), gas reserve, minimum range width, balance coverage. The LLM can *propose*; the executor *disposes*.
4. **Shadow-first flag discipline.** Every new money-path behavior ships behind a config flag, default OFF, logging `[FEATURE_SHADOW] would-fire` lines with zero behavior change. Calibrate against live logs for days, then enable via hot config. Instant rollback = flip the flag. No exceptions — this discipline caught multiple would-have-been-bad features before they cost money.
5. **Hot config + secrets split.** Tunables live in a JSON config mutable at runtime via an `update_config` tool (validated key→section map); secrets live in `.env` ONLY — never in config files (they land in DB backups), never in source. Note Meridian's gotcha: dotenv `override:true` makes `.env` beat shell exports — document whatever loading order you choose.
6. **Layered exit stack** (adapt to Uniswap v3 mechanics): hard stop-loss → trailing TP (trigger/drop) → breakeven profit ratchet (arm at +2%, stop −2%; never arm below 2 — a 1.5 arm whipsawed a +12% winner) → price-crash fast-path (velocity-based, bypasses slow OOR waits) → in-range rug detector (velocity+PnL joint gates — neither alone separates winners from rugs) → out-of-range timers (below = urgent, above = patient) → fee-death close (low yield after age floor) → round-trip harvest (position exited fully through the top of range: PnL frozen + all-quote = free exit, no rule otherwise reaches it). Every exit routes through N-consecutive-tick confirmation. Exits classified **urgent vs calm** end-to-end (urgent = skip redundant pre-close steps, higher priority fees, must-fill swaps; calm = efficiency gates allowed to defer).
7. **Learning loop.** Record every close with full entry/exit context → `classifyOutcome()` where **break-even fee-death = failure, not a win** (a PnL-sign objective once counted 22 fee-deaths among 75 "winners" — this correction was the core of the learning overhaul) → threshold evolution every N closes with significance gates (min n per group AND effect size), recency windows, hard bounds, and **closed-loop self-revert** (each change stores the success-rate at decision time and auto-reverts if it regresses). Plus: a starvation relaxer that steps floors back toward baseline after N empty screening cycles — **make sure it owns the floors that actually bind** (Meridian's relaxer can't touch its TVL floor, so it fires no-ops during droughts; don't repeat that).
8. **Memory subsystems**: per-pool deploy history + snapshot series (per-position buckets — a later position must not evict an earlier one's series); episodic memory (each candidate shows the K most-similar PAST deploys and their real outcomes, distance over log-scaled metrics with missing-dimension renormalization); rejected-candidates capture (snapshot funnel-rejected pools per cycle — this is what makes selection counterfactuals answerable later); a permanent token blacklist; a dev blocklist.
9. **Persistence.** Swappable backend (flat JSON files ↔ Postgres) behind a synchronous facade: in-process cache, ordered async write-through (a promise chain so concurrent writes can't clobber), atomic file writes, mandatory cache priming at boot, flush-on-shutdown. Crash safety: **never boot with empty position state** (halt instead — an empty load makes the agent forget live on-chain positions), and reconcile tracked state against on-chain truth every management cycle to self-heal write-behind loss. Position registry normalized (1 row/position + append-only events + singletons); analytics stores can stay document-shaped. Daily pg_dump outside the repo tree.
10. **Ops surface.** Telegram: mechanical commands (`/positions`, `/close <n>`) bypass the LLM entirely; deploy/close/OOR notifications; daily briefing; HTML-escape every interpolated close reason (Telegram 400s on `<=`). Dashboard: the bot publishes a per-cycle report document; the dashboard *renders* it rather than re-deriving from raw tables (re-derivation caused unit-drift bugs). Funnel telemetry every screening cycle: per-stage attrition counts logged and included in no-candidate reports.
11. **LLM cost controls**: per-pool NO-DEPLOY verdict cache (TTL + invalidation on mcap ±20% / holders ±30% drift); identical-candidate-set fingerprint suppressor; deploy-confidence capture (parse `CONFIDENCE: NN` + thesis from the deploy narration and attach to the position record for later calibration analysis).

## Part 3 — Hard-won lessons the design must encode (each cost real money or a false conclusion)

**Evidence discipline:**
- **Era-split every backtest.** Regime leakage faked four separate results in Meridian's history — a filter that looks great "overall" is usually riding the good half. The honest bar (validated independently by a sibling project's 1,146-trade backtest): a filter must improve BOTH halves of a time split. Their regime decayed 40.3%→25.7% win rate with no filter change; expect the same on RH.
- **Liquidity floor is the only entry gate that survived honest splits** — in BOTH datasets independently (Meridian: entry-TVL ≥$100k = zero disasters in every era, a step function not a gradient; sibling: liquidity ≥$13k monotonic and stable). Market-cap floors failed in both. Volume floors were *inverted* in theirs (the gate selected losers). Design the liquidity floor as a first-class, evolution-owned, starvation-relaxable parameter.
- **The trigger is not the fill.** Signal-to-realized gap measured ±1pt on 45s polling — 2× the difference between candidate trailing-drop values. Never compare exit configs by trigger levels; compare realized fills, or don't compare.
- n<30 cohorts prove nothing; n=1 anecdotes enabled a bad gate once (a re-entry cooldown shipped off one anecdote, reverted 2 days later when the 133-re-deploy audit showed the penalty was a June-only artifact). Run the outcome join BEFORE enabling a deploy-blocking gate.

**Execution mechanics:**
- **Sampling granularity bounds every stop.** A −2% stop on 45s ticks filled at −27% during a rug (PnL went +0.25 → −1.84 → −11.02 across three ticks, then slippage took the rest). Design the poller cadence around the stop you want, and never let "confirmation ticks" × "poll interval" exceed what the slow path already provides. Meridian's crash "fast path" (3 confirm ticks × 45s = 135s) was slower than its normal path (2 × 45s) — audit these products.
- **Exit-latency layers compound**: pre-close claim + confirm ticks + wick-guard deferrals + a deferred tick not counting toward confirmation = minutes of delay stacking exactly when speed matters. Budget total worst-case exit latency as a designed number.
- **Always send explicit slippage caps** (a sibling audit found the configured cap silently never sent — Jupiter chose; the same gap existed in Meridian). Tier by urgency: retryable remainders get tight caps + a retry/sweeper path; urgent-exit inventory must fill (uncapped/wide) because a failed capped swap strands a collapsing token.
- **Exit-swap price impact** is where "wins" die on thin pools (10–16% realized). Quote before selling; defer small remainders when impact exceeds a cap and re-quote later via a dust sweeper; always sell large urgent inventory immediately. Track deferred-swap mints explicitly so a later position on the same token doesn't strand them.
- Range mechanics on a single-sided quote ladder: price exiting through the TOP freezes PnL with the position 100% quote (free exit — harvest it); price collapsing INSIDE a wide range is invisible to OOR logic (needs a velocity+PnL rug detector); wick oscillation across a boundary resets naive OOR timers forever (require N bins beyond the edge, not just "out").
- **Unit discipline from day one.** Meridian's `*_usd` fields silently carry SOL under one mode — a permanent landmine requiring dual-written `*_true_usd` fields later. On RH design every money field as `{eth, usd}` pairs from the first line of code. All exit rules judge ONE canonical denomination (decide which and document it).
- Races: two screening triggers deploying twice (guard with a cycle mutex + force-fresh position counts); external CLI writes clobbered by the agent's cache flush (single-writer rule: one live process owns state writes).

**LLM-specific:**
- An adversarial "bear debate" gate vetoed 78/78 deploys including both of the day's winners — an adversarial reviewer with no discrimination is pure noise. If you add adversarial checks, measure their discrimination against outcomes before letting them block anything.
- **Fail-open provenance**: when an LLM call errors and you default to "proceed", persist that it was `fail_open`, not `parsed` — Meridian had 17 "proceed" verdicts that were all error defaults, indistinguishable from real approvals until provenance was added.
- LLM instructions execute literally ("release the hold" was interpreted as "close now"). Ops instructions to the agent need the same care as code.

## Part 4 — What is genuinely NEW design work (DLMM → Uniswap v3 on an L2)

Think hardest here; Meridian has no answers for these:

1. **Tick math replaces bin math.** Range width, "bins below," in-range factor, and the volatility→width formula all need re-derivation in tick space per fee tier. Decide whether single-sided quote-ladder entry (range placed entirely below spot, 100% WETH) remains the house style — argue it from first principles for v3.
2. **NFT position lifecycle**: mint/increase/decrease/collect/burn via NonfungiblePositionManager; fee collection is a separate call (compounding economics differ); no `shouldClaimAndClose` composite — design the minimal-transaction close.
3. **Discovery without a Meteora-style API.** This is likely the hardest subsystem: trending-pool discovery on a chain that indexers may cover poorly. Design a concrete pipeline (subgraph queries, on-chain event aggregation, third-party APIs — whatever Part 1 found) with per-stage funnel telemetry from day one, plus the rejected-candidates capture.
4. **EVM execution**: nonce management, gas estimation with urgency tiers (exit > deploy), allowance/Permit2 strategy, revert decoding, and the L2's sequencer/MEV reality. Replace Solana's priority-fee escalation with the EVM equivalent.
5. **Token safety on EVM**: honeypot detection, fee-on-transfer/rebasing tokens (they break LP accounting), proxy/upgradeable contracts, renounce/mint checks — the rug-vector list is different from Solana's. Design the safety scorer around EVM realities.
6. **Price/PnL polling**: no Helius; design the poller off RPC (slot0/observe + position amounts) with the cadence Part 3's granularity lesson demands, plus a tick-history capture (Meridian's `price_ticks` with dedup-on-unchanged is the model — that data later answered every exit-rule counterfactual).
7. **Capital & bridge ops**: WETH/ETH handling, gas reserve policy, and an explicit accounting bridge so the operator's cross-chain AUM (Solana + RH) can be reported coherently.

## Part 5 — Constraints

- Node.js (operator fluency + reuse of Meridian's ops patterns), ARM-native deps only, co-tenant on the existing VM under PM2 with its own Postgres database (least-privilege role, own DB, never touch co-tenants').
- Telegram as the ops surface from day one; dashboard later.
- **Dry-run mode is Phase 1** and must price paper exits off executable quotes, not marks (paper numbers on marks overstate by the full slippage).
- Secrets in `.env` only. A dedicated fresh wallet. The operator enters keys — never the agent.
- Budget realism: free/cheap RPC tiers, LLM spend minimized via per-role models + verdict caching.
- Reuse Meridian's *brain* concepts freely, but this is a separate codebase and process — no shared state, no shared wallet.

## Part 6 — Deliverables

Produce, in order:
1. **Ground-truth appendix** — Part 1 findings with sources.
2. **Architecture document** — module map mirroring the inherit-list where applicable, with explicit deltas for Part 4; data model (positions, events, ticks, pool memory, lessons, rejected candidates); the exit-stack spec with a worst-case exit-latency budget table.
3. **Risk register** — top 10 ways this loses money, each mapped to a mitigation in the design.
4. **Phased build plan** — Phase 0 (ground truth + skeleton + dry-run), Phase 1 (paper trading, full telemetry), Phase 2 (small live capital, shadow-mode exits calibrating), Phase 3 (learning loop + evolution). Each phase with entry/exit criteria and a kill criterion ("abandon if X").
5. **Open questions for the operator** — anything requiring their decision (capital to bridge, position size policy, risk tolerances) — as a short list, not blockers to the design.

Design honestly: where the RH-chain data in Part 1 turns out too thin to support a subsystem (e.g., no usable discovery source), say so plainly and design the fallback rather than assuming the happy path.
