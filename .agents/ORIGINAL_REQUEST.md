# Original User Request

## 2026-06-16T04:07:34Z

Implement all gaps, opportunities for improvement (OFIs), and nice-to-have features for the Meridian Dashboard as outlined in the analysis report. All modifications must be pushed to your private GitHub repository and deployed to the Oracle VM.

Working directory: /Users/Angga/Repos
Integrity mode: development

## Requirements

### R1. Live Force Sync Button
Add a "Force Sync" UI action to the dashboard. Triggering it must execute an immediate on-chain position scan (bypassing the 3-minute cached loop) and update the dashboard state. Include visual feedback (e.g. loading spinner/disabled button) during the execution.

### R2. Timeseries Yield & Balance Chart
Log historical SOL and USD balances (Total, Idle, and Deployed) hourly to a local file (e.g., `balance-history.json`). Render a sleek, premiumTimeseries yield/balance line chart using a library like Chart.js or Chartist. Let the team choose the best dashboard layout placement.

### R3. Log Rotation Date Selector
Update the dashboard logs terminal to support a dropdown menu populated with the last 7 calendar days. Selecting a date must fetch and render that specific day's agent log file (`agent-YYYY-MM-DD.log`).

### R4. Active Positions Price & Range Visualizer
Add a visual horizontal gauge/bar for active positions showing where the current asset price sits relative to the lower/upper DLMM bin bounds, with a color indicator (e.g. green if in-range, red/yellow if out-of-range).

### R5. Structured State Serialization
Modify the main trading bot's exit/closure logic (in the `meridian` codebase) to write structured `exit_pnl_pct` and `exit_pnl_usd` numerical fields directly to `state.json` when closing positions, instead of storing it solely in text note arrays.

### R6. PM2 Errored State Alert Banner
If the main `meridian` PM2 process changes status from `online` to `stopped` or `errored`, render a prominent warning alert banner on the dashboard UI.

### R7. Performance Idle Constraints
Strictly ensure that no DOM elements or CSS properties run infinite pulse, glow, or translation animations when in an idle state. Active transitions, hover states, and entering/exiting page motions are allowed.

---

## Acceptance Criteria

### API Endpoints & State
- [ ] `POST /api/force-sync` successfully runs on-chain position query and returns a success response.
- [ ] `GET /api/logs/agent?date=YYYY-MM-DD` responds with the specified day's log content or returns a clear error if the file doesn't exist.
- [ ] `/api/status` returns `totalBalanceSol`, `deployedSol`, and `balanceSol` properly calculated.
- [ ] Closed positions in `state.json` serialize the new numerical `exit_pnl_pct` and `exit_pnl_usd` fields directly.

### Frontend UI
- [ ] Force Sync button displays a loading spinner and disables click events when fetching.
- [ ] Timeseries yield chart displays historical SOL and USD balances.
- [ ] Active positions rows render price-range bar visualizers.
- [ ] Log selector dropdown displays the past 7 days and updates the console log terminal when changed.
- [ ] Stopped/errored PM2 state displays an alert banner.
- [ ] CSS files contain no keyframe animations running infinitely on idle indicators.

### Repository & Deployment
- [ ] All code changes are committed and pushed to `afardana/meridian-dashboard`.
- [ ] All code changes are deployed on the Oracle VM and restarted under PM2.
