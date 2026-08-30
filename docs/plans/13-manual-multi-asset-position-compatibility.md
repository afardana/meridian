# Meridian Plan #13 — Manual and Multi-Asset Position Compatibility

**Status:** Must-have implementation ready for `experimental` canary; nice-to-haves deferred.

## 1. Motivation and incident summary

A manually opened SOL/USDC Meteora position was adopted as `SOL-SOL`, then closed almost immediately by the take-profit path. The management cycle reported a peak PnL of approximately `+1181%`, while the authoritative closed-position data showed approximately `-0.006%` SOL PnL and `$0.21` USD PnL.

The incident is reproducible from the recorded data:

- Position: `EKJpWWXT…` in pool `5rCf1DM8…`.
- Adoption occurred at approximately `21:07:28` local VM time.
- The first enriched sample arrived shortly after adoption and identified the pool as `SOL-USDC`.
- The PnL poll then interpreted the USDC leg as if it were SOL, producing the false `+1181%` peak.
- The take-profit rule acted on that invalid sample within seconds.
- The close transaction itself succeeded. The close was therefore a decision-quality and valuation problem, not a transaction-submission problem.

The authoritative Meteora result was approximately:

| Field | Value |
| --- | ---: |
| Deposited | `1.0000885 SOL` equivalent |
| Withdrawn | `0.9999877 SOL` equivalent |
| USD PnL | `+$0.2062` |
| SOL PnL | `-0.000060 SOL` |
| SOL PnL percentage | `-0.0060%` |
| USD PnL percentage | `+0.1930%` |

The immediate objective is to make manually adopted and multi-asset positions observable and safely manageable without changing the established behavior for Meridian's normal SOL-sided deployments.

## 2. Scope

### Goals

1. Value both legs of a position using their actual mints, decimals, symbols, and current prices.
2. Preserve correct asset identity through adoption, enrichment, persistence, Telegram output, dashboard data, and close history.
3. Prevent TP, SL, trailing, OOR, and related automatic exits when the PnL sample is incomplete, stale, or demonstrably invalid.
4. Allow a newly adopted position to become managed only after its asset metadata and valuation are validated.
5. Keep explicit operator actions such as `/close <n>` available, subject to the existing operator-override safety boundary.
6. Add regression fixtures for SOL/USDC and other non-SOL quote combinations.

### Non-goals

- Changing the bot's normal deployment strategy from SOL-sided Meteora positions.
- Introducing a new paid RPC or price provider at this stage.
- Rewriting authoritative closed-position history destructively.
- Broadly redesigning the dashboard or Telegram message layout unless a small data-contract change is required.
- Replacing the existing HOLD behavior; the refactor must preserve and strengthen it.

## 3. Current architecture and root gaps

### Gap A — the valuation pipeline assumes token Y is SOL

`tools/pnl.js` currently obtains the price for the base/token-X mint, but computes the second leg with `solUsd`:

```text
balancesUsd = xHuman * priceX + yHuman * solUsd
claimableUsd = feeXHuman * priceX + feeYHuman * solUsd
```

That is valid only for the bot's normal SOL-sided orientation. It is invalid for SOL/USDC, stablecoin/stablecoin, USDC/SOL, and any other manually created pool where token Y is not SOL. The incident's USDC amount was therefore added as if it were an amount of SOL.

### Gap B — adoption identity is incomplete and asynchronous

The adoption path persists a pair name derived from the initial position representation before enrichment has necessarily resolved authoritative pool metadata. It can therefore persist `SOL-SOL`, and the later enrichment log can know `SOL-USDC` without repairing the already tracked identity or supplying the missing token-Y mint to the PnL engine.

The current persisted position shape is centered on the bot's SOL-sided deployment model. It does not yet provide a durable per-leg asset profile containing both mints, decimals, symbols, and valuation status.

### Gap C — PnL divergence is telemetry, not a safety gate

The local PnL engine compares local results with Meteora-reported PnL, but the divergence is currently informational. A large disagreement can remain actionable, so the false `+1181%` value reached the take-profit path.

The system needs a quality state for each PnL sample, with automatic exits allowed only when the sample passes the quality checks.

