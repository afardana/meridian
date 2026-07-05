# Plan 04 — Price-Crash Fast-Path

**Status:** IMPLEMENTED 2026-07-05 (shipped OFF — shadow mode active: detector always runs,
would-fire events logged as `crash_shadow` while `crashFastPathEnabled=false`; zero closes).
Phase 1 of the §7 rollout is therefore live from merge. Enable per §7 Phase 2/3.
**Author:** design pass, 2026-07-05. Implemented same day; detector gate logic verified against
the §3 worked examples (crash fires @20 b/min; drift/flicker/upside/spike/static all correctly no-fire).
**Scope:** one new deterministic detector hooked into the existing PnL poller tick; reuses the
existing mechanical-close path. No new tools, no new external API calls on the hot path.

---

## 1. Problem statement + latency math

When a meme token crashes straight *through the bottom* of a `bid_ask` position's range, the
current worst-case time from "price left the range" to "position closed" is dominated by
`outOfRangeWaitMinutesBelow`.

### Existing safety nets (and why each lags a fast crash)

| Net | Where | Trigger | Lag on a fast crash-below |
|-----|-------|---------|----------------------------|
| PnL poller stop-loss | `index.js` ~1229–1284 → `updatePnlAndCheckExits` (`state.js` 727) | `pnl_pct <= stopLossPct` (prod `-30`/`-50`) | **Lags price.** In a one-sided `bid_ask` deploy most of the value is quote (SOL); as the token dumps, the position converts to the *falling* base token. `pnl_pct` is computed off `total_value_usd`, which for a below-range position is now mostly worthless base — but the poller must wait for `total_value_usd` to have *already* fallen 30%. Price is the leading indicator; PnL is the trailing one. |
| Distance close (rule 4/`outOfRangeBinsToClose`) | `getDeterministicCloseRule` (`index.js` 1494–1524) | `active_bin > upper_bin + outOfRangeBinsToClose` | **Above-only.** The distance-based immediate close (rule 3, `outOfRangeBinsToClose`) is only wired for the *above* direction. Below-range has no distance rule — it falls through to the time-based `outOfRangeWaitMinutesBelow`. |
| Time close (rule 4 below) | `getDeterministicCloseRule` (`index.js` 1515–1524) | `minutes_out_of_range >= outOfRangeWaitMinutesBelow` | **This is the bottleneck.** Prod `outOfRangeWaitMinutesBelow` is long (`config.js` default 180; audit cites prod `60`) because a below-range meme often wicks back, and closing on every wick realizes base-token losses + swap slippage. |
| tvlDrain | `config.js` 143–144 (`tvlDrainThresholdPct -30`) | pool TVL drop | Detects *pool* death, not *our* price exit; also lags. |
| WebSocket active-bin monitor | `tools/socket-monitor.js` | active bin crosses range edge | **Detects but does not act.** On OOR it calls `markOutOfRange` + drops a `.force-sync` file, which only triggers a *normal* management cycle — still gated by `outOfRangeWaitMinutesBelow`. |

### Latency today (prod config: mgmt 3m, `outOfRangeWaitMinutesBelow` 60m)

```
t=0      price crashes through lower_bin
t≈0-3s   socket monitor / PnL poll marks OOR, sets out_of_range_since
t=0..60m  time-based rule not yet satisfied; PnL rule only if value already -30%
t=60m    outOfRangeWaitMinutesBelow satisfied → rule 4 returns CLOSE
t=60-63m next management/PnL evaluation actually executes the close
─────────
worst case ≈ 63–66 min after the crash began
```

During those minutes a hard rug keeps converting SOL → a token trending to zero. The realized
loss on a genuine crash is far worse than the wick-protection benefit `outOfRangeWaitMinutesBelow`
was tuned for.

### Latency *with* the fast-path (proposed)

```
t=0      price crashes through lower_bin
t=0..3s  PnL poll tick observes active_bin dropping ≥ crashBinsPerMin, OOR-below
t=+K·3s  K=crashConfirmTicks (default 3) consecutive confirming ticks ≈ 9s
t=+9s    detector fires → CLOSE scheduled via existing mechanical path (same tick)
─────────
worst case ≈ 10–15 s after the crash is detectable
```

