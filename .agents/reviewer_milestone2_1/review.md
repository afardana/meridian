# Milestone 2 Review and Adversarial Challenge Report

## Review Summary

**Verdict**: REQUEST_CHANGES

The implementation of requirements R1-R7 has been thoroughly reviewed across the `meridian` and `meridian-dashboard` repositories. While the code changes are clean, syntactically correct, and cover the majority of requirements, there is a **Critical Functional Gap** in the implementation of R7 (tab visibility detection is not registered), and a **Major Fallback Bug** in R4 (fallback properties do not match the state schema). Therefore, the work product cannot be approved in its current state.

---

## Quality Review Findings

### [Critical] Visibility Change Listener is Missing (R7)

- **What**: The client-side application initializes `isTabHidden = false` and checks this variable to suspend polling, but never registers any event listener (such as `visibilitychange`) to update the value when the tab's visibility status changes.
- **Where**: `/Users/Angga/Repos/meridian-dashboard/public/app.js` (lines 19, 254, 820)
- **Why**: As a result, the tab-hidden state is never triggered. The application continues polling the server at the active rate (every 3 seconds, or 30 seconds if idle) even when the tab is hidden, wasting client CPU/GPU and network/server resources. This directly violates the functional requirement of R7.
- **Suggestion**: Register a `visibilitychange` listener inside `DOMContentLoaded` in `/Users/Angga/Repos/meridian-dashboard/public/app.js`:
  ```javascript
  document.addEventListener('visibilitychange', () => {
    isTabHidden = document.hidden;
    updatePollingRates();
  });
  ```

### [Major] Wrong Property Names in Active Bins Fallback (R4)
- **What**: In the dashboard backend status mapping, when a pool memory snapshot is not available, the code falls back to `pos.lower_bin`, `pos.upper_bin`, and `pos.active_bin` to render the range gauge.
- **Where**: `/Users/Angga/Repos/meridian-dashboard/index.js` (lines 268-270, and similarly 256-258)
- **Why**: The state serialization in `state.js` records the bin range as an object under `pos.bin_range` (containing `{ min, max }`) rather than properties directly on `pos`. Consequently, the fallback properties will resolve to `null`, and the active price range visualizer gauge will not render if the pool memory snapshot is missing, instead of falling back to the deploy-time ranges.
- **Suggestion**: Access the correct nested property in the fallback path:
  ```javascript
  lower_bin = latestSnapshot.lower_bin ?? pos.lower_bin ?? (pos.bin_range ? pos.bin_range.min : null);
  upper_bin = latestSnapshot.upper_bin ?? pos.upper_bin ?? (pos.bin_range ? pos.bin_range.max : null);
  active_bin = latestSnapshot.active_bin ?? pos.active_bin ?? pos.active_bin_at_deploy ?? null;
  ```

### [Minor] Concurrent Force Sync Triggers Ignored (R1)
- **What**: If the bot is already busy executing a management cycle (`_managementBusy = true`), the `.force-sync` IPC file is successfully unlinked, but `runManagementCycle` returns `null` immediately and does not trigger another cycle.
- **Where**: `/Users/Angga/Repos/meridian/index.js` (line 96, 210)
- **Why**: While this prevents race conditions and is the correct technical choice, the dashboard user will receive a "Force sync completed successfully" alert even though the bot did not execute a new management cycle but simply skipped it due to being busy.
- **Suggestion**: The dashboard backend could poll for the management status, or we can accept this as expected behavior and document it.

---

## Verified Claims

- **Claim 1**: Syntax check passes on the bot codebase → Verified via running `npm run test:syntax` inside `/Users/Angga/Repos/meridian` → **PASS**
- **Claim 2**: Syntax check passes on the dashboard codebase → Verified via running `node --check index.js` inside `/Users/Angga/Repos/meridian-dashboard` → **PASS**
- **Claim 3**: Pool discovery/screening pipeline works correctly without regressions → Verified via running `node test/test-screening.js` inside `/Users/Angga/Repos/meridian` → **PASS**
- **Claim 4**: IPC mechanism deletes `.force-sync` and triggers management cycle → Verified via analyzing `index.js` code flow and `fs.unlinkSync` calls → **PASS**
- **Claim 5**: Structured State PnL serialization adds numeric fields (`exit_pnl_pct`, `exit_pnl_usd`) → Verified via reviewing code changes in `state.js` and `tools/dlmm.js` → **PASS**

