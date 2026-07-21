# Meridian Upstream Telegram Mining — Insights Report
Scrape window: July 3–21, 2026 (Meridian Discussion forum 7 topics + channel). Fork = yunus-0x/meridian (upstream). Community is ~90% Indonesian retail LPers running the stock/experimental bot; heavy PnL-bot spam. Indonesian quotes translated inline.

Coverage caveat: "Meridian - The DLMM" complete July 5–20; other topics have a ~July 4–20 middle gap. Feedback & Issues near-complete (highest-signal). Kaiiserrr's full deterministic ruleset was only captured as a reply-quote preview, not the full message.

---

## 1. Adoptable ideas (ranked by expected value for OUR fork)

### A. Close-efficiency / hidden-cost gate on the CLOSE decision — small code, HIGH value
**What:** Rush's RSRLP (July 17, "Rush | ADFMIDN") adds "Hidden cost protection: pre-flight Jupiter V6 quote + close efficiency gate (block <95%)" and `closeMinReturnPct: 101`. A live close bot ("pabo", July 14) prints `🟢 Hidden cost: +0.0796 SOL (179.7% of DLMM PnL)` on a febu-SOL trailing-TP close — i.e. the round-trip swap/rent cost exceeded the DLMM PnL.
**Why it helps us:** We have an exit-swap price-impact guard (>5% quoted → hold small remainders), but it does NOT feed back into whether the close itself is worthwhile. Upstream's gate blocks a mechanical close when the realized-after-costs return would be < a floor — directly attacks the "trailing-TP fires at +3% but nets −3.7% after swap+gas" pathology that dominates the July 13–14 complaints (DonCorleone's Bison-SOL: `PnL ◎-0.01 (-3.70%)` from `Trailing TP peak 1.99%→1.49%`).
**Effort:** small code — reuse our existing `getSwapQuote` pre-flight; add a `closeMinReturnPct`-style net-of-cost floor to the mechanical-close path (stop-loss must still bypass it).
**Risk:** must never block a genuine stop-loss/crash exit — gate only the discretionary trailing-TP/low-yield closes.

### B. LLM "escalation → OVERRIDE → HOLD" of a valid trailing-TP — feature, HIGH value, aligns with our data
**What:** amsjong (July 15 17:32) posted the bot's own reasoning: `### Escalated Position: brain-SOL — OVERRIDE → HOLD. Trailing TP condition met (peak 14.52% → 10.47%, drop 4.05% ≥ 2%), but overriding … Yield 68%, fee velocity ◎0.0357/30min, in-range, decomp +16.07% fees vs −5.60% price_pnl, pool history 6 deploys 100% win.` F J (July 15) explains the mechanism: "Management cycle gives authority to the LLM; hard rules stay but become alerts for the LLM."
**Why it helps us:** This is external corroboration of our strongest empirical result — truncating the fat right tail costs more than early exits save (tested NEGATIVE 4×). Upstream lets a still-earning, in-range, high-fee-velocity position run past the mechanical trailing trigger. Our fork's TWAP wick guard only *defers* an exit briefly; it has no fee-velocity/decomp-aware "let the winner run" override.
**Effort:** feature — an escalation seam before the mechanical trailing-TP fires that hands the LLM the decomp (fee_pnl vs price_pnl), live yield, and fee velocity, capped so it can only HOLD when in-range AND fee velocity above a floor.
**Risk:** LLM discretion on the money path; gate tightly (in-range only, never overrides stop-loss/crash/ratchet). Could regress if the model hallucinates fee velocity — feed it computed numbers, not free-form.