Reduction: **~63 min → ~15 s** on a genuine crash, while leaving the slow
`outOfRangeWaitMinutesBelow` path intact for ordinary drift/wicks (the fast-path only fires on
*velocity*, not on mere OOR duration).

---

## 2. Detector design

### Placement

The detector is a **new pure function** `detectPriceCrash(position, tick, crashCfg, now)` that lives
next to the other exit helpers (proposed: `index.js`, near `isPriceStable` ~123, or a small new
module `crash-detector.js` imported by `index.js`). It is called from the **existing PnL poller
loop** in `index.js` (~1253–1265), one call per position per tick, *before* the existing
`registerExitSignal` confirmation gate — so it feeds the *same* confirm-tick machinery and the
*same* mechanical close as every other exit. It runs on the 3s cadence (`config.pnl.pollIntervalSec`).

Why the PnL poller and not the socket monitor:
- The poller already has the full enriched tick (`active_bin`, `lower_bin`, `upper_bin`, `bin_step`,
  `in_range`, `pnl_pct`) from `getMyPositions({force:true})` — no new fetch.
- The poller already owns the close lock (`_managementBusy`) and the confirm-tick gate; reusing it
  means zero new concurrency surface (see §6, Race Condition).
- The socket monitor fires on `onAccountChange` at irregular cadence and has *no* PnL/enriched
  tick — it stays as-is (detect-and-mark only). We can optionally raise its urgency later, but the
  poller is the correct hot path for a deterministic velocity measure.

### State: a small per-position bin-velocity ring buffer

The detector needs a short history of `(timestamp, active_bin)` to compute velocity. This is
**in-process only** (like `_recentActiveBins` for `isPriceStable`, `index.js` 116) — never persisted,
so a detector error can never corrupt `state.json`/Postgres.

```
const _binTrail = new Map(); // position_address -> [{ t: ms, bin: number }, ...]
```

### Pseudo-code

```js
// crashCfg = config.management crash* keys (see §4)
// tick     = the per-position object from getMyPositions (active_bin, lower_bin, bin_step, in_range)
// Returns { crash: true, reason } or null. NEVER throws (caller also wraps in try/catch).
function detectPriceCrash(position, tick, crashCfg, now = Date.now()) {
  if (!crashCfg.crashFastPathEnabled) return null;

  const activeBin = num(tick.active_bin);
  const lowerBin  = num(tick.lower_bin);
  if (activeBin == null || lowerBin == null) return null;

  // Maintain the trail regardless of range state (so we have history the moment it goes OOR).
  const trail = _binTrail.get(position) ?? [];
  trail.push({ t: now, bin: activeBin });
  // Keep only the last crashWindowSec seconds of samples (default 90s).
  const cutoff = now - crashCfg.crashWindowSec * 1000;
  while (trail.length && trail[0].t < cutoff) trail.shift();
  _binTrail.set(position, trail);

  // GATE 1 — must be OOR *below*. A crash fast-path only ever closes a downside break.
  //          Above-range is handled by the existing pump-stabilization logic; never fast-close up.
  if (!(activeBin < lowerBin)) return null;

  // GATE 2 — minimum distance already breached, so we don't fire on a 1-bin flicker at the edge.
  const distBelow = lowerBin - activeBin;
  if (distBelow < crashCfg.crashMinBinDistance) return null;

  // GATE 3 — velocity: bins/min of DOWNWARD travel over the trail window.
  //          Need at least 2 samples spanning >= crashMinSpanSec so a single burst can't spike it.
  if (trail.length < 2) return null;
  const first = trail[0], last = trail[trail.length - 1];
  const spanSec = (last.t - first.t) / 1000;
  if (spanSec < crashCfg.crashMinSpanSec) return null;      // not enough time base yet
  const binsDropped = first.bin - last.bin;                 // positive = price fell
  if (binsDropped <= 0) return null;                         // net upward/flat → not a crash
  const binsPerMin = binsDropped / (spanSec / 60);
  if (binsPerMin < crashCfg.crashBinsPerMin) return null;

  return {
    crash: true,
    reason: `crash-below: ${binsDropped} bins in ${spanSec.toFixed(0)}s ` +
            `(${binsPerMin.toFixed(1)} bins/min ≥ ${crashCfg.crashBinsPerMin}, ` +
            `dist ${distBelow} ≥ ${crashCfg.crashMinBinDistance})`,
  };
}
```

