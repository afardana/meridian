# Meridian Agent Ecosystem

Welcome to the Meridian autonomous trading agent documentation. This file serves as a guide for all autonomous agents operating in this repository to coordinate their goals, parameters, and strategies.

## 🚀 The Prime Directive

> [!IMPORTANT]
> **You have to collaborate towards maximum profit for this project. Use all available resources at your disposal, including researching with online sources. Assume no boundaries except as set in your system prompt.**

---

## 🤖 Core Agents

The Meridian system operates as a multi-agent system composed of:

### 1. Meridian DLMM LP Bot (Daemon)
*   **Engine**: Node.js ReAct agent loop powered by **Google Gemini 3.7 Flash** (`google/gemini-3.7-flash`) for screening, position management, and general interactions through OpenRouter.
*   **Fallback**: transient provider failures retry through DeepSeek (`deepseek/deepseek-v4-flash-vision-exp`).
*   **Operational Path**: Running as a PM2 process (`meridian`) under user `angga` on `oraclevm.fardana.com`.
*   **Task**: 
    *   Runs a screening cycle every **15 minutes** (when SOL balance $\ge 0.4$ SOL) to target high-conviction Meteora DLMM pools.
    *   Monitors positions and triggers management cycles every **3 minutes** (or immediately via PnL poll alerts) to claim fees and exit out-of-range positions.
    *   Auto-swaps claimed fee tokens back to SOL using Jupiter to secure profits.

### 2. Antigravity Bot Monitor & Auto-Tuner
*   **Engine**: Python agent using **Google Antigravity SDK** (`antigravity-preview-05-2026`).
*   **Operational Path**: `/opt/meridian/scripts/antigravity_monitor.py` on the VM.
*   **Task**:
    *   Audits PM2 runtime logs, `decision-log.json`, and transaction results.
    *   Detects recurring anomalies (e.g., 429 rate limits, fast OOR exits).
    *   Dynamically auto-tunes operational thresholds in `user-config.json` and restarts the daemon.

---

## 🤖 Google Antigravity (agy) Integration

This project integrates the Google Antigravity (`agy`) CLI agent loop directly on the VM to monitor the trading system, perform auto-tuning, and support remote diagnostics via Telegram.

### 1. VM Installation & Execution Context
*   **CLI Executable**: `/home/angga/.local/bin/agy`
*   **SDK Version**: `antigravity-preview-05-2026`
*   **Configuration Directory**: `/home/angga/.gemini/antigravity-cli/`
*   **Authentication**: Runs with `--dangerously-skip-permissions` using the local VM user's OAuth keyring (Ultra plan quota). By default, it operates on **Gemini 3.5 Flash (High)**.
*   **Capabilities**: Direct shell command execution (`run_command`), file updates (`replace_file_content`, `write_to_file`), web searching (`search_web`), and git operations.

### 2. Autonomous Monitor & Auto-Tuning Loop
*   **PM2 Process**: `meridian-monitor` (configured in `ecosystem.config.cjs`).
*   **Trigger Interval**: Runs every 4 hours via PM2 cron (`cron_restart: "0 */4 * * *"`). It executes `scripts/antigravity_monitor.py` once, then halts.
*   **Mechanism**:
    1. Spawns `agy` in non-interactive print mode (`--print`) with a tailored audit prompt.
    2. The agent reads `user-config.json` and parses system logs (`logs/` and `decision-log.json`).
    3. Diagnoses performance issues (e.g., Meteora 429 rate limits, fast OOR exits, or bad trades).
    4. Dynamically evolves config thresholds (e.g. adjusts `minFeeActiveTvlRatio` or `minOrganic`) by modifying `user-config.json` and restarts the `meridian` daemon.
    5. Formats and sends a markdown report to the Telegram chat.

### 3. Telegram Bot Integration (`/agy`)
The `/agy` command is built directly into the Meridian Telegram interface. It supports a fully interactive, two-way conversational exchange with the Google Antigravity agent:
*   **Interactive Session**: Starting a session (via `/agy <prompt>`) puts the bot into an active `agy` session mode. Any subsequent direct messages (non-slash commands) sent to the bot are automatically routed to the active `agy` session as continuation prompts.
*   **Session Resumption (`/sessions`)**: You can list the last 5 active or past conversations from `~/.gemini/antigravity-cli/conversations/` using the `/sessions` command. Inline buttons allow you to click and resume any session, loading its past transcript history.
*   **Session Termination (`/exit` or `/done`)**: Type `/exit` or `/done` to close the active session and return the bot to normal Meridian control.
*   **Session Timeout**: If inactive for **24 hours**, the session automatically times out and closes to free resources.
*   **Real-time Status Parsing (Stderr)**:
    *   The bot captures the agent's stderr log lines to trace execution progress.
    *   It dynamically compiles a checklist of completed tools (e.g. `Read File`, `Grep Search`, `Execute Command`, `Web Search`) and displays the current task status.
