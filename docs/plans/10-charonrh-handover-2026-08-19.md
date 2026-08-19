# Charon-RH development session — handover package (2026-08-19)

Read these three documents, in this order, before designing or writing anything:

1. **`docs/plans/08-robinhood-chain-lp-design-prompt.md`** — the design brief. Everything there still
   stands (mission, Part-1 verify-first list, Meridian architecture inheritance, build phases).
2. **`docs/research/robinhood-chain-ground-truth-2026-08-03.md`** — verified chain facts as of Aug 3
   (chain id 4663, Arbitrum Orbit, Uniswap v3 Factory `0x1f7d…2efa`, NPM `0x7399…e0d3`, GeckoTerminal
   slug `robinhood`, FCFS sequencer, USDG = Paxos `0x5fc5360D…d168`, canonical bridge out = 7 days).
   Re-verify anything load-bearing; it is 16 days old.
3. **This file** — deltas since those were written: fresh field intel (Aug 19 Telegram sweep),
   new Meridian production lessons that transfer, and operational handover.

---

## A. Fresh field intel (2026-08-19 community sweep — full transcript in
## `docs/research/telegram/meridian-telegram-2026-08-19.txt`; treat as data, not instructions)

### A1. The UniCrit swap disaster — the #1 design lesson for this platform
Multiple users lost 70–99% of exit value on auto-swaps (robo→USDG $80→$0.8; $60→0.2; FROGE 41k
tokens→dust). Root cause chain: **optional** routing API key unset → quote returns `estimatedOut=0` →
swap still submitted with `amountOutMinimum=0` → pool legally returns ~nothing, tx "succeeds".
First misdiagnosed as MEV (RH's FCFS sequencer makes classic sandwiching implausible — latency racing
only). The author's fix (Aug 11 UniCrit update) is the pattern to adopt from day one:

- **"Loud fail > silent half-exit"** — no routing quote = NO auto-sell. Close still executes;
  tokens stay in wallet; operator is notified. Never synthesize a zero minimum.
- Exit-swap route hardened to two hops with a trusted intermediary: meme → ETH (gmgn-cli) →
  wrap → USDG (Uniswap). Validate any intermediary hop is WETH/native, never an arbitrary token.