### Hook in the poller loop

The detector's result is fed into the **existing** `registerExitSignal` gate with a distinct
signal string (`CRASH_FASTPATH`) so it must still survive `crashConfirmTicks` consecutive
confirming polls before acting — matching the design philosophy already documented at
`index.js` 1223 ("a single noisy tick can't close a position"). On fire it routes to the *same*
`executeManagementActions(..., {action:"CLOSE", rule:"crash", reason})` used by every other
poller exit. The wait-minutes gate is bypassed **because we never touch `getDeterministicCloseRule`
for this** — the crash signal is produced independently and outranks the OOR-time rule.

See §5 for the exact diff.

---

## 3. Bin-velocity threshold analysis

### The bin math

For a DLMM pool, one bin is a fixed geometric price step: `price_ratio = (1 + bin_step/10000)`.

| bin_step | per-bin price move | 1% move = |
|----------|--------------------|-----------|
| 80       | 0.80%              | ~1.25 bins |
| 100      | 1.00%              | ~1.00 bin  |
| 125      | 1.25%              | ~0.80 bins |

Prod screening allows `binStep` 80–125 (`minBinStep`/`maxBinStep`). So **1 bin ≈ 0.8–1.25%
price**, and for the canonical `bin_step=100`, **1 bin ≈ 1% price move**.

### What normal chop looks like vs a crash

- **Routine volatility.** Screener `volatility` for accepted pools sits ~2–7 (the `bins_below`
  formula spans this). A pool with vol ~5 drifts a handful of bins over *minutes*, oscillating
  around the active bin. Even an aggressive but *healthy* meme rarely sustains a directional
  multi-bin-per-minute drop — it moves, wicks, and comes back.
- **A rug / crash.** Liquidity is pulled or a whale dumps: the active bin falls tens of bins in
  seconds. At `bin_step=100` a **-15% candle = ~15 bins**; a hard rug is -50%+ = **50+ bins**,
  often inside one or two blocks (<10s). The *rate* is the discriminator: a crash is
  **10–30+ bins/min sustained**, an order of magnitude above chop.

### Default justification

| Key | Default | Justification |
|-----|---------|---------------|
| `crashBinsPerMin` | **12** | At `bin_step=100`, 12 bins/min ≈ **12%/min sustained downside**. Healthy meme chop (vol 2–7) does not sustain 12%/min *directionally*; a rug easily does (a single -15% candle over ~75s already clears it). At `bin_step=80` this is ~9.6%/min (slightly more sensitive), at `bin_step=125` ~15%/min (slightly less) — all still far above routine chop. Chosen to sit ~2–3× above the worst realistic non-crash drift and well below rug velocity, giving a wide dead-band that both false-positives and slow-drift avoid. |
| `crashMinBinDistance` | **8** | The price must already be **≥8 bins below** the lower edge (≈6.4–10% below range) before we fire. This is the anti-flicker floor: a 1–3 bin dip at the edge (normal for a position whose lower edge sits near price) never qualifies. 8 bins is comfortably past the edge yet reached almost instantly in a real crash. |
| `crashConfirmTicks` | **3** | 3 consecutive confirming polls at 3s ≈ **9s** of sustained crash before acting. Reuses the existing `registerExitSignal` machinery. Long enough that a single anomalous RPC tick (stale/duplicate `active_bin`) cannot fire; short enough that we still close ~50× faster than the 60m time gate. |
| `crashWindowSec` | **90** | Trailing window over which velocity is measured. Long enough to hold ~30 samples at 3s cadence and smooth a single jumpy tick; short enough that an old, recovered dip ages out and doesn't contaminate a later measurement. |
| `crashMinSpanSec` | **9** | Require the trail to span ≥9s (≥3 samples) before trusting a velocity number, so the *very first* tick after subscription can't produce a divide-by-tiny-span spike. |

**Worked sanity check (bin_step=100, crash of -20% over 60s):** ~20 bins dropped in 60s =
**20 bins/min ≥ 12** ✓; within ~9s the position is ≥8 bins below the edge ✓ (a -20%/min slope
covers 8 bins ≈ 8% in ~24s, but the ≥8-bin distance gate and ≥12 bins/min velocity gate are both
cleared inside the 90s window well before the confirm ticks complete). Fires in ~9–15s.