### Gap D — adoption grace protects only selected paths

The existing adoption grace period primarily prevents low-yield behavior. It does not universally prevent TP, SL, trailing, ratchet, OOR, crash/rug, flip, health-review, or LLM-driven closes while the first post-adoption valuation is still being established.

### Gap E — manual positions exceed the bot's deployment assumptions

Normal bot deployment creates a single-sided SOL position. A manually opened position can have arbitrary token orientation, both legs populated, different decimals, and a different quote asset. Other code paths—including fee conversion, pair formatting, history labels, and analytics—may still infer behavior from `pool_name`, `base_mint`, or a SOL-mode flag.

## 4. Proposed refactor

### Phase A — introduce an asset-aware valuation pipeline

1. Extend the flattened position input to carry both legs explicitly:
   - `tokenXMint`, `tokenYMint`
   - `decX`, `decY`
   - `symbolX`, `symbolY`
   - token orientation as supplied by the authoritative pool/position source.
2. Request prices for both token mints, deduplicating SOL and any repeated mint.
3. Compute each leg in human units, then convert:
   - each leg to USD using its own price;
   - total USD to SOL using the current SOL/USD price;
   - claimable fees using the same two-leg conversion.
4. Remove the implicit `tokenY → SOL` fallback from the multi-asset path. A missing token-Y price must produce an explicitly unvalued/unsafe sample, not a guessed SOL value.
5. Retain the existing SOL-mode behavior as a compatibility path only where the position's asset profile explicitly confirms SOL as the quote leg.
6. Centralize the conversion logic so the live PnL, fee display, Telegram messages, and dashboard data cannot silently use different formulas.
7. Record price freshness and valuation source for diagnostics without exposing API keys or sensitive configuration.

### Phase B — make adoption identity authoritative and repairable

1. Resolve pool metadata and position asset identity before calling `trackPosition` where possible.
2. Persist an `assetProfile` (or equivalent stable shape) with both mints, decimals, symbols, and the source/last-validated timestamp.
3. Make adoption enrichment idempotent and allowed to repair an incomplete or incorrect provisional identity, including historical provisional values such as `SOL-SOL`.
4. Separate these states:
   - `observed`: position exists on-chain;
   - `adopted`: position is persisted locally;
   - `valuation_ready`: both legs and prices are usable;
   - `management_armed`: automatic exits are allowed.
5. Establish the PnL baseline only after a valid asset-aware valuation sample. Preserve the existing baseline semantics for supported positions, but do not baseline an invalid or guessed valuation.
6. Ensure subsequent reads use the persisted asset profile instead of re-deriving the pair from a display string.

### Phase C — add exit-safety gates around sample quality

1. Add structured PnL quality states such as:
   - `valid`;
   - `adoption_pending`;
   - `missing_asset_metadata`;
   - `missing_price`;
   - `stale_price`;
   - `extreme_divergence`;
   - `invalid_decimals`.
2. Block automatic exits for a position whose current sample is not `valid`.
3. Add a narrow extreme-divergence guard so a large local-vs-authoritative disagreement cannot trigger an exit. The threshold must be chosen from observed noise, not from the incident's extreme value alone.
4. Require a configurable number of consecutive valid post-adoption samples before arming TP, trailing TP, and ratchets. Decide separately whether a validated SL may arm earlier; the default recommendation is to keep all automatic exits disarmed until valuation is valid and stable.
5. Keep explicit operator close actions available and preserve the current central HOLD guards. A position on HOLD must remain protected from automatic exits even when valuation is valid.
6. Make automatic-management decisions log the quality state, asset pair, valuation source, and suppression reason so an incident can be reconstructed from logs.

### Phase D — regression tests and incident replay

Add unit and integration coverage for:

- SOL/SOL, the existing normal path;
- SOL/meme and meme/SOL orientations;
- SOL/USDC, including the exact incident amounts;
- USDC/SOL;
- stablecoin/stablecoin;
- a token-Y price that is unavailable or stale;
- token decimals that differ between legs;
- a provisional `SOL-SOL` adoption record repaired to `SOL-USDC`;
- adoption followed by an invalid first sample;
- two valid samples followed by a normal TP decision;
- HOLD plus valid PnL, confirming automatic close remains blocked;
- explicit `/close <n>`, confirming the operator path remains available.

