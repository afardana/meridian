process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

// 2026-11-26: index.js used `saveBaselineState` (skimmer resolvePending wiring) without importing
// it, so the cron's "resolve pending skims" step threw ReferenceError every tick. index.js boots
// the bot and cannot be imported in a test, so this is a static check: TypeScript's checker
// (scope-aware, no type resolution: noResolve) reports every free identifier that is neither
// declared, imported nor a standard built-in (diagnostics 2304 / 2552 "Cannot find name").
// typescript is not a declared dependency (it is only present as a peer of other packages);
// without it the test is skipped, loudly.

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILES = ["index.js", "tools/transfer.js", "skim-flow.js", "skim-policy.js"];

// Node globals that the ES lib alone does not declare.
const NODE_GLOBALS = new Set([
  "process", "console", "Buffer", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "setImmediate", "clearImmediate", "fetch", "URL", "URLSearchParams", "AbortController",
  "AbortSignal", "globalThis", "structuredClone", "performance", "TextEncoder", "TextDecoder",
  "queueMicrotask", "__dirname", "__filename", "require", "module", "exports",
]);

let ts = null;
try { ts = createRequire(import.meta.url)("typescript"); } catch { /* skipped below */ }

function undefinedIdentifiers(files) {
  const prog = ts.createProgram(files.map((f) => path.join(ROOT, f)), {
    allowJs: true, checkJs: true, noEmit: true, noResolve: true, skipLibCheck: true, types: [],
    lib: ["lib.es2023.d.ts"], target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext,
  });
  const out = [];
  for (const f of files) {
    const sf = prog.getSourceFile(path.join(ROOT, f));
    for (const d of prog.getSemanticDiagnostics(sf)) {
      if (d.code !== 2304 && d.code !== 2552) continue;
      const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      const name = /Cannot find name '([^']+)'/.exec(msg)?.[1];
      if (!name || NODE_GLOBALS.has(name)) continue;
      out.push(`${f}:${sf.getLineAndCharacterOfPosition(d.start).line + 1} ${name}`);
    }
  }
  return out;
}

test("index.js and the skimmer modules reference no undefined identifier", { skip: ts ? false : "typescript not installed" }, () => {
  assert.deepEqual(undefinedIdentifiers(FILES), []);
});

test("the checker flags an undeclared identifier (the 2026-11-26 failure shape)", { skip: ts ? false : "typescript not installed" }, async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-undef-"));
  fs.writeFileSync(path.join(dir, "x.js"), 'import { a } from "./y.js";\nexport const f = () => ({ a, b: saveBaselineState });\n');
  const prog = ts.createProgram([path.join(dir, "x.js")], { allowJs: true, checkJs: true, noEmit: true, noResolve: true, skipLibCheck: true, types: [], lib: ["lib.es2023.d.ts"], module: ts.ModuleKind.ESNext });
  const names = prog.getSemanticDiagnostics(prog.getSourceFile(path.join(dir, "x.js"))).filter((d) => d.code === 2304).map((d) => /'([^']+)'/.exec(ts.flattenDiagnosticMessageText(d.messageText, "\n"))[1]);
  assert.deepEqual(names, ["saveBaselineState"]);
  fs.rmSync(dir, { recursive: true, force: true });
});