**Worked non-fire (bin_step=100, healthy -4% drift over 3 min):** ~4 bins over 180s =
**~1.3 bins/min < 12** ✗ → never fires; falls through to normal OOR-time handling. Correct.

---

## 4. Config keys + defaults + config.js diff sketch

New keys live in the existing **`management`** section (they govern position management, mirroring
`outOfRangeWaitMinutesBelow`/`stopLossPct`). All flat keys in `user-config.json`, all tunable via
`update_config`, default **OFF**.

| Flat key (user-config.json / update_config) | config path | Default | Meaning |
|----------------------------------------------|-------------|---------|---------|
| `crashFastPathEnabled` | `management.crashFastPathEnabled` | `false` | Master switch. OFF = zero behavior change. |
| `crashBinsPerMin` | `management.crashBinsPerMin` | `12` | Min downward bins/min to qualify as a crash. |
| `crashMinBinDistance` | `management.crashMinBinDistance` | `8` | Min bins already below `lower_bin` before firing. |
| `crashConfirmTicks` | `management.crashConfirmTicks` | `3` | Consecutive confirming polls before closing. |
| `crashWindowSec` | `management.crashWindowSec` | `90` | Velocity measurement trailing window. |
| `crashMinSpanSec` | `management.crashMinSpanSec` | `9` | Min trail time-base before a velocity is trusted. |

### `config.js` diff sketch (inside the `management:` block, after line 268)

```diff
     poolHealthFeeRatioCollapsePct: u.poolHealthFeeRatioCollapsePct ?? 60,
+    // ── Price-crash fast-path (plan #04) — default OFF. Bypasses outOfRangeWaitMinutesBelow
+    //    ONLY when price is falling through the lower edge fast enough to be a rug/crash.
+    //    Fires via the PnL poller's existing confirm-tick + mechanical-close path.
+    crashFastPathEnabled:  u.crashFastPathEnabled  ?? false,
+    crashBinsPerMin:       u.crashBinsPerMin        ?? 12,   // min downward bins/min
+    crashMinBinDistance:   u.crashMinBinDistance    ?? 8,    // min bins below lower edge to arm
+    crashConfirmTicks:     u.crashConfirmTicks      ?? 3,    // consecutive confirming polls
+    crashWindowSec:        u.crashWindowSec         ?? 90,   // velocity trailing window (s)
+    crashMinSpanSec:       u.crashMinSpanSec        ?? 9,    // min trail span before trusting v (s)
   },
```

### `tools/executor.js` — CONFIG_MAP additions (after line 494, near the other `management` keys)

```diff
       outOfRangeWaitMinutesBelow: ["management", "outOfRangeWaitMinutesBelow"],
+      crashFastPathEnabled: ["management", "crashFastPathEnabled"],
+      crashBinsPerMin: ["management", "crashBinsPerMin"],
+      crashMinBinDistance: ["management", "crashMinBinDistance"],
+      crashConfirmTicks: ["management", "crashConfirmTicks"],
+      crashWindowSec: ["management", "crashWindowSec"],
+      crashMinSpanSec: ["management", "crashMinSpanSec"],
```

