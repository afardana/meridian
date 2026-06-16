# Project: Meridian Dashboard & Bot Enhancements

## Architecture
- **Meridian Bot (`/Users/Angga/Repos/meridian`)**: Node.js ReAct bot running in a PM2 loop. Connects to Solana RPC and Meteora DLMM pools. Persists trading state to `state.json` and snapshots to `pool-memory.json`.
- **Meridian Dashboard (`/Users/Angga/Repos/meridian-dashboard`)**: Express.js server on port 3002. Serves static frontend from `/public` directory. Communicates with the bot via files in `/opt/meridian` (on VM) or local symlinked paths (for testing).

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | Exploration & Design | Analyze codebases and design R1-R7 integration. | None | DONE |
| 2 | Bot Logic (R2 & R5) | Implement structured PnL serialization and hourly balance logging. | M1 | DONE |
| 3 | Dashboard APIs (R1, R3, R6) | Implement Force Sync backend endpoint, log rotation API, and PM2 status. | M1 | DONE |
| 4 | Dashboard UI (R1-R4, R6, R7) | Build frontend components: Force Sync, Yield Chart, Log selector calendar, Price-range bar, alert banner, and idle constraints. | M2, M3 | DONE |
| 5 | Git Commit, Push & VM Deploy | Push code to private repo, deploy on VM, restart PM2. | M4 | DONE |

## Interface Contracts
### Bot ↔ Dashboard IPC (R1: Force Sync)
- **Signal File**: `.force-sync` file placed in the repository root folder.
- **Bot Behavior**: 3-second lightweight poller checks for `.force-sync`. If found, deletes it and runs `runManagementCycle()`.
- **Dashboard Behavior**: `POST /api/force-sync` writes `.force-sync`, waits up to 10 seconds for deletion, then returns status.

### Historical Balance Log Schema (R2)
- **Path**: `balance-history.json`
- **Item Schema**:
  ```json
  {
    "ts": "ISOString",
    "idleSol": 1.25,
    "deployedSol": 0.45,
    "totalSol": 1.70,
    "solPriceUsd": 72.83,
    "totalUsd": 123.81
  }
  ```

### State Serialization Schema (R5)
- **Path**: `state.json`
- **Fields added to closed position object**:
  - `exit_pnl_pct` (number, e.g. 15.4)
  - `exit_pnl_usd` (number, e.g. 23.12)
