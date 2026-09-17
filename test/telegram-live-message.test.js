import assert from "node:assert/strict";
import {
  escapeHTML,
  formatToolStart,
  formatToolFinish,
  deleteMessage,
} from "../telegram.js";

console.log("Running Telegram live message tests...");

// ─── 1. formatToolStart tests ───────────────────────────────────────────────

{
  const line = formatToolStart("claim_fees", { pair: "wifout-SOL", detail: "◎0.0082 / $0.82" });
  assert.equal(line, "ℹ️ Claiming fees on <b>wifout-SOL</b> (◎0.0082 / $0.82)...");
}

{
  const line = formatToolStart("close_position", { pair: "POT-SOL", reason: "Trailing TP: +1.64%" });
  assert.equal(line, "ℹ️ Closing <b>POT-SOL</b> (Trailing TP: +1.64%)...");
}

{
  const line = formatToolStart("rebalance_position", { pair: "TOAD-SOL", reason: "curve -35..+34" });
  assert.equal(line, "ℹ️ Rebalancing <b>TOAD-SOL</b> (curve -35..+34)...");
}

{
  const line = formatToolStart("flip_position", { pair: "wifout-SOL", reason: "oor-below flip" });
  assert.equal(line, "ℹ️ Flipping <b>wifout-SOL</b> (oor-below flip)...");
}

{
  const line = formatToolStart("deploy_position", { poolName: "BONK-SOL", amountSol: 0.25 });
  assert.equal(line, "ℹ️ Deploying to <b>BONK-SOL</b> (0.25 SOL)...");
}

{
  // Fallback with HTML characters that must be escaped
  const line = formatToolStart("custom_tool", { pair: "TEST<>&", detail: "pnl <= 5%" });
  assert.equal(line, "ℹ️ custom tool on <b>TEST&lt;&gt;&amp;</b> (pnl ≤ 5%)...");
}

console.log("✔ formatToolStart tests passed");

// ─── 2. formatToolFinish tests ──────────────────────────────────────────────

{
  const successClaim = formatToolFinish("claim_fees", { success: true, claimed_sol: 0.0082 }, true, { pair: "wifout-SOL" });
  assert.equal(successClaim, "✅ Claimed fees on <b>wifout-SOL</b> (+◎0.0082)");

  const failedClaim = formatToolFinish("claim_fees", { success: false, error: "RPC rate limit (429)" }, false, { pair: "wifout-SOL" });
  assert.equal(failedClaim, "❌ Failed to claim fees on <b>wifout-SOL</b>: RPC rate limit (429)");
}

{
  const successClose = formatToolFinish("close_position", { success: true, pnl_pct: 1.64 }, true, { pair: "POT-SOL" });
  assert.equal(successClose, "✅ Closed <b>POT-SOL</b> (+1.64% PnL)");

  const failedClose = formatToolFinish("close_position", { success: false, reason: "insufficient funds" }, false, { pair: "POT-SOL" });
  assert.equal(failedClose, "❌ Failed to close <b>POT-SOL</b>: insufficient funds");
}

{
  const successRebal = formatToolFinish("rebalance_position", { success: true, position: "9AbCdEf1234", bin_range: { min: -35, max: 34 } }, true, { pair: "TOAD-SOL" });
  assert.equal(successRebal, "✅ Rebalanced <b>TOAD-SOL</b> → 9AbCdEf1... (bins -35..34)");

  const failedRebal = formatToolFinish("rebalance_position", { success: false, error: "simulation failed" }, false, { pair: "TOAD-SOL" });
  assert.equal(failedRebal, "❌ Failed to rebalance <b>TOAD-SOL</b>: simulation failed");
}

{
  const successFlip = formatToolFinish("flip_position", { success: true, flipped: true, bin_range: { min: 100, max: 140 } }, true, { pair: "wifout-SOL" });
  assert.equal(successFlip, "✅ Flipped <b>wifout-SOL</b> (ask ladder 100..140)");
}

{
  const successDeploy = formatToolFinish("deploy_position", { success: true, position: "DePlOy12345" }, true, { poolName: "BONK-SOL" });
  assert.equal(successDeploy, "🚀 Deployed to <b>BONK-SOL</b> (pos DePlOy12...)");
}

console.log("✔ formatToolFinish tests passed");

// ─── 3. Multi-tool tracking & Rendering logic tests ──────────────────────────

