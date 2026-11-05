import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Absolute path to the Meridian repo root — stable under PM2, npm start, and CLI. */
export const REPO_ROOT = __dirname;

/**
 * Code, secrets and logs: .env / .envrypt, logs/, .heartbeat, .force-sync,
 * scripts, *.example.json. Always the repo root.
 */
export function repoPath(...segments) {
  return path.join(REPO_ROOT, ...segments);
}

function resolveDataRoot() {
  const dir = process.env.MERIDIAN_DATA_DIR;
  if (!dir) return REPO_ROOT;
  const abs = path.resolve(dir);
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/**
 * Directory that holds the persisted data files (state.json, the JSON doc
 * stores, user-config.json, …). Defaults to the repo root (production); the
 * test runner points MERIDIAN_DATA_DIR at a fresh temp dir per test file so
 * tests never read or write the repo's own state.
 */
export const DATA_ROOT = resolveDataRoot();

export function dataPath(...segments) {
  return path.join(DATA_ROOT, ...segments);
}
