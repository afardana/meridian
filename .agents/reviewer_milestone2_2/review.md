# Technical Review and Challenge Report — Milestone 2

This report presents a thorough quality review and adversarial challenge assessment of the implementation of requirements R1-R7 across the `meridian` (bot) and `meridian-dashboard` (dashboard) repositories.

---

## Part 1: Quality Review

**Verdict**: **REQUEST_CHANGES** (Critical Finding: Integrity Violation)

### Critical Findings

#### 🔴 Critical Finding 1: INTEGRITY VIOLATION — Facade Page Hidden Suspension Logic (R7)
- **What**: The page visibility change event listener is completely missing in the frontend controller script. A state variable `isTabHidden` is declared as `false` and checked in polling loops, but it is never updated.
- **Where**: `/Users/Angga/Repos/meridian-dashboard/public/app.js` (lines 19, 254, 820)
- **Why**: This is a dummy/facade implementation. It makes the code appear as if it suspends polling when the browser tab is hidden (preventing useless network and server overhead), but since `isTabHidden` is never bound to any visibility change events, it remains `false` forever. Polling never actually suspends.
- **Suggestion**: Bind an event listener to the `'visibilitychange'` event on the document to update `isTabHidden` and trigger polling updates:
  ```javascript
  document.addEventListener('visibilitychange', () => {
    isTabHidden = document.hidden;
    updatePollingRates();
  });
  ```

---

### Minor Findings

#### 🟡 Minor Finding 2: Active Positions Visualizer Fallback Failure (R4)
- **What**: The dashboard status route maps position boundaries using `pos.lower_bin`, `pos.upper_bin`, and `pos.active_bin` as fallbacks if no pool memory snapshot is found. However, these properties do not exist directly on the position objects stored in `state.json`.
- **Where**: `/Users/Angga/Repos/meridian-dashboard/index.js` (lines 256-258 and 268-270)
- **Why**: In `state.json`, position bin ranges are recorded inside a nested object: `bin_range: { min, max, ... }` and the active bin at deploy is `active_bin_at_deploy`. Because the fallback references `pos.lower_bin` directly, it evaluates to `undefined` (resulting in `null`). If the bot is offline or pool memory snapshots are missing, the range visualizer fails to render even though deploy-time bin data is available in `state.json`.
- **Suggestion**: Update the fallback values in `index.js` to reference the correct state fields:
  ```javascript
  lower_bin = latestSnapshot.lower_bin ?? pos.bin_range?.min ?? null;
  upper_bin = latestSnapshot.upper_bin ?? pos.bin_range?.max ?? null;
  active_bin = latestSnapshot.active_bin ?? pos.bin_range?.active ?? pos.active_bin_at_deploy ?? null;
  ```

#### 🟡 Minor Finding 3: Concurrency Race Condition in Force Sync (R1)
- **What**: The bot's PnL poller checks for `.force-sync`, immediately deletes the file, and invokes `runManagementCycle({ silent: false })`.
- **Where**: `/Users/Angga/Repos/meridian/index.js` (lines 855-866)
- **Why**: If a management cycle is already running (`_managementBusy` is `true`), `runManagementCycle` returns `null` immediately and does nothing. However, since the `.force-sync` file is deleted, the dashboard backend (polling for file deletion) believes the sync completed successfully and returns `200 OK` to the frontend, even though the request was silently ignored by the bot.
- **Suggestion**: The bot should check if `_managementBusy` is `true` before unlinking the file, or handle the busy status gracefully by delaying unlinking until the cycle is available.

#### 🟡 Minor Finding 4: Duplicate Balance History Records on Crash/Restart (R2)
- **What**: The bot runs `recordBalanceHistory()` immediately on startup and schedules it hourly.
- **Where**: `/Users/Angga/Repos/meridian/index.js` (line 813 and line 921)
- **Why**: If the bot experiences frequent restarts (e.g. transient network errors causing PM2 restarts), it will write multiple near-duplicate entries to `balance-history.json` within minutes. This can quickly clog the 720-entry limit and push out actual historical data.
- **Suggestion**: Deduplicate entries by reading the last entry in `balance-history.json` and skipping the startup write if the time difference is less than 30 minutes.

