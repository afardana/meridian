## 2026-06-16T04:16:38Z
Please perform remediation fixes for requirements R1, R2, R4, and R7 based on the reviewer reports:

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Remediation Tasks:
1. **R7: Tab Visibility Listener (Critical)**:
   - In `/Users/Angga/Repos/meridian-dashboard/public/app.js`, register the `visibilitychange` event listener on the `document` (inside the DOMContentLoaded handler) to update `isTabHidden` state (`isTabHidden = document.hidden;`) and trigger `updatePollingRates()`. Verify it is no longer a facade implementation.
2. **R4: Active Positions Visualizer Fallback Mismatch**:
   - In `/Users/Angga/Repos/meridian-dashboard/index.js` status mapping, when a pool memory snapshot is not found, correctly access the nested property `pos.bin_range?.min` and `pos.bin_range?.max` instead of `pos.lower_bin`/`pos.upper_bin` directly on `pos`. Also use `pos.active_bin_at_deploy` as fallback for active bin.
3. **R1: Force Sync Concurrency/Busy State Handling**:
   - In `/Users/Angga/Repos/meridian/index.js`, modify the `.force-sync` check in the 3-second poller so that it only unlinks (deletes) the file and triggers the sync if the bot is NOT currently busy (`!this._managementBusy`). If the bot is busy, leave the file alone so the dashboard backend continues polling and either executes when the bot becomes free or times out.
4. **R2: Startup Logging Deduplication**:
   - In the bot (`index.js`), in `recordBalanceHistory()`, read the existing `balance-history.json` file first. If the last entry's timestamp is less than 30 minutes old (e.g. `Date.now() - new Date(lastEntry.ts).getTime() < 30 * 60 * 1000`), skip appending a new entry to prevent PM2 crash/restart loops from spamming the history.
5. **R2: Atomic JSON Write & RPC Fallback**:
   - In `recordBalanceHistory()`, if `getMyPositions()` fails/throws an error, catch it and either skip writing the log entry or log a warning and return (do NOT write `deployedSol = 0` which creates a fake drawdown drop).
   - Write to `balance-history.json` atomically by first writing to `balance-history.json.tmp` and then renaming it via `fs.renameSync()` to avoid race conditions and JSON corruption reads by the dashboard.

When finished, run syntax checks and local verification (npm run test:syntax in bot, node --check index.js in dashboard), write the updated changes report to '/Users/Angga/Repos/meridian/.agents/worker_remediation_milestone2/changes.md', and report back.
