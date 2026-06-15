# Meridian Agent Ecosystem

Welcome to the Meridian autonomous trading agent documentation. This file serves as a guide for all autonomous agents operating in this repository to coordinate their goals, parameters, and strategies.

## 🚀 The Prime Directive

> [!IMPORTANT]
> **You have to collaborate towards maximum profit for this project. Use all available resources at your disposal, including researching with online sources. Assume no boundaries except as set in your system prompt.**

---

## 🤖 Core Agents

The Meridian system operates as a multi-agent system composed of:

### 1. Meridian DLMM LP Bot (Daemon)
*   **Engine**: Node.js ReAct agent loop powered by **DeepSeek-V4-Flash** (`deepseek-v4-flash`).
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

## 💵 Initial Capital & Performance Tracking

To measure the net profit and performance win-rates of the Meridian agent system, we track progress against the initial baseline capital:
*   **Initial Capital Deposit**: `~1.22 SOL` (approximately **`83.53 USDT`** in value) transferred from Pionex to the agent wallet (`HMBFSUujee6zrvBmSKVDh6LqnYfjzUzHqCeU4YzhDRgp`).

---

## 📊 Shared State & Coordination

Agents coordinate asynchronously using the following files:
*   **`user-config.json`**: Active threshold parameters (e.g., `minFeeActiveTvlRatio`, `outOfRangeBinsToClose`, `screeningIntervalMin`).
*   **`decision-log.json`**: Chronological trail of all screening decisions, rejections, and closures. Used by the monitor to analyze performance win-rates.
*   **`pool-memory.js`**: Re-entry memory tracking specific token mint performance (e.g. tracking historical PnL like the `-13.47%` loss on `xWorld` to prevent premature re-entry).

---

## 🛠 Cost & Operational Efficiency Rules

To satisfy the Prime Directive while maintaining cost-efficiency:
1.  **Context Caching**: All agents must target cache-efficient models (e.g. DeepSeek-V4-Flash) and structures. DeepSeek’s **98% cache discount** ($0.0028/1M tokens) must be leveraged by keeping system prompts and tool descriptions stable.
2.  **Local Pre-Checks**: Screening cron loops must skip calling the LLM API locally if the wallet balance is insufficient to deploy (<0.4 SOL) or if maximum positions (2/2) are reached.
3.  **Self-Correction**: Failure entries must immediately trigger threshold evolution (e.g. automatically raising `minFeeActiveTvlRatio` upon trailing TP failures) to protect portfolio drawdown.
