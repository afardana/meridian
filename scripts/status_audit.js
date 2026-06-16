import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");

function runCmd(cmd, fallback = "") {
  try {
    return execSync(cmd, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch (err) {
    return fallback || `Error running command: ${err.message}`;
  }
}

function getCommandJson(args) {
  try {
    const stdout = runCmd(`node cli.js ${args}`);
    // Strip possible bigint/warning lines before parsing JSON
    const jsonStart = stdout.indexOf("{");
    if (jsonStart === -1) throw new Error("No JSON object found");
    return JSON.parse(stdout.slice(jsonStart));
  } catch (err) {
    return { error: err.message };
  }
}

function checkDiskSpace() {
  try {
    const stdout = runCmd("df -h /");
    const lines = stdout.split("\n");
    if (lines.length > 1) {
      const parts = lines[1].split(/\s+/);
      return {
        size: parts[1],
        used: parts[2],
        avail: parts[3],
        usePct: parts[4]
      };
    }
  } catch (_) {}
  return { size: "unknown", used: "unknown", avail: "unknown", usePct: "unknown" };
}

function checkMemory() {
  try {
    const stdout = runCmd("free -h");
    const lines = stdout.split("\n");
    for (const line of lines) {
      if (line.startsWith("Mem:")) {
        const parts = line.split(/\s+/);
        return {
          total: parts[1],
          used: parts[2],
          free: parts[3],
          avail: parts[6]
        };
      }
    }
  } catch (_) {}
  return { total: "unknown", used: "unknown", free: "unknown", avail: "unknown" };
}

function auditPm2() {
  try {
    const stdout = runCmd("pm2 jlist");
    const list = JSON.parse(stdout);
    return list.map(app => ({
      name: app.name,
      status: app.pm2_env.status,
      restarts: app.pm2_env.restart_time,
      memoryMb: Math.round((app.monit?.memory || 0) / (1024 * 1024)),
      cpu: app.monit?.cpu || 0
    }));
  } catch (_) {
    return [];
  }
}

function scanLogs() {
  const logPaths = [
    path.join(process.env.HOME || "/home/angga", ".pm2/logs/meridian-error.log"),
    path.join(process.env.HOME || "/home/angga", ".pm2/logs/meridian-out.log"),
    path.join(repoRoot, "logs/agent.log") // if any local agent logs exist
  ];

  let errors = 0;
  let rateLimits = 0;
  let rpcFailovers = 0;
  let lastLines = [];

  for (const logPath of logPaths) {
    if (fs.existsSync(logPath)) {
      try {
        const content = fs.readFileSync(logPath, "utf8");
        const lines = content.trim().split("\n");
        // Count errors in the last 150 lines of each log
        const sample = lines.slice(-150);
        for (const line of sample) {
          const lower = line.toLowerCase();
          if (lower.includes("error") || lower.includes("exception") || lower.includes("failed")) errors++;
          if (lower.includes("429") || lower.includes("too many requests")) rateLimits++;
          if (lower.includes("rpc_failover") || lower.includes("failover")) rpcFailovers++;
        }
        if (logPath.endsWith("meridian-error.log")) {
          lastLines = lines.slice(-15);
        }
      } catch (_) {}
    }
  }

  return { errors, rateLimits, rpcFailovers, lastLines };
}

function main() {
  const balance = getCommandJson("balance");
  const baseline = getCommandJson("baseline");
  const positions = getCommandJson("positions");
  
  const disk = checkDiskSpace();
  const mem = checkMemory();
  const pm2 = auditPm2();
  const logStats = scanLogs();

  const totalAumSol = balance.aum?.total_sol ?? balance.sol ?? 0;
  const baselineSol = baseline.total_deposited ?? 0;
  const netSol = totalAumSol - baselineSol;
  const roiPct = baselineSol > 0 ? (netSol / baselineSol) * 100 : 0;

  console.log("# 📊 Meridian System Audit Report\n");
  console.log(`**Audit Timestamp:** ${new Date().toISOString()}\n`);

  console.log("## 💵 Financial Performance");
  console.log(`- **Baseline Deposit:** \`◎ ${baselineSol.toFixed(6)} SOL\` (${baseline.deposit_count} deposits)`);
  console.log(`- **Current AUM:** \`◎ ${totalAumSol.toFixed(6)} SOL\` ($${(balance.aum?.total_usd ?? balance.sol_usd ?? 0).toFixed(2)} USD)`);
  console.log(`- **Net Profit/Loss:** \`${netSol >= 0 ? "+" : ""}${netSol.toFixed(6)} SOL\``);
  const roiSign = roiPct >= 0 ? "+" : "";
  console.log(`- **ROI:** \`${roiSign}${roiPct.toFixed(2)}%\``);
  console.log(`- **Wallet Balance (Idle):** \`◎ ${(balance.sol ?? 0).toFixed(6)} SOL\` ($${(balance.sol_usd ?? 0).toFixed(2)} USD)`);
  console.log(`- **Active Positions:** ${positions.total_positions ?? 0}\n`);

  const statePath = path.join(repoRoot, "state.json");
  let stateJson = { positions: {} };
  if (fs.existsSync(statePath)) {
    try { stateJson = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch (_) {}
  }

  if (Array.isArray(positions.positions) && positions.positions.length > 0) {
    console.log("### Open Positions");
    console.log("| Pair | Address | In Range | Current PnL | Deployed |");
    console.log("| --- | --- | --- | --- | --- |");
    for (const pos of positions.positions) {
      const statePos = stateJson.positions?.[pos.position] || {};
      const deployedAmt = statePos.amount_sol ?? null;
      const deployedStr = deployedAmt != null ? `◎ ${deployedAmt.toFixed(4)}` : "unknown";
      console.log(`| ${pos.pair} | \`${pos.position.slice(0, 8)}...\` | ${pos.in_range ? "🟢 Yes" : "❌ No"} | ${pos.pnl_pct >= 0 ? "+" : ""}${pos.pnl_pct?.toFixed(2)}% | ${deployedStr} |`);
    }
    console.log("");
  }

  console.log("## 🔄 PM2 Process Stability");
  if (pm2.length > 0) {
    console.log("| App Name | Status | Restarts | CPU | Memory |");
    console.log("| --- | --- | --- | --- | --- |");
    for (const app of pm2) {
      const statusIcon = app.status === "online" ? "🟢" : "🔴";
      console.log(`| ${app.name} | ${statusIcon} ${app.status} | ${app.restarts} | ${app.cpu}% | ${app.memoryMb} MB |`);
    }
  } else {
    console.log("⚠️ No active PM2 processes found.");
  }
  console.log("");

  console.log("## 🖥️ VM Resource Health");
  console.log(`- **Disk Space (/)**: \`${disk.used} / ${disk.size}\` used (${disk.usePct} used, \`${disk.avail}\` available)`);
  console.log(`- **Memory**: \`${mem.used} / ${mem.total}\` used (\`${mem.avail || mem.free}\` available/free)\n`);

  console.log("## 🔍 Log Diagnostics (Last 150 Lines Count)");
  console.log(`- **Errors/Warnings:** \`${logStats.errors}\``);
  console.log(`- **429 Rate Limits:** \`${logStats.rateLimits}\``);
  console.log(`- **RPC Failovers:** \`${logStats.rpcFailovers}\``);
  
  if (logStats.lastLines.length > 0) {
    console.log("\n### Recent Error Logs");
    console.log("```text");
    for (const line of logStats.lastLines) {
      console.log(line);
    }
    console.log("```");
  }
}

main();