---

## Coverage Gaps

- **Tab Visibility Handler** — Risk Level: **High** — Recommendation: **Investigate and Fix**. The `isTabHidden` variable is dead code since it is never assigned or updated.
- **Local Dev PM2 Dependency** — Risk Level: **Low** — Recommendation: **Accept Risk**. PM2 is not installed globally on macOS development machines, so `/api/restart-process` will return a 500 error locally. This is acceptable since production environments (Oracle VM) run PM2.
- **Initial Chart Population** — Risk Level: **Medium** — Recommendation: **Accept Risk**. The hourly cron job is seeded on startup so that the chart isn't empty, but the data points will build slowly (1 point per hour). This is acceptable for a timeseries chart.

---

## Unverified Items

- **Actual VM deployment behavior** — Reason: Out of scope (Milestone 5). Local tests verify logic and syntax only.
- **Actual wallet transaction PnL serialization** — Reason: Transactions require live Solana private keys. Only mock-verified via static code path analysis.

---

## Challenge Summary (Adversarial Critic)

**Overall risk assessment**: MEDIUM

The system design for IPC and timeseries logging is highly efficient and minimizes RPC usage, satisfying the Cost & Operational Efficiency Rules. However, stress-testing the assumptions reveals some failure modes:
1. **IPC lockups**: If the bot is stuck in a loop, it will not process `.force-sync`, causing the dashboard to block for 10 seconds and return a 504.
2. **Chart data size**: Capping the history file at 720 entries is safe, but there is no file locking. If the bot writes to `balance-history.json` while the dashboard reads it, it could result in corrupted JSON reads.
3. **CPU constraints**: The idle animation suspension works on class presence, but since `isTabHidden` is never set, browser cycles are wasted when the page is backgrounded.

---

## Challenges

### [High] Corrupted JSON Read Risk on Balance History

- **Assumption challenged**: The dashboard reads `balance-history.json` safely while the bot is writing to it.
- **Attack scenario**: The bot's hourly cron job executes `fs.writeFileSync` while a user is refreshing the dashboard page (which triggers `fs.readFileSync` via `/api/balance-history`). Because Node.js file operations are not atomic across processes unless using temporary rename files, the dashboard can read a partially written file, leading to a `SyntaxError: Unexpected end of JSON input` crash.
- **Blast radius**: The dashboard backend returns a 500 error, and the client-side chart fails to render.
- **Mitigation**: Perform atomic write operations in `recordBalanceHistory` by writing to a temporary file first (e.g. `balance-history.json.tmp`) and renaming it:
  ```javascript
  const tmpFile = historyFile + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(history, null, 2), "utf8");
  fs.renameSync(tmpFile, historyFile);
  ```
  Renaming is atomic on POSIX filesystems.

### [Medium] IPC File Lockups on Bot Stalls

- **Assumption challenged**: The bot is always responsive to the `.force-sync` IPC file.
- **Attack scenario**: If the bot gets stuck in a CPU-intensive operation or a blocked promise in `agentLoop`, the 3-second interval check will stall. A user clicking "Force Sync" will cause the backend to write `.force-sync`, poll for 10 seconds, and time out with a 504.
- **Blast radius**: User receives a timeout alert, and the `.force-sync` file is unlinked by the dashboard backend.
- **Mitigation**: The current mitigation (cleaning up the file on timeout) is sufficient to prevent persistent file pollution, but the user interface could display a more specific warning ("Bot process is unresponsive") instead of a generic timeout.

---

## Stress Test Results

- **Bot is dead/stopped** → User clicks Force Sync → Dashboard checks PM2 status, detects bot is offline, and returns a 400 error immediately → **PASS** (handled correctly)
- **Extreme log files count** → Dashboard backend loads agent logs date selection → Scans logs folder, extracts unique dates, sorts them, and displays last 7 → **PASS** (handled correctly, memory usage capped)
- **Empty balance history file** → Frontend renders chart → Receives `[]`, hides canvas gracefully → **PASS** (handled correctly)
- **Tab is backgrounded** → CPU/GPU suspension → `.tab-hidden` class is never added because visibility listener is missing → **FAIL** (polling continues at active rate)

---

## Unchallenged Areas

- **Solana transaction fees & slippage** — Reason: Transactions are skipped during dry-run testing. We cannot stress-test transaction-level fee capture without a funded wallet.