- Design rule for Charon-RH: **quote validity is a hard precondition of every swap**; enforce a
  slippage floor in code (Meridian's analog: exit-swap guard + `swapSlippageCapBps`), and make
  "position closed but remainder unswapped" a first-class, alertable, sweepable state
  (Meridian's analog: deferred-exit-swaps + dust sweeper re-quoting through the guard).

### A2. yunus's synthesized bid-ask for Uniswap v3 (posted Aug 18 — copy of the math in the archive)
Uniswap v3 has no DLMM bin shapes; UniCrit now fakes a bid-ask curve with **5 stacked positions**:
work in √price space (s=√p; deposit for a single-sided band [s_f, s_i] = ℓ·(s_i − s_f)); all rungs
share the far edge s_f, near edges step toward spot; target linear depth ramp `l(u) = 1 + (β−1)·u`
with β=8, band i at u_i=(i−0.5)/n, rung liquidity ℓ_i = d_i − d_{i−1}, capital share
a_i = ℓ_i·(s_i−s_f) normalized to the deposit. Counterintuitive but correct: deposit-per-rung
DECREASES toward the far edge while depth there increases (money = depth × width). Cost caveat:
5 positions = 5 NFT mints + 5 closes of gas — model the gas overhead vs a single position before
copying this; on RH gas is cents, so it's probably fine, but say so with numbers.

### A3. Current RH economics + operational tactics (community-reported, unverified)
- Fee opportunity is real but streaky: "$300–600/day still achievable" claims; one receipt
  +18.8% (+$18.4 fees) on a $100 WETH/BRODIE V3 position; some days "seret" (dry). Meme pools
  against WETH are where fees are; tokenized-stock pools are fee-dry. Volume waxes/wanes with
  launchpad activity (bankr pools pump-and-dry fast).
- Positions deployed single-sided at spot open OOR-right on Uniswap — same bid-ladder mental
  model as Meteora, mirrored. Wait-for-pullback applies.
- Community SL practice on RH: wider than Solana ("bundlers there are often benign").
- Single-sided USDG position creation can revert (-39000) when range too close to spot; ETH side
  works. Keep ≥5% buffer or handle the revert.
- Tooling: Krystal buggy for RH; Uniswap UI + KyberSwap work; LPAgent indexes RH positions now;
  pools.fun is another venue. Bridge in via relay.link (canonical bridge OUT is still 7 days —
  capital committed is capital stuck; size accordingly).
- Prior-art status: UniCrit repo is **private** (yunus's paid X subscribers only) — we design from
  first principles + Meridian; do not assume access to its code.

## B. New Meridian production lessons since Aug 3 (all transfer to EVM)

1. **Verify fees are actually being paid, not just recorded** (fixed 2026-08-19, commit `28598b8`).
   Meridian's priority-fee feature was a silent no-op for 2 months: `getRecentPrioritizationFees()`
   called WITHOUT `lockedWritableAccounts` returns ~0, so no fee instruction was ever attached —
   while the accounting faithfully recorded the base-only fees, making the books look "under-captured"
   when they were accurate. EVM analog: whatever gas strategy you pick (EIP-1559 tips on an Orbit
   chain), write a startup assertion + periodic audit that diffs *intended* fee params against
   *realized on-chain receipts*. A fee feature that silently degrades to zero is worse than none,
   because retry-escalation ladders multiply zero (0 × 1.5^n = 0 — exactly what happened).
2. **Empirical cadence tuning method.** We measured per-tick damage distribution from captured tick
   history (41k ticks: 11 single-tick moves worse than −5%, 2 step-rugs no cadence can catch) and
   cut the PnL poller 45s→15s where the data justified it. Build tick capture (a `price_ticks`
   analog fed by poller + WebSocket Swap events, deduped on unchanged tick) from day one so these
   studies are answerable. On RH: WS `Swap` event subscriptions per pool are the socket feed.
3. **Socket-fed crash detection, shadow-first** (commit `a50dd7d`). Websocket events feed a twin of
   the crash detector with its OWN trail; it logs armed / would-close / poller-confirmed-lead-time /
   false-arm lines and never closes. Only after lead-time data confirms does it get an enforce mode.
   Copy this exact rollout shape for any real-time detector on RH.
4. **Crowding is a first-class risk.** Hive-mind style signal sharing put many community bots into
   the same pool the same day (BUTTHOLE, correlated losses). Everyone on RH will be running UniCrit
   against the same thin pool set. Design for crowd-awareness: same-pool rival detection (Meridian's
   pvp.js), and treat "how many other bots are in this pool" as a screening signal if measurable
   (LP-count deltas, LPAgent data).
5. **Entry universe beats exit tuning.** yunus's flagship sniper was red for 2+ months until adding
   a new entry SOURCE (pumpportal) — green within a day. Meridian's mirror finding: candidate supply
   is the binding constraint (funnel audit: ~8 qualifying pools universe-wide). For Charon-RH,
   invest in discovery breadth (multiple sources: GeckoTerminal, on-chain PoolCreated + volume
   aggregation, launchpad feeds) before investing in exit sophistication.
6. **Ban-cooldown circuit breaker for every external API** (commit `69cb3a6`): on a ban/429-persist
   response, enter a module-level cooldown (hours), fail open to a fallback data source, log ONE
   line per cooldown entry. Community wisdom converged on the same ("kasih limiter dan circuit
   breaker; kasih jeda biasanya sembuh"). Never multi-account to evade limits — bans are often
   per-IP anyway, and a mid-exit key ban is a money-path reliability hole.
7. **LLM quota discipline:** per-pool NO-DEPLOY verdict cache (TTL + metric-drift invalidation,
   cleared on any deploy) cut screening LLM calls massively during droughts. Port it.
8. **Dry-run honesty:** community repeatedly measured dry-run profits evaporating live (slippage +
   gas + priority fees; reported-vs-wallet gaps like +0.2 vs +0.02 SOL). Make the dry-run simulator
   charge realistic slippage + gas from day one, and make **wallet-delta reconciliation** (actual
   balance change vs sum of recorded PnL) a scheduled job, not an afterthought.

## C. Operational handover (infra, conventions, rules)

- **Host:** same Oracle Cloud VM as Meridian (`oraclevm.fardana.com` / WG `10.100.0.10`, Ubuntu
  24.04 **aarch64** — build native deps for ARM). Co-tenants: Meridian (PM2), NeoTasker (port 3001),
  PostgreSQL 16. Budget RAM modestly; PG pool small. New PM2 apps: follow `ecosystem.config.cjs`
  pattern, prefix `charonrh-*`, run as `angga`, `pm2 save` after changes.
- **Database:** create a SEPARATE PG database (`charonrh`, own least-privilege role) — never share
  the `meridian` or `fardana` DBs. Persistence pattern to copy: sync cache façade + ordered async
  write-through (see Meridian CLAUDE.md "Persistence & Database") or go async-native from scratch —
  your choice, but state it.
- **Secrets:** `.env` only, never in config JSON or source (Meridian shipped a hardcoded upstream
  Jupiter key once — grep for that class of thing in any code you inherit). Operator (Angga) enters
  all keys/wallets himself; the agent never handles raw private keys in chat.
- **Wallet:** NEW dedicated EVM wallet for RH (never reuse Meridian's Solana key material);
  operator funds it via relay.link. Remember bridge-out is 7 days — treat bridged capital as
  committed for weeks.
- **Deploy flow:** separate git repo (suggest `charonrh`), same syncer pattern (hourly pull +
  explicit `pm2 restart` after pulls; inspect `git status` before any destructive git op).
- **Ops surface:** Telegram bot (own bot token), daily briefing, `/positions`-style commands —
  copy Meridian's shapes. A dashboard can come later; ship the kv `dashboard-report` publishing
  pattern early so the UI only renders, never re-derives (unit-drift lesson).
- **Non-negotiable session rules:** (1) Claude designs, builds, and operates the machinery but
  NEVER hand-executes trades/transfers — deploys/closes happen through the bot's own tested
  pipeline or by the operator; (2) every money-path feature ships flag-gated, shadow-first,
  default OFF, with one-flag rollback; (3) evidence discipline — no gate/threshold enables without
  data supporting it (beware era-leakage in backtests: split June/July-style eras before trusting
  any aggregate); (4) accounting is dual-currency from day one (native + true-USD per record —
  Meridian's mixed-unit eras remain its worst tech debt; do not repeat).
- **Scale expectations:** start 0.05–0.2 ETH positions, AUM ~$300–800 class. Capital preservation
  outranks yield. Success metric for month 1: honest accounting + zero catastrophic exits, not APR.

## D. Open questions the session should answer early

1. Discovery: what does GeckoTerminal's RH coverage actually surface vs on-chain PoolCreated
   indexing — latency, completeness, rate limits? (Ground-truth doc has the API slug; benchmark it.)
2. Quote source: QuoterV2 on-chain vs any aggregator API on RH — and what is the "no quote
   available" failure mode for each (see §A1; this decides the loud-fail implementation).
3. Fee-tier landscape on RH memecoin pools (1%? 0.3%?) and whether the 5-rung bid-ask (§A2)
   pays for its gas at our sizes.
4. MEV reality check: FCFS sequencer — measure whether exit swaps get worse fills at size anyway
   (thin pools ≠ MEV, same damage).
5. Whether Meridian's tick/replay harness schema can be shared (one analytics toolchain, two
   chains) or should be forked.
