# Plan 06 — Dataset-Driven Tuning (review + refinement of the Antigravity proposal)

**Status:** REFINED PLAN (supersedes the Antigravity `implementation_plan.md` of 2026-07-05).
**Dataset:** `bengbeng-explainer-HMBF_DRgp-20260705.json` — 181 closed positions, 2026-06-05 → 07-05.
**Verdict in one line:** the diagnosis (fat-tail losses) was right but dated; every "current
value" in the proposal was wrong, one proposed change would have *loosened* a threshold, and the
biggest live opportunity (break-even churn) went unmentioned.

---

## 1. Fact-check — proposal vs. live prod config (verified on VM 2026-07-05 17:38)

| Key | Plan claimed current | **Actual live value** | Plan proposed | Consequence of applying |
|---|---|---|---|---|
| `minMcap` | 150,000 | **500,000** | 300,000 | Would **LOOSEN** screening by 40% — the opposite of the plan's intent. REJECT. |
| `outOfRangeWaitMinutesBelow` | 180 | **60** | 45 | Premise stale (60 since the June overhauls). 60→45 is marginal; defer to evidence (§4 A3). |
| `crashFastPathEnabled` | false | **true — enabled 16:02 today** (user-config.json mtime + PM2 restart 24→26; applied outside this repo's rollout, presumably by the Antigravity monitor) | true | Already live, but with **zero shadow calibration**. Needs the monitoring criteria in §4 A2, not a proposal. |

The plan read `config.js` **defaults**, not the live `user-config.json` on the VM. It also
proposed committing `user-config.json` to git — that file is **gitignored** (and was scrubbed of
secrets on 2026-06-30; committing it is a security regression). Config changes go through
`update_config` (Telegram `/setcfg`), which live-applies and persists **without a restart**.

## 2. What the analysis got right

- **Fat-tail diagnosis confirmed independently:** the worst 14 closes sum to **−1.238 ◎** vs
  **+0.895 ◎** from all 132 winners combined. Tail control is the difference between a losing
  and winning book at this stage.
- Micro-cap (<$300k) entries skew toxic (n=15, mean −2.47%), and a velocity-based crash exit is
  the right class of mitigation for the sub-2h −20% disasters (ANSEM 0.6h −22.5%, Meepcat 0.8h
  −22.4%, Chaton 0.4h −21.2%, bully 1.7h −22.7%).

## 3. What it missed

### 3a. The era confound (the big one)
The dataset spans a system that was rebuilt mid-window (outcome-aware evolution, threshold
ratchets, stop-loss −30, OOR-below 180→60, wider ranges, trailing TP — all landed ~Jun 19–30):

| Era | n | mean PnL% | sum SOL | losses ≤−5% |
|---|---|---|---|---|
| early (Jun 5–26) | 145 | −0.54% | **−0.377 ◎** | **13** |
| late (Jun 27+) | 36 | +0.41% | **+0.028 ◎** | **1** |

**13 of the 14 tail losses predate Jun 27.** The system that produced the fat tail no longer
exists; proposals tuned against the pooled window re-fight a won battle.

### 3b. The "45–60% depth is toxic" signal is an early-era artifact
Early era: n=54 at 45–60% depth → −0.554 ◎ (6 tail losses). Late era: n=4 → +0.002 ◎ (0).
The live config (`minBinsBelow=69 / maxBinsBelow=120`) already deploys 60–75%+ ranges almost
exclusively — the data endorses what production already does.

### 3c. Micro-caps are already excluded
`<$300k` entries in the late era: **n=0**. The `minMcap=500k` + evolved floors
(`minFeeActiveTvlRatio` 0.05→**0.41**, `minOrganic` 60→**80**, `minTvl` 10k→**50k**) shut that
door weeks ago.

### 3d. Statistical hygiene
The plan's BEST/AVOID clusters have n=3–14 (a "100% win rate" on n=3 is noise), and its 🎯 NEXT
recommendation extrapolates from **two** trades. None of it is decision-grade.

### 3e. The metric mirage — and the actual current problem
"72.9% win rate, structurally very strong" is the pnl-sign vanity metric this repo already
retired (see CLAUDE.md, Lessons System). Outcome-aware classes on this dataset:
**success ≈ 29% (53) · failure 14 · neutral 114**. The median "win" is **+0.17%**.

**The live problem is not the tail (fixed) — it's break-even churn:** 114 of 181 closes were
fee-deaths that earned ~nothing while paying gas + exit slippage every round trip. That is
where the next unit of tuning effort pays.

## 4. Refined actions

| # | Action | Decision | Mechanism |
|---|---|---|---|
| **A1** | `minMcap` 300k | **REJECT** — keep 500k (proposal would loosen). | none |
| **A2** | Crash fast-path | **Keep ON** (already live; reverting churns config). But it skipped shadow calibration, so impose the calibration criteria *post-hoc*: any `rule crash` close whose post-close probe scores `early_exit` in week 1 → `update_config crashFastPathEnabled=false`, raise `crashBinsPerMin` 12→18, re-enable after 3 clean shadow days. Watch: Telegram close notifications with reason `crash-below …` + `/exits` crash family. | `/setcfg` if triggered |
| **A3** | `outOfRangeWaitMinutesBelow` 60→45 | **DEFER ~1 week** — decide from `/exits` once ≥10 probed `oor_below` closes exist: `selling bottoms` flag (early≫good) → **RAISE** toward 90; good≫early → lower toward 45. The probe machinery (plan #05) shipped today and produces exactly this evidence. | `/setcfg` after evidence |
| **A4** | **Fee-death churn** (new) | Attack the 114-neutral-close problem: after one week of friction data (gas via `total_gas_sol` + exit slippage via `exit_swap.slippage_usd`, both captured since Jun 22/Jul 5), compute avg friction per close. If friction × churn is material (est. −0.1…−0.3 ◎/month), raise `minFeePerTvl24h` 1.0→1.5 and/or shorten `minAgeBeforeYieldCheck` 180→120 so yield-dead positions exit sooner AND fewer marginal pools get deployed (higher `minFeeActiveTvlRatio` is evolution's job — leave it). One knob at a time, one week apart. | measure → `/setcfg` |
| **A5** | Depth/fee-yield experiment (new, deferred) | 25–45% ranges earned **3.63%** fees/deposit vs **2.22%** at 60–75% — narrower is ~60% more capital-efficient *when it survives*. Once A2 is proven (crash path catches the dumps) and A3 is settled, trial `maxBinsBelow` 120→90 on a minority of deploys and compare probe-scored outcomes. Not before. | future plan |

## 5. Sequencing

```
now        A1 reject (no-op) · A2 monitoring active (uses /exits + crash-close notifications)
+3 days    first A2 checkpoint: any crash-rule close scored early_exit? → disable + retune
+7 days    A3 decision from /exits oor_below family (n≥10)
+7 days    A4 friction measurement → first churn knob
+2–4 wks   A5 depth experiment, only after A2/A3 hold
```

## 6. Meta-lesson for future agent-generated plans

Any plan proposing config changes must first read the **live** `/opt/meridian/user-config.json`
(not `config.js` defaults, not a stale local copy), state the dataset's time window against the
system's change log, and respect minimum sample sizes (n≥15 per cluster before acting). The
Antigravity monitor should also **log every config key it changes** — the 16:02 crash-flag
enable was only reconstructable from file mtime + PM2 restart count.