---

## Part 2: Adversarial Review

**Overall Risk Assessment**: **MEDIUM**

### Challenges

#### 🟠 Challenge 1: Network/RPC Failure corrupts Balance History (R2)
- **Assumption challenged**: The bot assumes that `getMyPositions` will always resolve successfully or degrade gracefully.
- **Attack scenario**: If the RPC node is rate-limited or fails transiently during an hourly tick, `getMyPositions()` will throw an error. The error is caught, but `deployedSol` remains `0`. The bot then records `totalSol = idleSol + 0` (only idle SOL) into `balance-history.json`.
- **Blast radius**: The timeseries yield chart on the dashboard will display a sudden, sharp drop in portfolio valuation to near-idle balance levels, giving false signals of a huge loss (drawdown) to the user.
- **Mitigation**: If position fetching fails during balance logging, the bot should skip recording the history entry for that hour, or use the last cached position valuation instead of assuming `deployedSol = 0`.

#### 🟡 Challenge 2: Out-of-bounds calculations in range visualizer (R4)
- **Assumption challenged**: The current active bin will always fall within or close to the `lower_bin` and `upper_bin`.
- **Attack scenario**: In DLMM pools with extreme volatility, the price can move significantly outside the position's bin range. The calculated percentage `relativePct = ((active_bin - lower_bin) / totalRange) * 100` can be negative (e.g., -150%) or larger than 100% (e.g., 250%). The frontend clamps it to `0` or `100` via `Math.max(0, Math.min(100, relativePct))`. However, if `totalRange` is `0` (which is technically invalid for a DLMM position but could occur if data is corrupt), it defaults to `50%`, which shows a green/yellow in-range indicator at the center.
- **Mitigation**: Ensure `totalRange` is strictly greater than 0, and verify pointer style boundaries.

---

## Part 3: Verification & Interface Contracts

### Verified Claims
- **Claim**: R1 Force Sync IPC signal file.
  - *Method*: Inspected `index.js` in bot (lines 855-866) and dashboard (lines 491-532). Confirmed file name `.force-sync` matches, is placed in the repository root, and is polled up to 10 seconds.
  - *Status*: **PASS**
- **Claim**: R2 balance history schema and capping.
  - *Method*: Inspected `index.js` in bot (lines 749-807). Verified schema matches keys: `{ ts, idleSol, deployedSol, totalSol, solPriceUsd, totalUsd }` and is sliced to keep the last 720 entries.
  - *Status*: **PASS**
- **Claim**: R5 structured exit PnL serialization.
  - *Method*: Inspected `state.js` in bot (lines 543-551) and `tools/dlmm.js` (lines 1757 and 2040). Verified fields `exit_pnl_pct` and `exit_pnl_usd` are recorded. Inspected `index.js` in dashboard (lines 51-53). Confirmed direct reading of numerical fields first.
  - *Status*: **PASS**

### Coverage Gaps
- **PM2 process verification**: The dashboard backend `POST /api/force-sync` and `POST /api/restart-process` rely on `pm2 jlist` and `pm2 restart`. On local dev, PM2 was not found (`command not found: pm2`), meaning this API returns a 400 error. The verification of the PM2 integration was accepted based on code analysis as local execution of PM2 is blocked.
  - *Risk level*: Low.
  - *Recommendation*: Accept risk; verify on the actual VM.

### Unverified Items
- **On-chain execution of Force Sync**: The actual on-chain transaction checks and state changes triggered by the force sync button were not executed locally because they require active private keys and RPC write permissions.
  - *Reason*: Staged dry run environment.
