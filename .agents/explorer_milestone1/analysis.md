# Technical Analysis & Implementation Design Report
**Milestone 1: Exploration and Technical Design**

## Executive Summary
This report presents the findings from an initial exploration of the Meridian bot and Meridian Dashboard repositories. The codebases have been analyzed, and a detailed technical implementation design has been drafted for requirements R1 through R7. 

No other dashboard analysis reports or gap/OFI documents were found in the workspace, other than the initial setup notes in the agent files (e.g., `sentinel/handoff.md`).

---

## 1. Codebase Structure Analysis

### A. Meridian Bot Repository (`/Users/Angga/Repos/meridian`)
*   **`index.js`**: Core entrypoint of the bot. Manages scheduling of management cycles (`runManagementCycle`), screening cycles (`runScreeningCycle`), morning briefings, and lightweight PnL polling. Uses `node-cron` for scheduling. Handles interactive TTY REPL and Telegram bot commands.
*   **`state.js`**: Handles persistence of position tracking (`state.json`). Tracks metadata such as deployment timestamps, strategies, out-of-range events, and historical close notes.
*   **`pool-memory.js`**: Manages `pool-memory.json` which tracks persistent deploy history and aggregate performance statistics per pool address. Includes a trend snapshot capability (`recordPositionSnapshot`) that builds a trend dataset of active positions during management cycles.

### B. Meridian Dashboard Repository (`/Users/Angga/Repos/meridian-dashboard`)
*   **`index.js`**: Express.js server backend. Serves on port `3002`. Exposes APIs to read system status, restart PM2 processes, update baseline SOL capital, and retrieve logs.
*   **`public/index.html`**: Main UI dashboard layout built on Glassmorphism theme, using grid card structures for KPIs, position tables, PM2 list, system config, and terminal console logs.
*   **`public/app.js`**: Frontend controller script. Polls `/api/status` and `/api/logs/agent` (or `/api/logs/decisions`) every 3 seconds to update the UI dynamically.
*   **`public/style.css`**: Styling sheets configuring modern font styles, layout grids, neon colors, glow effects, responsive media queries, and transition durations.

---

## 2. Technical Implementation Design (R1 to R7)

### R1: Live Force Sync Button
*   **Concept**: Allow the user to bypass the 3-minute cached loop in the bot and trigger an immediate position scan, updating the dashboard UI.
*   **Trigger Mechanism**: Since the bot and the dashboard backend run in separate PM2 processes, a file-based flag will act as the IPC signal.
    1.  **Dashboard Backend**: Add `POST /api/sync`. When called, it checks if PM2 process `meridian` is active, writes an empty flag file `.force-sync` to the bot directory, and polls the directory until the file is deleted (up to 10s).
    2.  **Bot (`index.js`)**: In the 3-second lightweight PnL poller loop, check for the existence of `repoPath(".force-sync")`. If present, immediately delete the file, reset poller cooldowns, and trigger `runManagementCycle({ silent: false })` to scan on-chain positions and write fresh snapshots to `pool-memory.json` and `state.json`.
    3.  **Dashboard Frontend**: Add a "Force Sync" button to the header of `index.html`. On click, disable the button, trigger the sync POST request, show a spinner, and call `fetchStatus()` upon success to refresh the UI immediately.

### R2: Timeseries Yield & Balance Chart
*   **Concept**: Track hourly SOL/USD balance histories and display them in a responsive chart.
*   **Data Logging**:
    - Add a cron task to the bot's `index.js` running every hour: `0 * * * *`.
    - Fetch idle SOL balance via `getWalletBalances()`, and calculate deployed SOL value from active positions retrieved via `getMyPositions({ force: true })`.
    - Append `{ ts, idleSol, deployedSol, totalSol, solPriceUsd, totalUsd }` to `balance-history.json`, keeping the history capped at 720 entries (30 days).
*   **API Endpoint**: Add `GET /api/balance-history` in dashboard `index.js` to serve `balance-history.json`.
*   **UI Integration**:
    - Load Chart.js CDN in `index.html`. Add a new chart container card.
    - In `public/app.js`, fetch the history and render a beautiful two-axis area/line chart showing Total SOL on the left Y-axis and Total USD value on the right Y-axis, complete with a toggle button `[SOL | USD]`.

### R3: Log Rotation Date Selector
*   **Concept**: Permit reading historical agent logs based on calendar dates (e.g., `agent-YYYY-MM-DD.log`).
*   **Backend Endpoint Update**:
    - Modify `GET /api/logs/agent` in dashboard `index.js`.
    - Scan the `/opt/meridian/logs` directory using `fs.readdirSync()`, filter files matching `/^agent-(.*)\.log$/`, and extract a list of unique log dates.
    - Read a query parameter `?date=YYYY-MM-DD` and serve that specific log file (defaulting to the latest active file). Return `{ logs, dates, selectedDate }`.
