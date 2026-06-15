import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..");

// Load environment variables from repo root .env
dotenv.config({ path: path.join(repoRoot, ".env") });

async function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error("Telegram configuration missing.");
    return;
  }
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000), // safety length limit
        parse_mode: "Markdown"
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error(`Telegram response error: ${errText}`);
    }
  } catch (e) {
    console.error(`Failed to send Telegram message: ${e.message}`);
  }
}

function runGit(args) {
  try {
    return execSync(`git ${args}`, { cwd: repoRoot }).toString().trim();
  } catch (e) {
    console.error(`Git command failed (git ${args}):`, e.message);
    throw e;
  }
}

async function main() {
  console.log("Checking for upstream repo updates...");
  
  try {
    // 1. Fetch latest changes from remote
    runGit("fetch origin");
    
    // 2. Identify current tracking branch
    const branch = runGit("branch --show-current");
    if (!branch) {
      console.log("Not currently on any branch. Skipping sync.");
      return;
    }
    
    // Check if remote tracking branch exists
    let remoteBranchExists = false;
    try {
      runGit(`rev-parse --verify origin/${branch}`);
      remoteBranchExists = true;
    } catch {
      console.log(`Remote tracking branch origin/${branch} does not exist.`);
    }
    
    if (!remoteBranchExists) return;

    // 3. Compare local and remote hashes
    const localHash = runGit("rev-parse HEAD");
    const remoteHash = runGit(`rev-parse origin/${branch}`);
    
    if (localHash === remoteHash) {
      console.log(`Up to date with origin/${branch} at commit ${localHash.slice(0, 7)}.`);
      return;
    }
    
    // Check relationship
    const mergeBase = runGit(`merge-base HEAD origin/${branch}`);
    const isBehind = mergeBase === localHash;
    const isAhead = mergeBase === remoteHash;
    
    if (isBehind) {
      // Get commit list
      const commits = runGit(`log HEAD..origin/${branch} --oneline`);
      const uncommitted = runGit("status --porcelain");
      
      const commitListStr = commits
        .split("\n")
        .map((c) => `• \`${c.slice(0, 7)}\` ${c.slice(8)}`)
        .join("\n");
        
      if (uncommitted) {
        console.log("Upstream updates available, but uncommitted local changes prevent automatic pull.");
        await sendTelegramMessage(
          `🔔 *Upstream Updates Available*\n\n` +
          `The repository is behind \`origin/${branch}\` by ${commits.split("\n").length} commit(s).\n\n` +
          `*New Commits:*\n${commitListStr}\n\n` +
          `⚠️ *Local uncommitted modifications detected.* Automatic pull skipped to avoid conflicts. Run \`/gitpull\` or log in to the VM to sync manually.`
        );
      } else {
        console.log("Upstream updates available. Performing automatic sync...");
        await sendTelegramMessage(
          `🔄 *Auto-Syncing with Upstream*\n\n` +
          `New updates found on \`origin/${branch}\`:\n${commitListStr}\n\nPulling changes and rebuilding...`
        );
        
        try {
          runGit("pull");
          console.log("Successfully pulled changes. Running npm install...");
          execSync("npm install", { cwd: repoRoot, stdio: "inherit" });
          
          await sendTelegramMessage(
            `✅ *Sync Complete*\n\n` +
            `Successfully pulled changes and updated dependencies.\n` +
            `🔄 *Restarting PM2 meridian daemon...*`
          );
          
          // Restart PM2 meridian daemon
          execSync("pm2 restart meridian --update-env", { stdio: "inherit" });
          console.log("PM2 meridian process restarted.");
        } catch (pullError) {
          console.error("Auto-pull failed:", pullError.message);
          await sendTelegramMessage(
            `❌ *Auto-Sync Failed*\n\n` +
            `An error occurred during git pull or package update:\n` +
            `\`${pullError.message}\`\n\nPlease check manually.`
          );
        }
      }
    } else if (isAhead) {
      console.log(`Local branch is ahead of origin/${branch}. No sync needed.`);
    } else {
      console.log(`Local and remote branches have diverged. Manual resolution required.`);
      await sendTelegramMessage(
        `⚠️ *Git Branches Diverged*\n\n` +
        `The local branch \`${branch}\` and \`origin/${branch}\` have diverged. Manual git merge or rebase is required.`
      );
    }
  } catch (error) {
    console.error("Error running syncer:", error);
  }
}

main();
