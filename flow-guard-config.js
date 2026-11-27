/**
 * Operator-only setter of the flow guard kill switch `management.flowGuardMode` (2026-11-27,
 * review round 3). Reached only from POST /command/set-flow-guard `{ "mode": "armed" | "off" }`
 * — never from update_config, so no model can turn the guards back on.
 *
 * Same discipline as the skimmer's operator settings (tools/transfer.js applySkimSetting): the
 * FILE first (temp + rename), memory only after it succeeded — except "off", which always
 * takes effect in memory and, when the write failed, sets the off latch so a reload of the stale
 * file cannot re-arm the guards (config.js reloadScreeningThresholds honours the latch).
 */
import fs from "fs";
import { config } from "./config.js";
import { log } from "./logger.js";
import { dataPath } from "./repo-root.js";
import { setFlowGuardOffLatch } from "./flow-guard.js";

export function applyFlowGuardMode(mode, { userConfigPath = dataPath("user-config.json") } = {}) {
  if (mode !== "armed" && mode !== "off") return { persisted: false, inMemory: false, error: new Error("mode must be armed or off") };
  config.management ??= {};
  let error = null;
  try {
    let uc = {};
    if (fs.existsSync(userConfigPath)) {
      try { uc = JSON.parse(fs.readFileSync(userConfigPath, "utf8")); } catch (e) { throw new Error(`user-config.json unreadable: ${e.message}`); }
    }
    uc.flowGuardMode = mode;
    const tmp = `${userConfigPath}.flowguard.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(uc, null, 2));
    fs.renameSync(tmp, userConfigPath);
  } catch (e) {
    error = e;
  }
  if (!error) {
    config.management.flowGuardMode = mode;
    setFlowGuardOffLatch(false);
    log("flow_guard", `[FLOW_GUARD] operator set flowGuardMode = ${mode}`);
    return { persisted: true, inMemory: true };
  }
  if (mode === "off") {
    config.management.flowGuardMode = "off";
    setFlowGuardOffLatch(true);
    log("flow_guard_warn", `[FLOW_GUARD] operator turned the flow guards OFF but user-config.json could not be written (${error.message}) — off in memory, latched against reloads`);
    return { persisted: false, inMemory: true, error };
  }
  log("flow_guard_warn", `[FLOW_GUARD] operator setting flowGuardMode=armed not applied — user-config.json could not be written (${error.message})`);
  return { persisted: false, inMemory: false, error };
}
