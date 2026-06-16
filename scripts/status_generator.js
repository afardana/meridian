import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");

const STATUS_FILE = path.join(repoRoot, "monitor-status.json");

function getCommandJson(args) {
  try {
    const stdout = execSync(`node cli.js ${args}`, { cwd: repoRoot, encoding: "utf8" });
    return JSON.parse(stdout);
  } catch (err) {
    return { error: err.message };
  }
}

function getPm2Status() {
  try {
    const stdout = execSync("pm2 jlist", { encoding: "utf8" });
    const list = JSON.parse(stdout);
    return list.map(app => ({
      name: app.name,
      status: app.pm2_env.status,
      uptime: app.pm2_env.pm_uptime,
      restarts: app.pm2_env.restart_time,
      cpu: app.monit?.cpu || 0,
      memory: app.monit?.memory || 0
    }));
  } catch (err) {
    // If pm2 is not installed or errors out, fallback gracefully
    return [{ error: "PM2 not running or not found: " + err.message }];
  }
}

function getRecentDecisions() {
  const filePath = path.join(repoRoot, "decision-log.json");
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return (data.decisions || []).slice(0, 10);
  } catch (err) {
    return [];
  }
}

function getRecentLogs() {
  const logsDir = path.join(repoRoot, "logs");
  if (!fs.existsSync(logsDir)) return "";
  try {
    const files = fs.readdirSync(logsDir)
      .filter(f => f.startsWith("agent-") && f.endsWith(".log"))
      .sort();
    if (files.length === 0) return "";
    const latestLog = path.join(logsDir, files[files.length - 1]);
    const content = fs.readFileSync(latestLog, "utf8");
    const lines = content.trim().split("\n");
    return lines.slice(-20).join("\n");
  } catch (err) {
    return `Error reading logs: ${err.message}`;
  }
}

function main() {
  console.log("Generating status report...");
  const balance = getCommandJson("balance");
  const positions = getCommandJson("positions");
  const pm2 = getPm2Status();
  const decisions = getRecentDecisions();
  const logs = getRecentLogs();

  const report = {
    last_checked_at: new Date().toISOString(),
    status: Array.isArray(pm2) ? (pm2.find(app => app.name === "meridian")?.status || "offline") : "offline",
    wallet: {
      address: balance.wallet || null,
      sol: balance.sol || 0,
      sol_usd: balance.sol_usd || 0,
      usdc: balance.usdc || 0,
      total_usd: balance.total_usd || 0,
      aum: balance.aum || null,
    },
    positions: positions.positions || [],
    pm2,
    decisions,
    recent_logs: logs
  };

  fs.writeFileSync(STATUS_FILE, JSON.stringify(report, null, 2));
  console.log(`Successfully wrote status report to ${STATUS_FILE}`);
}

main();
