import { test } from "node:test";
import assert from "node:assert/strict";
import { tuneTelegramNetwork, describeFetchError, TELEGRAM_CONNECT_ATTEMPT_TIMEOUT_MS } from "../telegram-net.js";

test("describeFetchError names the dual-stack causes behind 'fetch failed'", () => {
  const cause = Object.assign(new AggregateError([{ code: "ETIMEDOUT" }, { code: "ENETUNREACH" }], ""), { code: undefined });
  const e = Object.assign(new TypeError("fetch failed"), { cause });
  assert.equal(describeFetchError(e), "fetch failed [ETIMEDOUT|ENETUNREACH]");
});

test("describeFetchError uses a single cause code, dedupes, and tolerates no cause", () => {
  assert.equal(describeFetchError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })), "fetch failed [UND_ERR_CONNECT_TIMEOUT]");
  const dup = Object.assign(new Error("fetch failed"), { cause: { errors: [{ code: "ECONNRESET" }, { code: "ECONNRESET" }] } });
  assert.equal(describeFetchError(dup), "fetch failed [ECONNRESET]");
  assert.equal(describeFetchError(new Error("boom")), "boom");
  assert.equal(describeFetchError("str"), "str");
});

test("tuneTelegramNetwork raises a 250 ms limit, never lowers a longer one", () => {
  let set = null;
  assert.equal(tuneTelegramNetwork({ getter: () => 250, setter: (v) => { set = v; } }), TELEGRAM_CONNECT_ATTEMPT_TIMEOUT_MS);
  assert.equal(set, TELEGRAM_CONNECT_ATTEMPT_TIMEOUT_MS);
  set = null;
  assert.equal(tuneTelegramNetwork({ getter: () => 10000, setter: (v) => { set = v; } }), 10000);
  assert.equal(set, null);
  assert.equal(tuneTelegramNetwork({ setter: null }), null);
});
