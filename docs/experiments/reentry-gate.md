---
id: reentry-gate
config_key: reentryGateMode
status: closed: dropped 2026-11-23
mode: shadow
registered_at: 2026-10-02
enforce_built: true
---

# Post-win cooling gate (re-entry 60–240 min after a win)

## Claim
A bot re-entry into a pool 60–240 min after a close there of ≥ +1 % is a disaster bucket.

## Evidence at registration (CLAUDE.md, 2026-10-02)
Bot deploys since 08-22 by the pool's previous close: re-entry 60–240 min after a win = 27
deploys, 7 at ≤ −10 % (26 % vs 7.9 % for the other 267), avg −4.9 %, in each of three
sub-periods. Found after ~20 cuts of the same data, matched by pair name — a hypothesis.

## Pass rule
Verbatim (CLAUDE.md, Post-win cooling gate, 2026-10-02):
> after 20 tagged closes or three weeks, enforce only if the tagged group's ≤ −10 % rate is ≥ 2× the rest's AND its net is negative; otherwise drop.

Encoding:
- population: bot deploys (not `adopted`, not a rebalance leg) carrying `reentry_gate_would_skip`
  (key present); tagged = `true`, rest = `false`; `null` (no previous close known) in neither.
- threshold: tagged ≥ 20 OR ≥ 21 days since 2026-10-02.
- check 1: tagged rate(pnl_pct ≤ −10) ≥ 2 × rest rate, and tagged rate > 0.
- check 2: Σ `pnl_sol_net` (fallback `pnl_sol`) of the tagged < 0.
- threshold reached and a check fails → `drop`.

## Revert rule
Entry gate: not gradable from records once enforced (the blocked deploys never happen); needs
the rejected-candidates counterfactual.

## Grading log

### 2026-11-23 (export of 1,455 records, `--now 2026-11-23T01:20:00Z`) — **drop**
- sample: 21 tagged, 326 rest (349 bot carrying, 2 null verdict; 153 operator records carry the
  field, none tagged). Shadow 52.1 days. Last bot close in the export 2026-11-13.
- check 1 FAIL: tagged 1/21 = 4.8 % vs rest 36/326 = 11.0 % → ratio 0.43 (need ≥ 2).
- check 2 FAIL: tagged Σ net ◎+1.6356 (12 winners of 21, mean pnl +4.41 %).
- context: 90 % CI tagged Σ net ◎−0.68 … ◎+5.31; disaster-ratio CI 0 … 1.33.
- robust (without CRAWL-SOL 69F2FsPS, +66.4 %, ◎+1.8595 — a 2.84 SOL bot deploy closed
  manually after 3.7 days, held by the operator through the run per CLAUDE.md): ratio 0.45 FAIL,
  Σ net ◎−0.2239 PASS. The net check hangs on that one record; the ratio check does not.
- decision point 2026-10-23 (three weeks, 19 tagged): ratio 0.51 FAIL, Σ ◎+1.568 FAIL — same verdict.
- action: set `reentryGateMode=off`.
