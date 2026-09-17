import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "mock-key";
process.env.OLLAMA_API_KEY = "mock-key";
process.env.DRY_RUN = "true";
process.env.PERSIST_BACKEND = "json";

const {
  renderPositionsMenu,
  renderPositionActionCard,
  renderConfirmCloseCard,
} = await import("../index.js");
const { BOT_COMMANDS } = await import("../telegram.js");

test("BOT_COMMANDS conforms to Telegram command requirements", () => {
  assert.ok(Array.isArray(BOT_COMMANDS), "BOT_COMMANDS should be an array");
  assert.ok(BOT_COMMANDS.length > 0, "BOT_COMMANDS should not be empty");

  // Check that /manage is the first command in the menu
  assert.equal(BOT_COMMANDS[0].command, "manage", "manage command should be first");

  for (const cmd of BOT_COMMANDS) {
    assert.match(cmd.command, /^[a-z0-9_]{1,32}$/, `Command name '${cmd.command}' must match Telegram rules`);
    assert.ok(cmd.description.length >= 1 && cmd.description.length <= 256, `Description for '${cmd.command}' must be 1-256 chars`);
  }
});

test("renderPositionsMenu handles empty and active position lists", () => {
  // 1. Empty list
  const emptyMenu = renderPositionsMenu([]);
  assert.ok(emptyMenu.text.includes("No open positions"));
  assert.equal(emptyMenu.keyboard.length, 1);
  assert.equal(emptyMenu.keyboard[0][0].callback_data, "pos:list");

  // 2. Active list with various hold / range states
  const mockPositions = [
    {
      pair: "wifout-SOL",
      hold_mode: false,
      in_range: true,
      total_value_usd: 0.52,
    },
    {
      pair: "TOAD-SOL",
      hold_mode: true,
      in_range: true,
      total_value_usd: 1.15,
    },
    {
      pair: "OOR-SOL",
      hold_mode: false,
      in_range: false,
      total_value_usd: 0.88,
    },
  ];

  const menu = renderPositionsMenu(mockPositions);
  assert.ok(menu.text.includes("Position Manager</b> (3 active)"));
  assert.equal(menu.keyboard.length, 4); // 3 positions + 1 control row

  // First button: in_range active
  assert.equal(menu.keyboard[0][0].callback_data, "pos:view:0");
  assert.ok(menu.keyboard[0][0].text.includes("1. wifout-SOL (🟢)"));

  // Second button: hold_mode
  assert.equal(menu.keyboard[1][0].callback_data, "pos:view:1");
  assert.ok(menu.keyboard[1][0].text.includes("2. TOAD-SOL (🛡️)"));

  // Third button: out of range active
  assert.equal(menu.keyboard[2][0].callback_data, "pos:view:2");
  assert.ok(menu.keyboard[2][0].text.includes("3. OOR-SOL (🔴)"));

  // Control row
  assert.equal(menu.keyboard[3][0].callback_data, "pos:list");
  assert.equal(menu.keyboard[3][1].callback_data, "pos:dismiss");

  // Ensure all callback_data strings are <= 64 bytes (Telegram limit)
  for (const row of menu.keyboard) {
    for (const btn of row) {
      assert.ok(
        Buffer.byteLength(btn.callback_data, "utf8") <= 64,
        `callback_data '${btn.callback_data}' exceeds 64 bytes`
      );
    }
  }
});

test("renderPositionActionCard renders rich details, links, and appropriate action buttons", () => {
  const activePos = {
    pair: "wifout-SOL",
    hold_mode: false,
    in_range: true,
    total_value_usd: 0.523,
    pnl_usd: 0.012,
    pnl_pct: 2.34,
    unclaimed_fees_usd: 0.005,
    lower_bin: -35,
    upper_bin: 34,
    active_bin: 0,
    age_minutes: 120,
    strategy: "curve",
    pool: "PoolAddress11111111111111111111111111111111",
    position: "PositionAddress111111111111111111111111111",
  };

  const activeCard = renderPositionActionCard(activePos, 0);
  assert.ok(activeCard.text.includes("Position #1 · wifout-SOL"));
  assert.ok(activeCard.text.includes("🟢 In Range"));
  assert.ok(activeCard.text.includes("⚡ <b>Active Auto</b>"));
  assert.ok(activeCard.text.includes("curve"));
  assert.ok(activeCard.text.includes("https://app.meteora.ag/dlmm/PoolAddress11111111111111111111111111111111"));
  assert.ok(activeCard.text.includes("https://solscan.io/account/PositionAddress111111111111111111111111111"));

  // Button tests
  const activeHoldBtn = activeCard.keyboard[0][0];
  assert.equal(activeHoldBtn.text, "🛡️ Put On Hold");
  assert.equal(activeHoldBtn.callback_data, "pos:hold:0");

  const closeBtn = activeCard.keyboard[1][0];
  assert.equal(closeBtn.text, "🏁 Close Position");
  assert.equal(closeBtn.callback_data, "pos:confirmclose:0");

  const rebalBtn = activeCard.keyboard[1][1];
  assert.equal(rebalBtn.text, "🔄 Rebalance (≤70)");
  assert.equal(rebalBtn.callback_data, "pos:rebal:0");

  const allPosBtn = activeCard.keyboard[2][0];
  assert.equal(allPosBtn.callback_data, "pos:list");

  // Hold position test
  const holdPos = {
    ...activePos,
    pair: "TOAD-SOL",
    hold_mode: true,
    in_range: false,
    minutes_out_of_range: 45,
  };

  const holdCard = renderPositionActionCard(holdPos, 1);
  assert.ok(holdCard.text.includes("Position #2 · TOAD-SOL"));
  assert.ok(holdCard.text.includes("🔴 OOR (45m)"));
  assert.ok(holdCard.text.includes("🛡️ <b>On Hold</b>"));

  const holdBtn = holdCard.keyboard[0][0];
  assert.equal(holdBtn.text, "▶️ Resume Management (Unhold)");
  assert.equal(holdBtn.callback_data, "pos:hold:1");

  // Validate callback_data length
  for (const row of [...activeCard.keyboard, ...holdCard.keyboard]) {
    for (const btn of row) {
      assert.ok(
        Buffer.byteLength(btn.callback_data, "utf8") <= 64,
        `callback_data '${btn.callback_data}' exceeds 64 bytes`
      );
    }
  }
});

test("renderConfirmCloseCard renders safe 2-step confirmation modal", () => {
  const pos = { pair: "wifout-SOL" };
  const card = renderConfirmCloseCard(pos, 0);

  assert.ok(card.text.includes("Confirm Close: #1 wifout-SOL"));
  assert.ok(card.text.includes("Liquidity:</b> Unwound from Meteora DLMM"));
  assert.ok(card.text.includes("Fees:</b> Harvested to wallet"));
  assert.ok(card.text.includes("Swap:</b> Base tokens auto-swapped back to SOL"));

  assert.equal(card.keyboard.length, 2);
  assert.equal(card.keyboard[0][0].text, "🔴 Yes, Close wifout-SOL");
  assert.equal(card.keyboard[0][0].callback_data, "pos:close:0");

  assert.equal(card.keyboard[1][0].text, "❌ Cancel");
  assert.equal(card.keyboard[1][0].callback_data, "pos:view:0");

  for (const row of card.keyboard) {
    for (const btn of row) {
      assert.ok(
        Buffer.byteLength(btn.callback_data, "utf8") <= 64,
        `callback_data '${btn.callback_data}' exceeds 64 bytes`
      );
    }
  }
});
