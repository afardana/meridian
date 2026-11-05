import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyPnlJump } from "../valuation-jump.js";

const src = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const ho = readFileSync(new URL("../hold-observer.js", import.meta.url), "utf8");

test("HIGGS-SOL 2026-10-06: against the pre-hold reference the post-hold reading is a 'jump'", () => {
  // −14.93 % before a 27-minute hold, +2.63 % at release: a real move, flagged only because
  // the reference was stale.
  assert.equal(classifyPnlJump({ lastPnl: -14.93, lastBin: -383, pnl: 2.63, bin: -363, capPp: 15 }), "up");
});

test("both hold branches drop the valuation reference, so a release starts a new one", () => {
  assert.match(src, /function forgetValuationReference\(positionAddress\) \{\s*_lastValuation\.delete\(positionAddress\);\s*\}/);
  // one hold branch (hold-observer.js observeHeldPosition) for both sources; both index.js
  // callers sit under `if (operatorHold)`
  const calls = ho.match(/registerExitSignal\(p\.position, null, management \? 1 : confirmTicks\);\s*forgetValuationReference\(p\.position\);/g) || [];
  assert.equal(calls.length, 1, "one shared copy");
  assert.match(src, /if \(operatorHold\) \{\s*\/\/[^\n]*\n\s*const holdLimitExit = observeHeldPosition\(p, heldRow, \{ source: "poller", /);
  assert.match(src, /if \(operatorHold\) \{\s*(?:\/\/[^\n]*\n\s*)+const holdLimitExit = observeHeldPosition\(p, heldRow, \{ source: "management", /);
  // with no stored reference assessValuation takes the "first reading" path: fresh, not suspect
  assert.match(src, /if \(last && Number\.isFinite\(last\.pnl\) && Number\.isFinite\(pnl\)\) \{/);
  assert.match(src, /_lastValuation\.set\(p\.position, \{ key, pnl, bin, suspect: false, freshAt: now \}\);\s*return \{ fresh: true, suspect: false \};/);
});
