const path = require("path");

const repoRoot = __dirname;

module.exports = {
  apps: [
    {
      name: "meridian",
      script: path.join(repoRoot, "index.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 10000,
      max_restarts: 10,
      min_uptime: "10s",
      max_memory_restart: "512M",
      merge_logs: true,
      time: true,
      // Always start via this file (npm run pm2:start) so cwd + script path stay pinned to the repo.
      env: {
        NODE_ENV: "production",
        LLM_MODEL: "google/gemini-3.7-flash",
        LLM_BASE_URL: "https://openrouter.ai/api/v1",
      },
    },
    // meridian-monitor (Antigravity agy audit, every 4h) RETIRED 2026-07-05: it applied
    // config changes autonomously from stale premises with no audit trail (e.g. enabled
    // crashFastPathEnabled at 16:02 bypassing its shadow-calibration rollout). Continuous
    // adaptation is owned by the native data loop instead: evolveThresholds (closed-loop,
    // self-reverting) + post-close probes//exits (plan #05) + crash telemetry (plan #04).
    // scripts/antigravity_monitor.py is kept for MANUAL advisory runs only.
    {
      name: "meridian-syncer",
      script: path.join(repoRoot, "scripts/repo_syncer.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      cron_restart: "0 * * * *", // run every hour
      autorestart: false,
      merge_logs: true,
      time: true,
    },
    {
      name: "meridian-db-backup",
      script: path.join(repoRoot, "scripts/db_backup.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      cron_restart: "17 3 * * *", // daily at 03:17
      autorestart: false,
      merge_logs: true,
      time: true,
    },
    {
      name: "meridian-watchdog",
      script: path.join(repoRoot, "scripts/watchdog.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      restart_delay: 10000,
      max_restarts: 5,
      merge_logs: true,
      time: true,
    },
  ],
};