### C. Per-pool re-entry cooldown + max-redeploy cap (deterministic hard-gate) — small code, medium value
**What:** Zengbar (July 3, Feedback & Issues) reported the bot opened DR-TRUMP/SOL **5× in 16:00–16:21 UTC** despite a supposed 3-redeploy cap + 12h cooldown. Root cause theory (Zengbar, July 3 11:20, translated): "it isn't breaching the rule — it reads the cooldown/position state slower than it executes, so it's a race." Fix advice from Tuco Salamanca: "put it in a hard-gate/hard-block that the LLM can't touch." UniQ Farm (July 13 21:00): "meridian error, deployed 7 positions in one pool at once."
**Why it helps us:** Our fork has NO per-pool cap or re-entry cooldown (listed as a candidate gap). We already prevent duplicate *open* pools/tokens in executor safety checks, but nothing stops rapid re-entry into the *same* pool after a close — and the "deploy then instantly close then re-deploy → nyangkut" loop is a recurring complaint (r, July 10: "bot TP'd then re-entered and got stuck").
**Effort:** small code — a persisted per-pool `last_deploy_at` / redeploy-count check in the executor deploy safety block (deterministic, pre-LLM), analogous to our existing dedupe checks.
**Risk:** low; make it config-gated. Note our race defense already uses `force:true` fresh position scans — verify that also covers same-pool redeploy counting.

### D. SuperTrend / BB+MA technical entry gate (deterministic pre-filter) — feature, medium value
**What:** Rush RSRLP (July 17): "Resistance-Support Range LP, SOL BID-only. Deploy on pullback while trend still bullish. SuperTrend 15m and/or 1h as trend reference; if price <51 bins from nearest ST, deploy Spot bid-only." BB+MA fallback (KG Method, July 16): "two-tier entry — SuperTrend primary (trending) → BB+MA fallback (ranging); if ST blocks all timeframes, allow MA-flat + %B ≥0.7 + <31 bins from MA as override. Default SMA 20." Upstream ships `tools/chart-indicators.js`; Al (July 17): "compute SuperTrend yourself from Meteora candles" for accuracy.
**Why it helps us:** We have rich pre-deploy analytics (fee-efficiency, organic momentum, episodic memory) but no price-structure/trend entry gate. A "don't deploy a bid-ladder into a still-falling downtrend" filter could cut the −18% to −34% OOR-below disasters (SOLdiers −19%, Wukong −34%, REAL −18%). Note several users report the indicator path has false alarms (K, July 14: "better set it false, lots of false alarms") — so ship advisory/shadow first, exactly our house pattern.
**Effort:** feature — candle fetch + SuperTrend/BB math; wire as an advisory candidate line, then optional hard-filter.
**Risk:** indicator false-positives; our episodic-memory + fee/TVL discriminators may already capture most of the signal. Validate against our replay harness before enforcing.

### E. Hybrid single-position 50/50 BidAsk+Spot (and 70/30) — small code, medium value
**What:** areio (July 4), the most-respected operator in-channel, runs "hybrid": ONE position, 100% capital split 50% BidAsk + 50% Spot, stacked via add-liquidity (not two positions) — "70:30 for now." r confirmed the technical trap: naive two-position hybrid pays **double rent**; the correct form stacks both shapes on one position so rent is single.
**Why it helps us:** We have a `shape` param (spot/curve/bidask) but it's one shape per deploy. A blended intra-range curve (edge-weighted BidAsk for dip capture + Spot for fee density near price) is a genuine gap and a top operator's default.
**Effort:** small code if the Meteora SDK supports multi-shape add-liquidity on one position; verify in `tools/dlmm.js`.
**Risk:** SDK/bin-array complexity; rent/gas accounting.

### F. hermes_bot's direction/momentum/health bin multipliers — small code, low-medium value
**What:** hermes_bot (July 4 06:24) reverse-engineered upstream bin calc: base linear `bins = round(lo + volatility/5·(hi−lo))`, then **coverage = base × dirAdj × momentumAdj × healthMult**, where dirAdj: 1h_change<−5% → 1.15 (bearish→wider), >+5% → 0.85 (bullish→narrower); momentum: buy_ratio<35% → 1.15, >65% → 0.90; health: healthScore≥30 → 0.85 … <12 → 1.30. Clamp [minBins,maxBins]; hard floor 35, cap 150.
**Why it helps us:** Our bins formula is volatility-only. Widening on bearish 1h drift / low buy-ratio and narrowing on strength is a cheap, deterministic refinement of range width using data already in our discovery payload (organic-momentum already reads the change_pct fields).
**Effort:** small code — multiply our existing clamp by these factors.
**Risk:** low; the multipliers are unvalidated community reverse-engineering ("don't swallow raw," areio warned) — A/B via replay.