(The generic `update_config` apply loop at executor.js ~690 handles live-apply + persist for any
key already in `CONFIG_MAP`; no per-key wiring needed beyond the map entries. No cron restart is
required — these aren't interval keys.)

### CLAUDE.md docs

Add a `crash*` row group to the Config System table and a short paragraph under
"Screener Safety Checks" / a new "Price-Crash Fast-Path" note (docs-only; not counted in the patch
line budget).

---

## 5. Full patch sketch (file:line anchored)

Total added lines ≈ **70** (well under 120). No lines deleted; all additions are guarded by
`crashFastPathEnabled` so OFF = today's behavior byte-for-byte.

### Patch A — detector + trail buffer (`index.js`, insert after `clearPriceHistory` ~138)

```diff
 /** Clear price history for a closed position. */
 function clearPriceHistory(positionAddress) {
   _recentActiveBins.delete(positionAddress);
+  _binTrail.delete(positionAddress);
 }
+
+// ─── Price-crash fast-path (plan #04) ──────────────────────────
+// In-process only (like _recentActiveBins) — never persisted, so a detector fault
+// can never corrupt state. Pure + total: returns {crash,reason} | null, never throws.
+const _binTrail = new Map(); // position_address -> [{ t, bin }]
+
+function detectPriceCrash(position, tick, cfg, now = Date.now()) {
+  if (!cfg.crashFastPathEnabled) return null;
+  const activeBin = tick.active_bin != null ? Number(tick.active_bin) : null;
+  const lowerBin  = tick.lower_bin  != null ? Number(tick.lower_bin)  : null;
+  if (!Number.isFinite(activeBin) || !Number.isFinite(lowerBin)) return null;
+
+  const trail = _binTrail.get(position) ?? [];
+  trail.push({ t: now, bin: activeBin });
+  const cutoff = now - Number(cfg.crashWindowSec ?? 90) * 1000;
+  while (trail.length && trail[0].t < cutoff) trail.shift();
+  _binTrail.set(position, trail);
+
+  if (!(activeBin < lowerBin)) return null;                       // GATE 1: OOR-below only
+  const distBelow = lowerBin - activeBin;
+  if (distBelow < Number(cfg.crashMinBinDistance ?? 8)) return null; // GATE 2: min distance
+  if (trail.length < 2) return null;
+  const first = trail[0], last = trail[trail.length - 1];
+  const spanSec = (last.t - first.t) / 1000;
+  if (spanSec < Number(cfg.crashMinSpanSec ?? 9)) return null;    // GATE 3a: min time base
+  const binsDropped = first.bin - last.bin;
+  if (binsDropped <= 0) return null;                              // net not falling
+  const binsPerMin = binsDropped / (spanSec / 60);
+  if (binsPerMin < Number(cfg.crashBinsPerMin ?? 12)) return null;// GATE 3b: velocity
+  return {
+    crash: true,
+    reason: `crash-below ${binsDropped} bins/${spanSec.toFixed(0)}s ` +
+            `(${binsPerMin.toFixed(1)} b/min, dist ${distBelow})`,
+  };
+}
```

### Patch B — hook into the PnL poller loop (`index.js`, inside the `for (const p of ...)` at ~1256)

The crash check runs *first* and, when armed, overrides the signal fed to `registerExitSignal`.
It is wrapped so a detector fault degrades to the normal flow (§ failure containment).

```diff
         // Detect an exit signal this tick (rule-based exits, then deterministic close rules).
         const exit = updatePnlAndCheckExits(p.position, p, config.management);
         const closeRule = exit ? null : getDeterministicCloseRule(p, config.management);
         let signal = null, reason = null, rule = "exit";
         if (exit) { signal = exit.action; reason = exit.reason; }
         else if (closeRule) { signal = `RULE_${closeRule.rule}`; reason = closeRule.reason; rule = closeRule.rule; }
+
+        // Price-crash fast-path — outranks the (slow) OOR-time rule when a downside break is
+        // moving fast enough to be a rug. Detector is total; still wrap so a fault can't break
+        // the poller loop — on error we simply keep the normal signal above.
+        if (config.management.crashFastPathEnabled) {
+          try {
+            const crash = detectPriceCrash(p.position, p, config.management);
+            if (crash) { signal = "CRASH_FASTPATH"; reason = crash.reason; rule = "crash"; }
+          } catch (e) {
+            log("cron_warn", `crash detector error (ignored): ${e.message}`);
+          }
+        }
+        const crashConfirm = rule === "crash"
+          ? Math.max(1, Number(config.management.crashConfirmTicks ?? 3))
+          : confirmTicks;
 
         // Require N consecutive confirming ticks before acting.
-        const { fire } = registerExitSignal(p.position, signal, confirmTicks);
+        const { fire } = registerExitSignal(p.position, signal, crashConfirm);
         if (!signal || !fire) continue;
```

The downstream block is unchanged — it already builds
`new Map([[p.position, { action: "CLOSE", rule, reason }]])` and calls
`executeManagementActions([p], actMap, {})`, so a `rule:"crash"` close reuses the exact mechanical
path, Telegram notify, auto-swap, and socket resync. (`log` line at 1267 will read
`CRASH_FASTPATH confirmed (3 ticks)` naturally.)

### Patch C — trail cleanup on close (`index.js`)

`clearPriceHistory(positionAddress)` (already called on close for `_recentActiveBins`) now also
clears `_binTrail` (covered in Patch A's edit to `clearPriceHistory`). Confirm `clearPriceHistory`
is invoked after a successful close; if not currently wired for the poller path, add one line in
`executeManagementActions` after a successful CLOSE. *(Verify at implementation; the buffer self-trims
by `crashWindowSec` anyway, and closed positions stop being polled, so a leak is bounded and
harmless — cleanup is hygiene, not correctness.)*

### Patch D — CONFIG_MAP + config.js (see §4 diffs).

---

## 6. False-positive scenarios & handling

| Scenario | Why it might false-fire | Handled by |
|----------|--------------------------|------------|
| **Normal chop at the range edge** | Active bin flickers ±1–3 bins around a lower edge that sits near price | GATE 2 `crashMinBinDistance=8` — must be ≥8 bins below before arming; flicker never reaches it. |
| **Single stale/duplicate RPC tick** | One tick reports a far-below `active_bin`, then recovers | GATE 3a `crashMinSpanSec` needs a real time base; `crashConfirmTicks=3` needs 3 *consecutive* confirming polls (~9s) — a lone bad tick clears the streak. |
| **Fast pump (upside break)** | Rapid *upward* bin travel | GATE 1 fires only when `active_bin < lower_bin`; upside is untouched and still handled by the existing pump-stabilization (`isPriceStable`) logic. |
| **Healthy but volatile meme (vol 5–7)** | Sustained-ish movement | Velocity gate `crashBinsPerMin=12` (≈12%/min at bin_step 100) sits ~2–3× above realistic directional chop; a healthy pool doesn't sustain it. Non-fire worked example in §3. |
| **Position re-entered range then dipped again** | Old dip contaminates velocity | `crashWindowSec=90` window ages out stale samples; `binsDropped = first.bin - last.bin` over the *current* window only. |
| **Wick that immediately recovers** | Sharp 1-tick down-then-up | Confirm-ticks + net-drop check (`binsDropped <= 0` on the window bails); by the time 3 ticks pass a wick has recovered and the streak resets. Trade-off: a genuine crash that fully reverses within 9s won't fire — acceptable, since nothing was lost. |
| **Missing/`null` bin fields (RPC hiccup)** | `active_bin`/`lower_bin` null | Early `Number.isFinite` guard returns null → no fire, normal flow continues. |
| **DRY_RUN / detector logic bug** | — | Wrapped in try/catch (Patch B); any throw is logged and the normal signal is used. |

**Explicit non-goal:** the fast-path never *widens* protection — it can only make a below-range
close *earlier*. It cannot close an in-range or above-range position, and cannot fire when disabled.
Worst-case harm of a false positive is closing a position ~60 min earlier than the time-gate would
have; since the position is already ≥8 bins below range and falling ≥12 bins/min, that early close
is almost always correct even in the rare false trigger.

---

## 7. Rollout plan

**Phase 0 — merge OFF.** Land all patches with `crashFastPathEnabled=false`. Zero behavior change
(every path is behind the flag). Verify `npm run` boots and the poller loop is unchanged in logs.

**Phase 1 — shadow mode (log-only), 3–7 days.** Add a one-line temporary shadow branch: when the
detector *would* fire but the flag is off, `log("crash_shadow", ...)` instead of acting. (Implement
as: compute `detectPriceCrash` unconditionally but only *act* when `crashFastPathEnabled`; log the
"would-fire" case.) Watch:
- Grep `crash_shadow` in the daily logs. Cross-check each hit against the position's actual outcome
  (did it later rug, or recover?). This calibrates `crashBinsPerMin`/`crashMinBinDistance` on *live*
  data before any real close. Zero risk — no closes happen.
- Confirm the *non*-fire rate on ordinary OOR-below events (should be ~all of them).

**Phase 2 — enable in DRY_RUN or on a single position.** Set `crashFastPathEnabled=true` on the VM
(`update_config`), optionally with `DRY_RUN=true` first so the mechanical-close path is exercised
end-to-end (signal → confirm → `executeManagementActions` → notify) without an on-chain tx. Watch
Telegram for a `Rule crash: crash-below …` close line and the `[PnL poll] CRASH_FASTPATH confirmed`
log.

**Phase 3 — enable live.** Flip `DRY_RUN` off (or it was already off). Monitor for the first genuine
crash close. Tune `crashBinsPerMin` up if any false close occurs (higher = stricter).

**What to watch (logs / Telegram):**
- Log tag `state`: `[PnL poll] CRASH_FASTPATH confirmed (N ticks): <pair> — <reason> — closing directly`.
- Telegram close notification with `reason` = `crash-below …`.
- Any `crash detector error (ignored)` warnings (should be none).
- The close's realized PnL vs. what the 60m time-gate would likely have realized (post-hoc, in
  pool-memory / closed-position record).

**Rollback (instant):** `update_config crashFastPathEnabled=false` — live-applies immediately
(executor apply loop) and persists to `user-config.json`; no restart. Because every touched code path
is flag-gated, OFF fully restores prior behavior. The `.env`/config change survives the git syncer's
`reset --hard` (user-config.json is gitignored).

---

## 8. Regression-risk table (per touched line/block)

| Touched | Change | Risk if flag OFF | Risk if flag ON | Mitigation |
|---------|--------|------------------|-----------------|------------|
| `config.js` management block (+6 keys) | new defaults | None — additive keys, no existing key changed | None | `??` defaults; keys unused unless read. |
| `executor.js` CONFIG_MAP (+6 entries) | new map rows | None — only reachable via `update_config` with those keys | None | Mirrors existing `management` entries exactly. |
| `index.js` `_binTrail` decl + `detectPriceCrash` (new fn) | new pure fn + Map | None — never called when flag off (early return) | Pure/total, wrapped in try/catch at call site | No I/O, no persistence, no throw path reaches the loop. |
| `index.js` `clearPriceHistory` (+1 line) | `_binTrail.delete` | None — deleting a never-populated key is a no-op | Bounded cleanup | Idempotent `Map.delete`. |
| `index.js` poller loop crash block (+~10 lines) | conditional signal override | **`if (config.management.crashFastPathEnabled)` guard → block is skipped entirely** | Overrides `signal`/`rule`/`reason` only when detector fires; feeds *existing* `registerExitSignal` + mechanical close | Guard + try/catch; on any error keeps the pre-existing `signal`. Reuses the confirm-tick gate and `_managementBusy` lock — **no new concurrency** (Race Condition invariant preserved: the poller already holds/sets `_managementBusy` before `executeManagementActions`, so the mgmt cron cannot double-act). |
| `index.js` `registerExitSignal(..., crashConfirm)` | pass a per-signal confirm count | None — `crashConfirm === confirmTicks` when rule≠"crash" | Uses `crashConfirmTicks` only for the crash signal | Ternary defaults to the existing `confirmTicks`; `registerExitSignal` already resets its streak on signal change, so switching between `RULE_*` and `CRASH_FASTPATH` mid-crash cannot mis-count. |

**Concurrency note (Race Condition doc):** the fast-path introduces no new writer. It runs inside the
existing `_pnlPollBusy`-guarded poller, sets `_managementBusy` before `executeManagementActions` (as
the current poller already does at index.js 1269), and closes through the single mechanical path. The
`_binTrail` map is touched only from the single poller callback, so no cross-tick race exists.

---

## Appendix — files & anchors referenced

- PnL poller loop: `index.js` ~1229–1284 (detector hook at ~1256–1265).
- `getDeterministicCloseRule` (OOR rules 1–5): `index.js` 1459–1533 (below-time gate 1515–1524).
- `executeManagementActions` (mechanical CLOSE): `index.js` 247–277.
- `isPriceStable` / `_recentActiveBins` / `clearPriceHistory`: `index.js` 116–138.
- `updatePnlAndCheckExits` (OOR-below time rule): `state.js` 681–780+.
- `registerExitSignal` (confirm-tick gate): `state.js` 591–623.
- `markOutOfRange`/`markInRange`/`minutesOutOfRange`: `state.js` 409–457.
- Socket monitor (detect-only, `.force-sync`): `tools/socket-monitor.js` 94–136.
- config `management` block: `config.js` 224–269; `pnl` block: 352–362.
- `update_config` apply/persist + CONFIG_MAP: `tools/executor.js` 441–770.
- Tick fields (`active_bin`/`lower_bin`/`upper_bin`/`bin_step`/`in_range`): `tools/dlmm.js` 1306–1343.
```
