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
      },
    },
    // {
    //   name: "meridian-monitor",
    //   script: path.join(repoRoot, "scripts/antigravity_monitor.py"),
    //   cwd: repoRoot,
    //   interpreter: "python3",
    //   instances: 1,
    //   exec_mode: "fork",
    //   cron_restart: "0 */4 * * *",
    //   autorestart: false,
    //   merge_logs: true,
    //   time: true,
    // },
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
      name: "meridian-status-generator",
      script: path.join(repoRoot, "scripts/status_generator.js"),
      cwd: repoRoot,
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      cron_restart: "*/30 * * * *", // run every 30 minutes
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