### G. Stop-loss auto-swap-to-SOL (already covered) + dual-side deploys (info only)
Kriptodh (July 14) requested "on SL also auto-swap to SOL to minimize rug exposure" — **we already do this** (auto-swap remainder after every close). Faaa Dev (July 17) is "adding dual-side position support, still miss-deploys sometimes" (58.75% downside / 34.78% upside cover) — we deploy single-side SOL-below only; dual-side remains a real gap but upstream's own attempt is buggy, so low priority.

---

## 2. Bugs & failure modes to check in our fork

1. **Deploy notification "undefined" + phantom position (July 4 Ricky/CrewChill; July 21 amsjong).** `✅ Deployed 7cKWqi6f … Position: undefined… Tx: undefined…`; amsjong: deployed with "?", no notif, Meteora shows the pool **empty**, only worked after a manual close. **Check:** our deploy-notify formatting AND our landed-deploy verification (commit `2ba7222` "verify landed deploys" / `2ba7222` auto-adopt orphaned) — confirm a failed/half-landed deploy can't leave a tracked-but-empty ghost. Upstream also hit `undefined` in dry-run mode.
2. **Pool Discovery 400 Bad Request (July 3 Jepe; July 12 gusbramm; multiple).** Root cause (m0rt, July 4; confirmed gusbramm July 12): invalid `timeframe` in user-config — **Meteora accepts only 5m/30m/1h/2h/12h/24h; 15m is NOT supported** and silently 400s; also a typo'd model id. **Check:** `tools/screening.js` should validate `timeframe` against the allowed set and fail loudly, not pass through a 400. (Our CLAUDE.md lists timeframe default "5m" — confirm no 15m path exists.)
3. **Deploy-then-instant-close (July 6 Liselyn; July 14 Zhen/K/Hold-Your-Bags).** Two sub-causes: (a) OOR-right within seconds of deploy; (b) `total bins 1 is below minimum 35 → Refusing 1-bin deploy` where the LLM/formula produced a 1-bin range ("kok kebacanya bin 1 terus"). **Check:** our bins clamp + volatility-zero handling (we treat zero/missing volatility as unusable) and OOR-grace on fresh positions (commit `a887197` adoption grace) — ensure a degenerate volatility feed can't collapse to 1 bin.
4. **5-positions / 7-positions on one pool (Zengbar July 3; UniQ Farm July 13).** Redeploy-count race — see idea C. **Check:** our `force:true` fresh scan counts *open* positions but may not throttle same-pool *redeploy* frequency.
5. **RPC 429/503/522 → apparent capital loss (July 6 THE BOYS `-32429 max usage reached`; July 9 Dhenz `Helius 503/522 intermittent … state-sync capital "lost" likely returned to wallet, not a real loss`).** **Check:** our `reconcileStateWithChain()` + Meteora-portfolio fallback path handle this, but verify the fallback doesn't mis-book PnL. Alex Ferguso (July 21): Helius free tier exhausted + expensive — RPC cost/limits are a live pain point.
6. **Meteora portfolio PnL API desync (July 13–14, widespread).** Upstream reads OPEN-position PnL from Meteora's portfolio API, which showed +12% while on-chain was −1% (F J, UniQ Farm: "agent thinks trailing is right because it reads Meteora dashboard PnL"). **This is our EDGE** — we compute on-chain + dual-currency `*_true_usd` — but verify our PnL poller never falls back to the Meteora portfolio number for exit decisions.
7. **Screening "no tool call was made" (July 17 Distortion; July 19).** Weak/low-max-token LLMs (tencent hy3, gemini-flash) return no tool call. **We already handle this** (noToolFallback → ℹ️ no-action). Confirmed root causes upstream: wrong model, too-low max output tokens.
8. **401 Missing Authentication header on screening (July 21 Galvin).** Likely a missing/blank API key env — worth a clearer error in our screening path.

---

## 3. Config / strategy wisdom (attributed, concrete numbers)

