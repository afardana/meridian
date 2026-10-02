import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// 2026-10-02: the hourly sync job restarted meridian with `pm2 restart meridian --update-env`
// from inside its own PM2 process, whose environment carries the job's definition — meridian
// inherited `cron_restart: "0 * * * *"` and restarted every hour until it was re-registered.
const src = fs.readFileSync(new URL("../scripts/repo_syncer.js", import.meta.url), "utf8");

test("the syncer never restarts an app with --update-env", () => {
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(code, /--update-env/);
  assert.equal((code.match(/restartPm2App\(/g) || []).length, 3, "helper + the two restart sites");
  assert.match(code, /execSync\(`pm2 restart \$\{name\}`, \{ stdio: "inherit", env: pm2SafeEnv\(\) \}\)/);
});

test("PM2's lowercase definition keys are stripped from the restart environment", () => {
  const body = src.slice(src.indexOf("export function pm2SafeEnv"), src.indexOf("function restartPm2App"));
  const pm2SafeEnv = new Function(`${body.replace("export function", "function")}; return pm2SafeEnv;`)();
  const out = pm2SafeEnv({ PATH: "/usr/bin", HOME: "/home/angga", PM2_HOME: "/home/angga/.pm2", cron_restart: "0 * * * *", autorestart: "false", name: "meridian-syncer", exec_mode: "fork_mode" });
  assert.deepEqual(out, { PATH: "/usr/bin", HOME: "/home/angga", PM2_HOME: "/home/angga/.pm2" });
});
