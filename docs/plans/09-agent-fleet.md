# Plan 09 — Agent fleet: archetype agents + orchestrator (yunus's 5-agent model)

**Edge copied:** yunus's fleet — 5 wallets, 5 logics (`degen`, `multiday`, `stable`,
`hiddengem`, `manual`), interconnected, with one orchestrator that detects mistakes and
pushes improvements. His throughput (146 positions/day) is a *consequence* of running
differentiated strategies in parallel; the learning compounds across all of them.

**Key insight that makes this cheap:** prod has already organically drifted into the
`multiday` archetype (1h timeframe, wide 69–120 bins, 12–24h OOR patience, trailing-TP
exits, small size — and it's working: recent success rate 67% vs 42% lifetime). Every knob
that differentiates yunus's agents is already a `user-config.json` key. The fleet is
**N checkouts × N configs × N wallets**, not new strategy code.

---

## Archetype mapping (config presets, not code)

| Archetype | Intent | Key config deltas from multiday (= current prod) |
|---|---|---|
| `multiday` | ride established pools for days | **current prod config as-is** |
| `degen` | fast scalps on young heat | playstyle `tight` (35–45 bins), `timeframe: 5m`, token age 2–24h, `stopLossPct: -10`, trailing 2/0.75, `outOfRangeWaitMinutesBelow: 20`, crash ON, smallest size |
| `stable` | majors/LST fee farming | `minTvl: 250k+`, `maxMcap: ∞`, low bin-step band, `minOrganic` low (majors aren't "organic"), longest holds, largest size |
| `hiddengem` | early low-caps, safety-first | `minMcap: 100–500k`, `useDiscordSignals: true`, `screeningAdmissionMode: rank`, `safetyEnrichMode: enforce` **paired with intel ≥ ~60** (per the 2026-07-11 rebaseline), tiny size |
| `manual` | the human | already exists — `/deploy`, `/close` in any agent; not a process |

Each archetype's exit knobs should respect the corridor rule (see §Backstop note below):
crash path covers fast rugs, ratchet covers winners-turned-losers, and a mid stop-loss
covers never-armed slow bleeders. No archetype ships with an uncovered corridor.

---

## Isolation model (zero/near-zero code change)

One **checkout per agent**, all tracking `experimental`:

```
/opt/meridian            → multiday (existing, untouched)
/opt/meridian-degen      → degen
/opt/meridian-stable     → stable      (later)
/opt/meridian-hiddengem  → hiddengem   (later)
```

- `repoPath()` scopes `user-config.json` + all JSON fallback stores per checkout for free.
- Per-checkout `.env`: own `WALLET_PRIVATE_KEY`, own `PGDATABASE=meridian_degen` (same
  Postgres instance; one `CREATE DATABASE` + role + `npm run db:migrate` per agent — the
  meridian/NeoTasker split already proves this pattern on the VM). Remember the env gotcha:
  `.env` overrides shell exports.
- PM2: add per-agent apps to the ecosystem file with distinct `cwd` (main + watchdog per
  agent; one shared dashboard can read multiple DBs later). `pm2 save` after changes.
- Syncer: extend `meridian-syncer` to `git pull --ff-only` every checkout (or one syncer app
  per checkout). Same inspect-before-reset discipline applies to each tree.
- **Stagger the crons** (`screeningIntervalMin` offsets / different minutes) so N agents
  don't hit Helius RPC + OpenRouter + the Meteora discovery API simultaneously. Watch the
  PnL poller: N agents × 45s polls share the Helius key — raise `pnlPollIntervalSec` on
  slow archetypes (stable/multiday genuinely don't need 45s).
- RAM is a non-issue (~200 MB/agent on a 24 GB box). LLM cost multiplies by N — degen on the
  cheaper `deepseek-v4-flash`, keep `-pro` for archetypes with harder deploy decisions.

**The only real code change: Telegram identity.** All agents share one bot/chat; without a
prefix the notifications are indistinguishable. Add `AGENT_NAME` (env) and prefix every
outbound message + briefing title in `telegram.js` (~20 lines). Commands need scoping too —
simplest: `/positions` etc. answered by every agent with its prefix (read-only, harmless);
destructive commands (`/close`, `/set`, `/stop`) only honored when the message starts with
the agent's name (e.g. `degen /close 1`), bare form reserved for the primary agent.

**Cross-agent isolation guarantees:** separate wallets (no duplicate-pool/token collisions
possible on-chain), separate DBs (no state_meta clobber cross-talk), separate configs (each
agent's `evolveThresholds` learns its own niche independently — this is the point).

---

## Orchestrator (house pattern: advisory → bounded enforcement)

Per-agent self-correction already exists (`evolveThresholds` + auto-revert + starvation
relaxer). The orchestrator is the **cross-agent** layer only:

**v1 — read-only scoreboard (ship first).** `scripts/fleet_scoreboard.js` + a PM2 cron
(weekly + on-demand `/fleet` command):
- Opens each agent DB read-only (libpq creds per agent), pulls perf records, scores with
  `classifyOutcome` over a recency window (last 40 closes per agent, same as evolution).
- Reports per archetype: success-rate, ROI (SOL-true fields only — mind the unit landmine),
  fee yield, closes/day, gas-adjusted PnL, worst exit. Posts to Telegram.
- No authority. Two+ weeks of scoreboards before v2.

**v2 — bounded capital rebalancer.** The fleet-level analog of `evolveThresholds`:
- Adjusts each agent's `positionSizePct` toward winners, ±1 step/week, hard bounds
  (e.g. 0.10–0.40), significance gate (Wilson/Cohen's-d like evolution), and closed-loop
  auto-revert if fleet-total success-rate regresses after a change.
- Mechanism: write the target agent's `user-config.json` **with that agent stopped or via
  its own `update_config` path** — never live-edit a running agent's file (external writes
  lose to in-process persists; same class of race as the state_meta clobber).
- Lesson/blacklist sharing: v2.5. Cheapest form — orchestrator copies `token-blacklist`/
  `dev-blocklist` entries across agent DBs daily (they're per-DB doc stores). Full lesson
  exchange can ride `hive-mind.js` (self-hosted) if ever justified.

---

## Rollout phases

**F0 — offline validation (free, this week).**
- Admission policies: replay `degen`/`hiddengem` candidate filters against the
  rejected-candidates store (now ~1 week of data) + a `rank_admission_backtest`-style
  script per archetype: "of pools this archetype WOULD have admitted, what did their mcap
  do at +30/60/180m?" (post-close-probe method applied to rejects).
- Exit knobs: replay harness (`--rule stop|trailing|ratchet`) under each archetype's
  proposed exit set, hi-confidence columns only.
- Gate: an archetype ships only if F0 shows its admission slice has ≥ baseline success
  signal. Expect `degen` to pass easily (it's our old pre-drift behavior with better exits).

**F1 — second live agent: `degen` (max contrast with multiday).**
- Setup: new checkout + `.env` (new wallet, `PGDATABASE=meridian_degen`) + migrate + PM2
  apps + telegram `AGENT_NAME` change + staggered crons. ~half a day.
- Fund with 25–30% of capital. Degen's fast closes also fix the learning-throughput problem
  (multiday alone yields ~2.5 closes/day — evolution fires every ~2 days).
- Success criteria (2–3 weeks): ≥15 closes, success-rate within 10pp of multiday OR clearly
  complementary time-of-day/regime coverage (check `/timing` per agent).

**F2 — orchestrator v1 scoreboard** over the two agents. Decision input for F3.

**F3 — `stable` + `hiddengem`** only when: (a) scoreboard shows real differentiation,
(b) capital ≥ ~4× current (five gas reserves at 0.3 SOL each is dead weight below that),
(c) F0 validates their admission slices. Then orchestrator v2.

---

## Capital reality check (the honest constraint)

At current AUM (~0.35 SOL deploys, 0.3 gas reserve/wallet), 5 funded wallets ≈ 1.5 SOL of
idle gas reserves. yunus's 146 positions/day only pays at his capital scale; at ours, gas +
exit-swap slippage (already under-captured per CLAUDE.md) would eat the margin. Hence:
2 agents now, 4 later, 5 never (manual isn't a process). Scale the fleet with AUM, not
ambition.

## Backstop note (exit-corridor rule, applies fleet-wide)

2026-07-12 finding: with ratchet+crash+TWAP ON and SL=−75, a never-armed slow bleeder had
no protection between entry and −75 (reptilecoin 07-11: MFE +0.91 → −59.7 final). Replay
n is tiny for deep stops, but the only path crossing −35 kept falling (−35 exit beat
reality by +14pt, −50 by +8.5pt), and deep *unconfirmed* dips that recovered (ok-SOL −86
tick → +2.05 close) are glitch-class marks the 15s confirm + TWAP guard filter anyway.
Prod set to `stopLossPct: −35` accordingly. Every archetype must define its own corridor:
crash (fast), ratchet (armed), mid SL (never-armed) — no gaps.

## Risks

- **Shared-fate infra:** one VM, one Helius key, one OpenRouter key — a rate-limit or VM
  outage hits the whole fleet. Acceptable at 2 agents; revisit (second RPC key, or move one
  agent off-box) at 4.
- **Config drift:** archetypes are configs, and configs mutate (evolution, relaxer, agent
  tunes). The scoreboard must print each agent's current floors so drift is visible —
  otherwise degen slowly evolves into multiday and the fleet's diversification silently
  collapses.
- **Same-pool competition:** two agents CAN both deploy into the same pool (separate
  wallets bypass the duplicate-pool check by design). At our sizes this is negligible PVP;
  orchestrator v1 should still flag same-pool overlap so we see how often it happens.
