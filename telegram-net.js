import net from "node:net";

// Node's happy-eyeballs (autoSelectFamily) gives each address 250 ms to finish the TCP
// handshake. api.telegram.org resolves to an A and an AAAA record while the VM has no
// IPv6 route (the AAAA attempt fails at once with ENETUNREACH), so the single IPv4
// attempt is the only one left and a handshake slower than 250 ms ends as
// "fetch failed" (AggregateError ETIMEDOUT|ENETUNREACH). 2026-10-08: the path to
// Telegram flipped between a 157 ms and a 322 ms round trip, and every connect on the
// slow path (about a third of them) was refused by the 250 ms limit.
export const TELEGRAM_CONNECT_ATTEMPT_TIMEOUT_MS = 3000;

export function tuneTelegramNetwork({
  timeoutMs = TELEGRAM_CONNECT_ATTEMPT_TIMEOUT_MS,
  setter = net.setDefaultAutoSelectFamilyAttemptTimeout,
  getter = net.getDefaultAutoSelectFamilyAttemptTimeout,
} = {}) {
  if (typeof setter !== "function") return null; // Node < 18.18: nothing to tune
  const current = typeof getter === "function" ? getter() : null;
  // Only ever raise the limit; a deployment that already chose a longer one keeps it.
  if (Number.isFinite(current) && current >= timeoutMs) return current;
  setter(timeoutMs);
  return timeoutMs;
}

// "fetch failed" hides the real reason in err.cause (undici) and, for dual-stack
// connects, in err.cause.errors (AggregateError). Returns e.g.
// "fetch failed [ETIMEDOUT|ENETUNREACH]" so the log line names the cause.
export function describeFetchError(e) {
  const message = e?.message || String(e);
  const cause = e?.cause;
  if (!cause) return message;
  const codes = Array.isArray(cause.errors) && cause.errors.length
    ? cause.errors.map((x) => x?.code || x?.message).filter(Boolean)
    : [cause.code || cause.name || cause.message].filter(Boolean);
  const unique = [...new Set(codes)];
  return unique.length ? `${message} [${unique.join("|")}]` : message;
}