{
  // Test title emoji regex matching
  function parseTitle(title) {
    const trimmed = title.trim();
    const match = trimmed.match(/^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\S+)\s*(.*)$/u);
    if (match && match[2]) {
      return `${match[1]} <b>${escapeHTML(match[2])}</b>`;
    }
    return `<b>${escapeHTML(trimmed)}</b>`;
  }

  assert.equal(parseTitle("🔄 Management Cycle"), "🔄 <b>Management Cycle</b>");
  assert.equal(parseTitle("🔍 Screening Cycle"), "🔍 <b>Screening Cycle</b>");
  assert.equal(parseTitle("🤖 Live Update"), "🤖 <b>Live Update</b>");
  assert.equal(parseTitle("Plain Header"), "Plain <b>Header</b>");
}

{
  // Test distinct keys for multiple simultaneous actions in toolLines
  const toolLines = new Map();
  const act1 = { pair: "wifout-SOL", detail: "◎0.0082", key: "claim:wifout-SOL" };
  const act2 = { pair: "KEVIN-SOL", detail: "◎0.0041", key: "claim:KEVIN-SOL" };

  toolLines.set(act1.key, formatToolStart("claim_fees", act1));
  toolLines.set(act2.key, formatToolStart("claim_fees", act2));

  assert.equal(toolLines.size, 2, "Both actions must coexist without overwriting");
  assert(toolLines.get("claim:wifout-SOL").includes("wifout-SOL"));
  assert(toolLines.get("claim:KEVIN-SOL").includes("KEVIN-SOL"));

  // Finish act1 first
  toolLines.set(act1.key, formatToolFinish("claim_fees", { success: true, claimed_sol: 0.0082 }, true, act1));
  assert(toolLines.get("claim:wifout-SOL").startsWith("✅ Claimed fees on <b>wifout-SOL</b>"));
  assert(toolLines.get("claim:KEVIN-SOL").startsWith("ℹ️ Claiming fees on <b>KEVIN-SOL</b>"));
}

{
  // Test in-progress vs finalized rendering semantics
  function mockRender(state) {
    const sections = [];
    if (state.title) {
      const trimmed = state.title.trim();
      const match = trimmed.match(/^(\p{Extended_Pictographic}|\p{Emoji_Presentation}|\S+)\s*(.*)$/u);
      if (match && match[2]) {
        sections.push(`${match[1]} <b>${escapeHTML(match[2])}</b>`);
      } else {
        sections.push(`<b>${escapeHTML(trimmed)}</b>`);
      }
    }
    if (!state.footer) {
      if (state.intro) sections.push(escapeHTML(state.intro));
      const toolList = Array.from(state.toolLines.values());
      if (toolList.length > 0) sections.push(toolList.join("\n"));
    } else {
      sections.push(state.footer);
    }
    return sections.join("\n\n");
  }

  // In-progress state
  const inProgressState = {
    title: "🔄 Management Cycle",
    intro: "📊 Evaluating 8 active position(s) · ◎4.90 SOL AUM...",
    toolLines: new Map([
      ["claim:wifout-SOL", "ℹ️ Claiming fees on <b>wifout-SOL</b> (◎0.0082)..."],
    ]),
    footer: "",
  };

  const inProgressHtml = mockRender(inProgressState);
  assert(inProgressHtml.includes("🔄 <b>Management Cycle</b>"));
  assert(inProgressHtml.includes("📊 Evaluating 8 active position(s)"));
  assert(inProgressHtml.includes("ℹ️ Claiming fees on <b>wifout-SOL</b>"));

  // Finalized state
  const finalizedState = {
    ...inProgressState,
    footer: "💼 <b>◎4.90 ($650.00)</b>\n\n1. <b>wifout-SOL</b> ...\n\n8 position(s) · updated 16:44:00",
  };

  const finalizedHtml = mockRender(finalizedState);
  assert(finalizedHtml.includes("🔄 <b>Management Cycle</b>"));
  assert(finalizedHtml.includes("💼 <b>◎4.90 ($650.00)</b>"));
  assert(!finalizedHtml.includes("Evaluating 8 active position(s)"), "Finalized output must NOT contain in-progress intro");
  assert(!finalizedHtml.includes("ℹ️ Claiming fees"), "Finalized output must NOT contain raw in-progress tool lines");
}

// ─── 4. deleteMessage export test ───────────────────────────────────────────

{
  assert.equal(typeof deleteMessage, "function", "deleteMessage must be exported as a function");
}

console.log("✔ All Telegram live message unit tests passed successfully!");