*   **UI Integration**:
    - Add a `<select id="log-date-select">` dropdown next to the terminal filter input.
    - Populate dropdown options dynamically from `dates` array.
    - When a historical date is selected, request logs for that date and automatically uncheck/disable "Auto-refresh" to prevent overwriting the viewed logs.

### R4: Active Positions Price & Range Visualizer
*   **Concept**: Render where the current asset price sits relative to lower/upper DLMM bin bounds.
*   **Data Structure Enhancement**:
    - In `pool-memory.js`, modify `recordPositionSnapshot` to include `lower_bin`, `upper_bin`, and `active_bin` in the snapshot structure.
    - In dashboard backend `index.js`, map these properties from the latest pool snapshot to the `/api/status` positions response objects.
*   **UI Representation**:
    - Add a horizontal bar visualization under the "Status" column of active positions in the tables.
    - Calculate relative position percentage: `pct = ((active_bin - lower_bin) / (upper_bin - lower_bin)) * 100`.
    - Render a range progress bar with a pointer dot at `left: pct%`. Color-code the dot green if active price is within bounds, or red if it is out-of-range (clamping dot to edges if `active_bin` goes beyond `lower_bin` or `upper_bin`).

### R5: Structured State Serialization
*   **Concept**: Avoid regex parsing of log text for closed position PnLs by writing structured fields directly to `state.json`.
*   **Bot Serialization**:
    - In `state.js`, export a helper function `updateClosedPositionPnL(position_address, exit_pnl_pct, exit_pnl_usd)` to write numerical fields `exit_pnl_pct` and `exit_pnl_usd` to the position object.
    - In `tools/dlmm.js`, call this helper function once the closed position's authoritative PnL is successfully fetched (or fallback cached values are resolved) near performance recording (line 1801 and line 2035).
*   **Dashboard Parsing**:
    - Update `parseExitPnL` equivalent inside dashboard backend `/api/status` processing loop.
    - Read `exit_pnl_pct` and `exit_pnl_usd` directly if present; fall back to log parsing only for historical compatibility.

### R6: PM2 Errored State Alert Banner
*   **Concept**: Detect stopped or errored PM2 processes and display an alert banner.
*   **Detection**: The dashboard backend already parses PM2 process statuses from `pm2 jlist` and exposes them in `/api/status`.
*   **UI Banner**:
    - Add a container `div#errored-state-banner` at the top of the container, styled with an amber warning/danger background.
    - If `meridian` status is not `online` (e.g. `stopped`, `errored`, or not found), display the banner prominently with a "Restart" button that triggers `POST /api/restart-process` for the bot.

### R7: Performance Idle Constraints
*   **Concept**: Pause animations and slow down polling when the browser tab is hidden or when the user is idle.
*   **Idle & Visibility Controller**:
    - In `public/app.js`, track visibility state (`document.visibilityState`) and user activity (resetting a 5-minute timeout on activity events like mousemove, mousedown, keydown, scroll, click).
    - If the tab is hidden, suspend JS polling entirely. If the user is idle, slow down polling from 3 seconds to 30 seconds.
    - Add a `.user-idle` or `.tab-hidden` class to `document.body` when idle/hidden.
*   **Animation Suspension**:
    - Add CSS rules to `style.css`:
      ```css
      body.user-idle *,
      body.tab-hidden * {
        animation-play-state: paused !important;
        transition-duration: 0s !important;
      }
      ```
    - This suspends all running CSS animations and transitions instantly to preserve CPU and GPU cycles.

---

## 3. Evidence Chain

1.  **Bot core schedule and lifecycle**: `index.js` contains the cron schedules on lines 748-847.
2.  **State file schema and updates**: `state.js` loads and saves `state.json` via helper methods on lines 31-50, and records position updates via exports like `recordClose` (lines 189-199).
3.  **PnL caching and fetch logic**: Authoritative exit PnL for closed positions is fetched from Meteora APIs in `tools/dlmm.js` lines 1734-1751 (relay close) and lines 1981-2012 (local close).
4.  **Dashboard API routes and server details**: `index.js` of the dashboard serves the backend on port `3002` (lines 6-7) and implements routes `/api/status` (lines 91-362), `/api/logs/agent` (lines 399-424), and `/api/restart-process` (lines 382-397).
5.  **UI update rates**: `app.js` establishes a 3-second refresh loop on line 47 using `setInterval(fetchStatus, 3000)`.