The exact incident replay must show:

- pair identity `SOL-USDC`;
- correct two-leg value and PnL within a documented tolerance of authoritative Meteora data;
- no false `+1181%` peak;
- no automatic TP close during the invalid/adoption-pending window.

### Phase E — staged rollout

1. Run the complete test suite and a deterministic replay locally.
2. Add shadow telemetry for asset-aware versus legacy valuation where both can be computed safely; do not let shadow output make trading decisions.
3. Deploy to the `experimental` branch only after the test/replay criteria pass.
4. Back up relevant runtime state and confirm the live checkout is still `/opt/meridian` on `experimental` before updating.
5. Pull with `git pull --ff-only origin experimental` and restart only the affected `meridian` PM2 process.
6. Observe at least one discovery cycle, one management cycle, adoption events, and any manual-position reconciliation before considering the change complete.
7. Roll back with a targeted revert if startup, valuation, or management telemetry is abnormal. Do not delete or rewrite authoritative history as part of rollback.

## 5. Technical decisions to settle before implementation

| Decision | Recommended direction | Reason |
| --- | --- | --- |
| Price source hierarchy | Existing Jupiter price path for both legs; stablecoin price only when explicitly returned or safely configured; Meteora data for cross-check | Avoid new paid dependencies while removing the SOL assumption |
| Pool identity precedence | Authoritative on-chain/Meteora pool metadata, then persisted asset profile, then display-only fallback | A display pair must not determine valuation |
| Unknown/unpriceable position | Show and reconcile it, but keep it observe-only until `valuation_ready` | Visibility is safer than forced closure or silent omission |
| Post-adoption arming | Require asset metadata plus at least two consecutive valid samples | Prevents one transient or misoriented sample from arming exits |
| Divergence threshold | Configurable, telemetry-backed, and only an additional guard—not the primary valuation method | Normal USD/SOL PnL differences are legitimate; extreme mismatch is not |
| Historical correction | Preserve authoritative realized numbers; repair labels/metadata only through an auditable migration | Avoids falsifying financial history |
| Stablecoin treatment | Use live price when available and record the source; do not hard-code all stablecoins to exactly `$1` without an explicit policy | Handles depegs and avoids hidden assumptions |

## 6. Known gaps to close

- Current test fixtures do not cover a non-SOL token-Y position.
- The Meteora PnL row used by the current fetch path does not reliably provide token symbols, so symbols must come from pool metadata or a mint cache.
- It still needs to be confirmed that the current Jupiter price path reliably returns both SOL and USDC for every required runtime request and handles missing assets predictably.
- Token-2022 metadata, decimals, and pool orientation need explicit verification in the SDK/API response used by adoption.
- There is no stable per-position asset-profile schema yet.
- Some display and analytics paths may still infer meaning from `pool_name`, `base_mint`, or SOL-mode fields.
- Fee claiming and auto-swap paths need review for non-SOL fee assets so the valuation fix does not leave a second unprotected assumption.
- Existing closed history may contain a false `SOL-SOL` label and inflated peak lesson. The repair policy should preserve authoritative realized PnL while clearly marking corrected metadata.
- Live telemetry needs a baseline for valuation latency, price freshness, and the number of positions held in observe-only mode.
- Any configuration added for arming or divergence must be persisted in the existing Settings/config workflow, not only in an inherited shell environment.

## 7. Opportunities for improvement (OFIs)

- Define one reusable `AssetProfile` and one reusable `ValuationResult` contract shared by state, PnL, Telegram, and dashboard serializers.
- Include `valuationBasis`, `priceSources`, `sampleAgeMs`, and `quality` in structured diagnostics.
- Add invariants such as “sum of valued legs equals total value within tolerance” and “no unknown leg is reported as SOL.”
- Add bounded price caching and request deduplication so both-leg valuation does not multiply RPC/API usage unnecessarily.
- Make logs identify whether a value is measured, estimated, adopted-baseline, or authoritative reconciliation.
- Surface a concise read-only health state for observe-only positions in the dashboard and Telegram without giving the LLM an implicit authority to close them.
- Add an incident counter/metric for suppressed automatic exits and extreme divergence so operations can distinguish a safe guard from a broken data path.
- Add a repair command or dry-run report that lists positions with provisional pair names, missing mints, stale prices, or unsafe valuation.
- Document the data-contract boundary between on-chain reconciliation and trading decisions: reconciliation may mark an absent position closed, but must not be interpreted as an automatic exit request.

