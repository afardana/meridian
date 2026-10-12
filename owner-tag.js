// owner-tag.js — who opened a position: the bot, or the operator (2026-10-12).
//
// One mapping for every Telegram output, from the existing `adopted` flag on the tracked
// position / perf record: true = the operator opened it and the bot adopted it ("Manual"),
// anything else = the bot deployed it ("Bot"). No rule reads this.
//
// A record WITHOUT the field is the bot's: the perf record is written with
// `adopted: tracked.adopted || undefined`, so a bot deploy never carries the key (323 of the
// 472 records closed 09-20 → 10-11 have none), and a tracked position always has it
// (false for a deploy). Only records closed before 2026-08-22, when the field did not exist,
// cannot be told apart — they read as the bot's too.
// A bot deploy that landed despite a reported failure is recovered through the adoption path
// (adopted = true, strategy_source "bot_recovery" / "bot_deploy_recovered"): still the bot's.

const BOT = Object.freeze({ owner: "bot", emoji: "🤖", label: "Bot" });
const MANUAL = Object.freeze({ owner: "manual", emoji: "🧑", label: "Manual" });

/** @returns {{ owner: "bot"|"manual", emoji: string, label: string }} */
export function ownerTag(posOrRecord) {
  const x = posOrRecord || {};
  if (x.adopted !== true) return BOT;
  if (/^bot_(recovery|deploy_recovered)$/.test(String(x.strategy_source || ""))) return BOT;
  return MANUAL;
}

export const isManualOwner = (x) => ownerTag(x).owner === "manual";

/**
 * "🤖 QI-SOL" / "🧑 CRAWL-SOL". `owner` is a position or record; `null`/`undefined` means the
 * caller does not know which position this is about (a hand swap, a wallet token) — no tag.
 * The pair is returned as given: escape it before or after, the emoji needs none.
 */
export function tagPair(pair, owner) {
  return owner == null ? String(pair) : `${ownerTag(owner).emoji} ${pair}`;
}