- **Rush | ADFMIDN (July 17), tuned over months, no-LLM:** `deployAmountSol 2, maxPositions 4, stopLossPct −12, takeProfitPct 10 (fixed), trailing 7%/1%, closeMinReturnPct 101, minScore 65`; scoring v2 weights drawdown 0.35 (strongest), structure_score 0.40; `autoEvolveEnabled false`; blocked pools RUSH/WORLDCUP/febu/LEVI/SOLdiers + 2 addresses; entry SuperTrend 15m/1h, deploy when <51 bins from ST; BB+MA fallback %B≥0.7, <31 bins from MA, SMA 20.
- **Stop-loss levels:** rj & K|$ZRO run **SL −25%** (rj: max seen −18%, "rarely touched"); Megalodon Papi (July 4): "dynamic loss minimized it — should've been −11%, only lost −7%." Our −15% sits mid-range; community split −12 to −25.
- **Trailing too tight is a known trap:** DonCorleone's `trailing drop 0.5%` closed Bison at −3.70%. Our 3%/1% is deliberately looser — validated by their pain.
- **Bin width:** Megalodon Papi (July 10) "10 bins = fast [fees]"; Pratama contrasts `−90 spot` vs `−5 spot` as wholly different outcomes; Ben10Coin tried minBinBelow 25 / max 60 and "stuck, trending down." bin step <80 discussed but no consensus.
- **Position sizing & slippage:** Pratama (July 11/15): PnL under **0.01 SOL is eaten by swap slippage**; 0.1 SOL/deploy too small; bring ≥5 SOL and never set 0.1% TP ("5 SOL × 1% = 0.05 SOL, safe from slippage"). Kaiiserrr runs 0.1 SOL/deploy (deterministic, high-frequency) — opposite school.
- **Min volume / timeframe:** Pratama runs minVolume ~5k; timeframe choice materially changes candidate set; avoid 15m (400s).
- **Model:** consensus **deepseek-v4-flash** = most reliable cheap model (dalbo, Bang Kentut Harum, Rush); v4-pro "actually worse + pricier" (dalbo); free tencent hy3 / gemini-flash cause no-tool-call failures. Sorey: for strong models keep temperature <0.2.

---

## 4. Market / ecosystem intel

- **Bonk launchpad → Robinhood chain volume migration (Kaffra, July 21 07:49, translated):** "Almost every coin dumped at 4am. Turns out Bonk built a launchpad on RH [Robinhood], volume fled to rh67 at dawn." This drove broad Solana memecoin dumps (REAL −18%, mass OOR-left). Weeks-long meta shift: many operators moved to LPing on Robinhood's chain (Uniswap V3/V4-style — the WETH pairs in PnL bots) because "safer for multi-hour, less heart-attack than Solana" (Have a Shib, 0xkulo8). **Implication for pool selection:** Solana memecoin volume is structurally thinner mid-July; our fee/TVL floors may be starving (matches our own screening-starvation history). Watch for a Meridian RH-chain fork.
- **"Superman" deployer known to rug on Robinhood chain** (Gunawan July 10) — candidate dev-blocklist entry if we ever add RH support.
- **Ansem-tagged token spam / one deployer minting 70% supply to named-person tokens** (きつりゅう, July 5, translated): "dry market lately partly because of this account — daily floods of tokens, 70% supply sent to the person it's named after; most top performers are all his, and they all fail the top-holder filter." Reinforces our top10/insider concentration gates.
- **Meteora Season / campaigns + airdrop (yunus channel, July 20):** `app.meteora.ag/campaigns`, referral code "yunus" for +10% stake boost, "FIRST WAVE" referral cards. LP activity is partly airdrop-points-farming driven — relevant to why users tolerate low fee yields.
- **SCAM — active (yunus channel July 9 + Dhenz, Feedback & Issues July 9):** `@meridiancustomercare` impersonates Meridian support and **pressures users to connect their wallet**. yunus: "I will never DM you first." Guard: never surface/echo such handles as actionable.
- **Supply-chain risk:** in-channel sellers hawking cheap LLM API keys (0xLigma: codebuddy CN Rp10k/acct; tencent hy3; "cloud codecrafters"). Users routing the money-path agent through resold/free keys — data-exfil and reliability risk we should never emulate.
- **New tooling:** Azdhar building an **open-source Go Meteora DLMM SDK** (July 15) — "faster than JS, lower learning curve than Rust, cheaper vibe-coding tokens." Community dashboard at `dashboard.dlmm.my.id` (public-address lookup). LPAgent web + evilpanda/bravonoid X accounts cited as strategy sources.

