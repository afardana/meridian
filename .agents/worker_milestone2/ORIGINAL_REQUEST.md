## 2026-06-16T11:10:38Z
Please implement the requirements R1-R7 across the meridian and meridian-dashboard codebases:

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A Forensic Auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Key Tasks:
1. Examine the codebase files and git remotes for meridian and meridian-dashboard.
2. Check SSH connection credentials and configurations to see how we can deploy to oraclevm.fardana.com (user angga).
3. Implement the requirements in detail:
   - R1: Live Force Sync Button
     - Backend route: POST /api/force-sync in meridian-dashboard/index.js. Writes a `.force-sync` file to the bot repository root as an IPC flag. It checks for PM2 process 'meridian' status and polls for the file to be deleted by the bot (up to 10s timeout). Returns success.
     - Bot: index.js checks for `.force-sync` in the 3-second poller. If found, unlinks the file and triggers runManagementCycle({ silent: false }) immediately.
     - Frontend: Force Sync button in index.html header. app.js disables the button, shows a spinner, calls POST /api/force-sync, and refreshes status on success.
   - R2: Timeseries Yield & Balance Chart
     - Bot index.js: Add hourly node-cron job ('0 * * * *') to calculate idle SOL, deployed SOL, total SOL, solPriceUsd, totalUsd and append to balance-history.json (limit to last 720 entries).
     - Dashboard index.js: Expose GET /api/balance-history.
     - Frontend index.html & app.js: Load Chart.js via CDN. Display a beautiful two-axis area/line chart (Total SOL vs Total USD) with a SOL/USD toggle button. Place the chart in a sleek, premium container card.
   - R3: Log Rotation Date Selector
     - Dashboard index.js: Update GET /api/logs/agent to support query parameter '?date=YYYY-MM-DD'. It scans logs directory, lists files like agent-YYYY-MM-DD.log, and returns `{ logs, dates, selectedDate }`. If date doesn't exist, return error.
     - Frontend index.html & app.js: Select dropdown menu with the last 7 calendar days. Selecting a date fetches that date's log file and disables auto-refresh.
   - R4: Active Positions Price & Range Visualizer
     - Bot: recordPositionSnapshot in pool-memory.js must include `lower_bin`, `upper_bin`, and `active_bin`.
     - Dashboard index.js: Map these fields in /api/status.
     - Frontend index.html & app.js: Render a horizontal gauge/bar showing active position price relative to lower/upper bounds, green if in-range, red/yellow if out-of-range.
   - R5: Structured State Serialization
     - Bot state.js: Add export helper updateClosedPositionPnL(pos_addr, pct, usd) to write numerical exit_pnl_pct and exit_pnl_usd.
     - Bot tools/dlmm.js: Call helper on close (relay/local close) after Meteor API resolution.
     - Dashboard index.js: Modify parseExitPnL to check for these numerical fields first, falling back to notes log parsing only for old positions.
   - R6: PM2 Errored State Alert Banner
     - Frontend: Warning banner at the top of index.html. If 'meridian' PM2 status is 'stopped' or 'errored' in /api/status response, show banner with a "Restart Bot" button triggering POST /api/restart-process.
   - R7: Performance Idle Constraints
     - Frontend app.js: Visibility change listener and user activity listener (resetting 5-minute timeout). Toggle .user-idle / .tab-hidden classes on body. Suspend polling when hidden, slow polling to 30s when idle.
     - Frontend style.css: Stop infinite animations (animation-play-state: paused !important) and transitions (transition-duration: 0s !important) when .user-idle or .tab-hidden is set.
4. Run syntax checks (npm run test:syntax) and verify everything compiles/runs locally.
5. Provide a detailed report of the changes made and tests executed. Write this to '/Users/Angga/Repos/meridian/.agents/worker_milestone2/changes.md' and your handoff report. Do NOT push to git or deploy yet, just implement and verify locally. We will trigger deployment in a subsequent milestone.
