# Plan 02 — Tight / Balanced / Wide playstyle modes

**Edge copied:** yunus's *"playstyle, apakah tight atau wide"* — range width as a deliberate,
switchable strategy axis rather than one fixed curve. In his fleet, `degen` vs `stable` are
largely *the same agent with different width/aggression presets*. This plan makes width a
first-class mode in our single agent (and is the per-archetype seam if we ever do the fleet).

---

## Current state (verified)

Range width is a **single volatility curve**, hardcoded and **duplicated in three places**:

1. **Prompt (general/screener role)** — [prompt.js:152-155](../../prompt.js):
   ```
   bins_below = round(minBinsBelow + (candidate volatility/5)*(maxBinsBelow - minBinsBelow))
                clamped to [minBinsBelow, maxBinsBelow]
   ```
   (or, if `targetDownsidePct` is set, the prompt tells the LLM to omit `bins_below`.)
2. **Screener STEPS block** — [index.js:951](../../index.js): the *same* formula text, built
   independently. **Both must change together** or the prompt and the cycle goal diverge.
3. **Execution fallback/clamp** — [dlmm.js:783-804](../../tools/dlmm.js): when the LLM doesn't
   pass `bins_below`, dlmm computes it (`targetDownsidePct` path or `defaultBinsBelow`) and
   clamps to `[minBinsBelow, maxBinsBelow]`.

Config source ([config.js:29-39](../../config.js) → [config.js:251-259](../../config.js)):
`strategyMinBinsBelow / strategyMaxBinsBelow / strategyDefaultBinsBelow` are derived from
`u.minBinsBelow / u.maxBinsBelow / u.defaultBinsBelow`, all clamped so min ≥
`MIN_SAFE_BINS_BELOW` (35). The `update_config` tool can already mutate `minBinsBelow`
([config.js:461](../../config.js)).

So tight-vs-wide is **not** a mode today — but the infra is ~95% there. We're adding a named
preset that *feeds the existing min/max*, not a new code path.

---

## Design

Add a `playstyle` setting that resolves to `(minBinsBelow, maxBinsBelow)` presets, with
explicit user overrides still winning.

### 1. Preset table + resolution — `config.js`

Near the bins setup ([config.js:29](../../config.js)), before `strategyMinBinsBelow`:

```js
const PLAYSTYLE_PRESETS = {
  tight:    { min: 35, max: 45 },   // concentrated; max fee capture, higher OOR risk
  balanced: { min: 45, max: 69 },   // current default behavior
  wide:     { min: 60, max: 110 },  // survives volatility; lower fee density
};
const playstyle = ["tight","balanced","wide"].includes(u.playstyle) ? u.playstyle : "balanced";
const preset = PLAYSTYLE_PRESETS[playstyle];

// Explicit user values override the preset; preset overrides the old hardcoded fallback.
const configuredMinBinsBelow = numericConfig(u.minBinsBelow) ?? preset.min;
const configuredMaxBinsBelow = numericConfig(u.maxBinsBelow)
  ?? (legacyBinsBelow != null ? Math.max(legacyBinsBelow, configuredMinBinsBelow) : preset.max);
```

Keep the existing `Math.max(MIN_SAFE_BINS_BELOW, …)` clamps — they already protect the 35
floor, so a `tight` preset is safe. Expose `playstyle` on the `config.strategy` object
([config.js:252](../../config.js)) so prompts and tools can read the active mode name.

### 2. Prompt — surface the mode, keep the formula derived

In both [prompt.js:154](../../prompt.js) and [index.js:951](../../index.js), the formula
already interpolates `config.strategy.minBinsBelow/maxBinsBelow`, so the numbers update for
free once the preset feeds them. Add a one-line label so the LLM knows the intent:

```
- playstyle = ${config.strategy.playstyle} → bins range [${min}, ${max}].
  bins_below = round(${min} + (candidate volatility/5)*(${max-min})) clamped to [${min},${max}]. bins_above = 0.
```

No change to `dlmm.js` logic — it reads the same `config.strategy.min/maxBinsBelow` and stays
the clamp of record. (Verify the `defaultBinsBelow` fallback still sits inside the new range.)

### 3. Runtime switching — `update_config`

`update_config` already persists arbitrary keys to `user-config.json` and reloads screening
thresholds ([config.js:406](../../config.js)). Add `playstyle` to its accepted-keys list and,
on change, re-resolve `min/max` from the preset (unless the user also passed explicit
min/max). Then the agent (or you, via Telegram) can do `update_config strategy.playstyle=wide`
and the next deploy uses it. Document `playstyle` in the CLAUDE.md config table.

---

## How this pairs with the other plans

- **With #3 (LPAgent signal):** the study returns `suggested_style` and `preferred_range_styles`
  for the winning LPers on a pool. Phase 2 of this plan can let the screener pick `tight` vs
  `wide` *per deploy* to match what's actually winning on that specific pool, instead of one
  global mode. (Mechanism: allow `deploy_position` to accept an explicit `bins_below` derived
  from the recommended style — it already does — and have the prompt prefer the LPAgent
  `suggested_style` when present and confident.)
- **As the fleet seam (deferred):** `degen` = `wide` + loose floors + high-vol tolerance;
  `stable` = `tight` + strict floors. Each archetype is then just a `user-config.json` with a
  different `playstyle` + threshold set — no code fork.

---

## Risks / caveats

- **`wide` max above 69** crosses the gas/efficiency heuristic at
  [index.js:777](../../index.js) (`isWide = _binCount > 69` → higher estimated cycle gas). That's
  *correct* (wide really is more expensive) but means wide deploys face a stiffer gas
  break-even filter ([index.js:774](../../index.js)) — confirm wide candidates still survive it,
  or widen `maxGasBreakEvenMinutes` for the wide preset.
- **`tight` raises OOR risk.** The OOR cooldown machinery in `pool-memory.js`
  ([pool-memory.js:205](../../pool-memory.js)) will kick in more often; expected, not a bug, but
  watch the OOR-close rate after switching to tight.
- **Don't let `evolveThresholds` and playstyle fight.** Evolution tunes *candidate-quality
  floors* (`minOrganic`, `minFeeActiveTvlRatio`, `minIntelScore`), not bins — so they're
  orthogonal today. Keep it that way: playstyle owns width, evolution owns quality floors.

---

## Validation

- Unit-check: for each preset, assert resolved `[min,max]` and that `min ≥ 35`.
- Dry-run a screening cycle per preset (`DRY_RUN=1`) and confirm the prompt formula text and
  the `simLine` (`formatPoolSimLine`, [index.js:868](../../index.js)) reflect the new bounds.
- A/B over time: run `tight` for a window, `wide` for a window, compare `classifyOutcome`
  success-rate and OOR-rate. This is the data that later justifies per-pool style selection.

## Effort

~2–3 hours (config presets + two prompt edits + `update_config` allow-list + CLAUDE.md table).
