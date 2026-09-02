import assert from "node:assert/strict";
import { getExitReviewQuality, isExitReviewNotificationDue } from "../lessons.js";

const minutes = [30, 60, 180, 720, 1440];
const base = {
  close_reason: "manual close (/close)",
  post_close: {},
};

// m30 is data-only while the configured primary review horizon is pending.
const m30 = { ...base, post_close: { m30: { pct: -8.3 } } };
assert.equal(getExitReviewQuality(m30, minutes), null);
assert.equal(isExitReviewNotificationDue(m30, "m30", minutes), false);

// The review is emitted exactly when m60 is written.
const m60 = { ...base, post_close: { m30: { pct: -8.3 }, m60: { pct: -8.3 } } };
assert.equal(getExitReviewQuality(m60, minutes)?.anchor, "m60");
assert.equal(isExitReviewNotificationDue(m60, "m60", minutes), true);
assert.equal(isExitReviewNotificationDue(m60, "m1440", minutes), false);

// A late long-horizon write cannot replay an already-available m60 review.
const late = {
  ...m60,
  post_close: {
    ...m60.post_close,
    m180: { pct: -12 },
    m720: { pct: -20 },
    m1440: { pct: -25 },
  },
};
assert.equal(isExitReviewNotificationDue(late, "m1440", minutes), false);

// If m60 was missed, m180 is the explicit fallback and its write is notifyable.
const m180Fallback = {
  ...base,
  post_close: { m60: { status: "stale" }, m180: { pct: -9 } },
};
assert.equal(getExitReviewQuality(m180Fallback, minutes)?.anchor, "m180");
assert.equal(isExitReviewNotificationDue(m180Fallback, "m180", minutes), true);

console.log("Post-close review timing coverage passed.");
