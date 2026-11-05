#!/usr/bin/env node
/**
 * Test runner: every test/*.test.js file runs as its own `node --test <file>`
 * child with a fresh, empty data directory (MERIDIAN_DATA_DIR), so tests never
 * read or write the repo's own state.json / doc-store JSON files / user-config.json
 * and parallel files cannot race on one shared state.json.
 *
 *   node scripts/run-tests.js                 # all test/*.test.js, 4 at a time
 *   node scripts/run-tests.js --jobs 8        # concurrency
 *   node scripts/run-tests.js straddle        # files whose name contains "straddle"
 *   node scripts/run-tests.js test/a.test.js  # explicit files
 *
 * Children get PERSIST_BACKEND=json and DRY_RUN=true. Caveat: envcrypt.js loads
 * .env with override:true, so a .env in the repo root wins over these values —
 * the runner warns when one exists.
 *
 * Node built-ins only.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = path.join(REPO_ROOT, "test");
const rel = (f) => (f.startsWith(REPO_ROOT + path.sep) ? path.relative(REPO_ROOT, f) : f);

function parseArgs(argv) {
  let jobs = 4;
  const selectors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--jobs" || a === "-j") {
      jobs = Number(argv[++i]);
    } else if (a.startsWith("--jobs=")) {
      jobs = Number(a.slice("--jobs=".length));
    } else if (a === "--help" || a === "-h") {
      console.log("usage: node scripts/run-tests.js [--jobs N] [file | substring ...]");
      process.exit(0);
    } else {
      selectors.push(a);
    }
  }
  if (!Number.isInteger(jobs) || jobs < 1) {
    console.error(`--jobs must be a positive integer (got ${jobs})`);
    process.exit(2);
  }
  return { jobs, selectors };
}

function discover(selectors) {
  const all = fs.readdirSync(TEST_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .sort()
    .map((f) => path.join(TEST_DIR, f));
  if (selectors.length === 0) return all;
  const picked = new Set();
  for (const sel of selectors) {
    const asPath = path.resolve(process.cwd(), sel);
    if (fs.existsSync(asPath) && fs.statSync(asPath).isFile()) {
      picked.add(asPath);
      continue;
    }
    const hits = all.filter((f) => path.basename(f).includes(sel));
    if (hits.length === 0) {
      console.error(`no test file matches "${sel}"`);
      process.exit(2);
    }
    hits.forEach((f) => picked.add(f));
  }
  return [...picked].sort();
}

function runOne(file) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-test-"));
  const env = {
    ...process.env,
    MERIDIAN_DATA_DIR: dataDir,
    PERSIST_BACKEND: "json",
    DRY_RUN: "true",
  };
  // A node:test parent passes these to children; never let a nested run inherit them.
  delete env.NODE_TEST_CONTEXT;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", file], { cwd: REPO_ROOT, env });
    let output = "";
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    const finish = (code, signal) => {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
      resolve({ file, code, signal, output, seconds: (Date.now() - started) / 1000 });
    };
    child.on("error", (err) => { output += `\n[run-tests] spawn failed: ${err.message}\n`; finish(1, null); });
    child.on("close", finish);
  });
}

async function main() {
  const { jobs, selectors } = parseArgs(process.argv.slice(2));
  if (fs.existsSync(path.join(REPO_ROOT, ".env"))) {
    console.warn(
      "WARNING: .env exists in the repo root. envcrypt.js loads it with override:true, so its\n" +
      "         PERSIST_BACKEND / DRY_RUN / RPC values override what this runner sets for the tests.\n"
    );
  }
  const files = discover(selectors);
  const t0 = Date.now();
  const results = [];
  let next = 0;
  const width = String(files.length).length;

  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      const r = await runOne(file);
      results.push(r);
      const ok = r.code === 0;
      const n = String(results.length).padStart(width);
      const why = ok ? "" : r.signal ? ` (signal ${r.signal})` : ` (exit ${r.code})`;
      console.log(`[${n}/${files.length}] ${ok ? "pass" : "FAIL"} ${rel(file)}  ${r.seconds.toFixed(1)}s${why}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));

  const failed = results.filter((r) => r.code !== 0).sort((a, b) => a.file.localeCompare(b.file));
  for (const r of failed) {
    console.log(`\n${"=".repeat(78)}\nFAIL ${rel(r.file)}\n${"=".repeat(78)}`);
    console.log(r.output.trimEnd());
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} files in ${secs}s (jobs ${jobs})`);
  if (failed.length) {
    console.log("failed:\n" + failed.map((r) => `  ${rel(r.file)}`).join("\n"));
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