---

## 5. Validation — what upstream struggles with that WE already solved

1. **PnL desync from Meteora portfolio API** (widespread July 13–14) → we compute on-chain + `*_true_usd` dual-currency.
2. **Exit slippage on small remainders / sub-0.01-SOL PnL vanishing in swap** (Pratama, BeRich) → we have exit-swap price-impact guard + dust sweeper w/ ATA-rent reclaim.
3. **State-sync "lost capital" panic from RPC 503** (Dhenz) → `reconcileStateWithChain()` + auto-adopt orphaned on-chain positions (`2ba7222`).
4. **Ghost/undefined deploys** → landed-deploy verification.
5. **"No tool call" LLM failures** → noToolFallback with calm no-action notice.
6. **Redeploy-into-same-pool "TP then re-enter then stuck"** → partially (dedupe on open pools) but NOT re-entry cooldown (gap C).
7. **Request for SL auto-swap-to-SOL** (Kriptodh) → already default.
8. **Auto-compounding request** (Serdy Fambo) → we have shadow feeCompound gate.
9. **Screening starvation from over-tight filters** (Al, Kay, many) → we ship the cycle-based starvation relaxer + funnel telemetry.

---

## 6. Contradictions with our results bank (do NOT auto-adopt)

- **Kaiiserrr's deterministic bot: ~100–165 trades/day, >50% win, 0.1 SOL/deploy, no LLM** (Charon topic, July 20) directly tempts the "frequency = edge" thesis. **Clash:** our bank says frequency alone is not the edge and small 0.1-SOL deploys bleed to slippage (Pratama corroborates!). >50% *win-rate* on tiny size is not net-of-slippage profit — likely fee-death wins our `classifyOutcome` would score as failures. Keep our stance; the win-rate metric is the same trap our lessons engine already corrects.
- **Rush's TP 10% FIXED (age-based disabled)** is a hard profit cap. **Clash:** we tested profit-capping NEGATIVE four times — truncating the fat right tail costs more than it saves. Do not adopt fixed TP; the amsjong OVERRIDE→HOLD behavior (idea B) is the correct direction and actually *supports* our finding.
- **Trailing drop 0.5%–1% (DonCorleone, KANG PACUL `dropped 0.92% ≥ 0.8%` closing at −1.8%)** — ultra-tight trailing that closes winners at a loss. **Clash:** confirms our replay finding that tighter trailing than 3%/1% truncates winners; our looser default is right — don't tighten.
- **SL −25% school** (rj) vs our −15%. Not a hard contradiction, but note: our young-token data shows −10% has zero winner-kills and −5% beheads winners; a −25% SL risks the 19% young-token disaster tail. Keep our age-conditional stop.

---

## 7. Top 5 do-next shortlist

1. **Close-efficiency / net-of-cost gate on discretionary closes (idea A).** Highest EV, small code, reuses our pre-flight quote — kills the "trailing TP fires but nets a loss after swap+gas" pattern that dominates upstream complaints. Stop-loss/crash exempt.
2. **Add per-pool re-entry cooldown + redeploy cap as a deterministic pre-LLM hard-gate (idea C).** Closes a real gap; upstream's #1 reproducible bug (5–7 deploys on one pool); low risk, config-gated.
3. **LLM escalation → HOLD override for still-earning in-range winners (idea B).** External corroboration of our fat-tail edge; lets winners run past the mechanical trailing trigger when fee velocity/decomp justify it. Ship shadow-first.
4. **Audit our timeframe/deploy-notify/landed-deploy paths against the upstream bug list (§2 items 1–3).** Cheap hardening; confirm 15m/typo timeframes fail loudly and no ghost positions can be tracked.
5. **Prototype SuperTrend/BB+MA advisory entry line + hermes-style dir/momentum bin multipliers (ideas D+F), validated via the replay harness before any enforcement.** Structure-aware entries could cut the −18% to −34% OOR-below disasters; ship advisory/shadow given upstream's false-alarm reports.