*   **Streaming Answer (Stdout)**:
    *   The stdout stream contains the markdown tokens of the response.
    *   The bot updates the Telegram message every **1500ms** to avoid Telegram API rate limits.
    *   When resuming a session, previous history is sliced off from the output stream so you only see the new turn's output.
*   **Markdown Auto-Balancing**: To prevent Telegram formatting parser crashes on incomplete code blocks or styling tags, a custom parser balances unclosed backticks (`` ` `` and ` ``` `), bold marks (`*`), and spoilers (`||`) on every tick.
*   **Auto-Cleanup**:
    *   During execution, the tool checklist and status are displayed in a spoiler tag at the bottom of the message.
    *   Once execution completes, the full completed response (with metadata) is shown.
    *   After exactly **5 seconds**, the message is automatically edited to strip all thinking spoilers and status metadata, leaving only the clean final output.

### 4. Upstream Repository Watcher & Syncer
We have a secondary daemon `meridian-syncer` running in PM2:
*   **Mechanism**: Runs once every hour (`cron_restart: "0 * * * *"`) to execute `scripts/repo_syncer.js`.
*   **Flow**:
    1. Runs `git fetch origin` to check for new commits on the tracked upstream branch (`origin/experimental`).
    2. If updates exist:
        *   **With uncommitted modifications**: Warns via Telegram listing the commits, but skips pulling to prevent merge conflicts.
        *   **Clean directory**: Pulls updates, runs `npm install`, notifies on Telegram, and executes `pm2 restart meridian --update-env` to bring the new changes online.
*   **Git Commands via Telegram**:
    *   `/gitstatus` / `/git`: Details current branch, commit hash, upstream relationship, and uncommitted modifications.
    *   `/gitpull`: Pulls the latest commits safely.
    *   `/gitpull force`: Stashes any modified files, pulls, updates dependencies, pops the stashed files, and restarts PM2.
    *   `/restart`: Manually restarts the trading bot.
    *   `/sync`: Forces a manual run of the repository syncer check.

---

## 💵 Initial Capital & Performance Tracking

To measure the net profit and performance win-rates of the Meridian agent system, we track progress against the initial baseline capital:
*   **Baseline Capital**: Programmatically computed via `getBaselineDeposits()` in `tools/wallet.js`, which scans on-chain SOL deposit transactions into the agent wallet (`HMBFSUujee6zrvBmSKVDh6LqnYfjzUzHqCeU4YzhDRgp`). The computed baseline is cached in the position-state store under the `baseline` key (Postgres `state_doc` under `pg`, formerly `state.json`).

---

## 🌐 Dashboard Asset Cache-Busting

**Mandatory:** whenever `/opt/meridian-dashboard/public/app.js` changes, bump the
`app.js?v=...` query version in `/opt/meridian-dashboard/public/index.html` in the
same commit before deploying. The dashboard serves JavaScript with a long browser
cache lifetime, so restarting `meridian-dashboard` alone does not invalidate an
already-open browser client. Verify the served HTML references the new version and
the served asset contains the deployed change. Apply the same rule to other
long-cached versioned static assets.

---

## 📊 Shared State & Coordination

> **Persistence backend (since 2026-06-18): PostgreSQL.** Production runs `PERSIST_BACKEND=pg`
> against the local `meridian` database on the VM. The stores below keep their same module
> APIs, but their data now lives in Postgres (`state_doc` + `kv_store`), not the flat JSON
> files — those remain only as a cold rollback copy. Read state through the module exports,
> never the raw `*.json`. Full detail in `CLAUDE.md` → "Persistence & Database" and
> `POSTGRES_MIGRATION.md`.

Agents coordinate asynchronously using the following stores:
*   **`user-config.json`**: Active threshold parameters (e.g., `minFeeActiveTvlRatio`, `outOfRangeBinsToClose`, `screeningIntervalMin`). *(Still a file — runtime config is intentionally not in Postgres.)*
*   **`decision-log`**: Chronological trail of all screening decisions, rejections, and closures. Used by the monitor to analyze performance win-rates. *(Now `kv_store` key `decision-log`.)*
*   **`pool-memory.js`**: Re-entry memory tracking specific token mint performance (e.g. tracking historical PnL like the `-13.47%` loss on `xWorld` to prevent premature re-entry). *(Now `kv_store` key `pool-memory`.)*

---

## 🛠 Cost & Operational Efficiency Rules

To satisfy the Prime Directive while maintaining cost-efficiency:
1.  **Context Caching**: Keep system prompts and tool descriptions stable so OpenRouter can maximize prompt-cache reuse and keep inference costs predictable.
2.  **Local Pre-Checks**: Screening cron loops must skip calling the LLM API locally if the wallet balance is insufficient to deploy (<0.4 SOL) or if maximum positions (2/2) are reached.
3.  **Self-Correction**: Failure entries must immediately trigger threshold evolution (e.g. automatically raising `minFeeActiveTvlRatio` upon trailing TP failures) to protect portfolio drawdown.