## 8. Nice-to-haves

- Operator controls to explicitly mark a position `observe-only` or `enable management` after review.
- Dashboard and Telegram display of both asset legs, including amounts and USD values, for manually adopted positions.
- Full support for stablecoin/stablecoin and non-SOL quote pools as first-class managed position types.
- Per-position controls for disabling only selected automatic actions while retaining fee claims and monitoring.
- An auditable historical metadata migration for old `SOL-SOL` adoption labels.
- Optional future oracle fallback such as Pyth or Switchboard if the cost, latency, and operational ownership are approved; this is intentionally not part of the initial change.
- A targeted alert when an adopted position remains unvalidated beyond the configured window or when local and authoritative PnL diverge beyond the safety threshold.
- A replay tool that consumes an on-chain position snapshot and emits the exact management decisions that would have been made under each valuation version.

## 9. Acceptance criteria

The implementation is ready for canary deployment only when all of the following are true:

1. The exact SOL/USDC incident replays as `SOL-USDC`, with two-leg valuation and PnL close to authoritative Meteora values.
2. The incident cannot generate an extreme false peak or automatic TP close during adoption/validation.
3. No code path defaults an unknown token-Y leg to SOL in the multi-asset path.
4. Normal SOL-sided bot positions retain their existing behavior and pass regression tests.
5. An unknown or unpriceable manual position remains visible and observe-only, with an actionable diagnostic.
6. Explicit `/close <n>` still works and is aligned with the canonical Telegram position ordering.
7. HOLD continues to block all automatic exits while allowing fee claims and explicit operator actions.
8. Fee assets and auto-swap paths have either been made asset-aware or are explicitly blocked with a visible reason.
9. Startup smoke checks, management-cycle logs, and live process health are normal after the canary restart.
10. RPC/API request volume and latency do not regress materially without an explained cause.

## 10. Likely implementation surface

Primary files to inspect and update during implementation:

- `tools/pnl.js` — two-leg pricing, conversion, sample quality, divergence handling.
- `tools/dlmm.js` — authoritative pool/position metadata and any secondary PnL path.
- `state.js` — adopted asset profile, baseline, management arming, and repair persistence.
- `index.js` — adoption enrichment, polling, management-cycle gating, and telemetry.
- `tools/executor.js` — preserve the central automatic/manual close boundary.
- `cli.js` and Telegram formatters — operator close behavior and clear observe-only diagnostics.
- Existing test files and fixtures — deterministic non-SOL position coverage and replay.
- `AGENTS.md`/`CLAUDE.md` — document the finalized asset-profile and safety invariants after implementation, not speculative runtime values.

## 11. Suggested build order

1. Add asset-profile types/helpers and test fixtures without changing live decisions.
2. Refactor valuation to use both mints and add the exact incident replay.
3. Persist/repair adoption identity and baseline only after valid valuation.
4. Add quality states and automatic-exit gates, including the post-adoption arming window.
5. Audit fee claiming, auto-swap, Telegram, dashboard, and history serializers for SOL assumptions.
6. Run tests, replay historical cases, and inspect request/latency telemetry.
7. Canary on `experimental`, restart only `meridian`, and observe before any wider rollout.

## 12. Rollback and operational safeguards

- Keep the current branch and live checkout on `experimental`.
- Preserve unrelated local and VM changes; do not force-reset or overwrite runtime state.
- Back up any modified runtime configuration before canary deployment.
- Revert only the refactor commits if startup or decision telemetry regresses.
- Leave authoritative on-chain and PostgreSQL history intact during rollback.
- If a position cannot be valued safely, prefer visible observe-only status and an operator diagnostic over an automatic close.
