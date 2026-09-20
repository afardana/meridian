import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  validateDestinationAddress,
  get24hTransferredSol,
  getLastTransferTimestamp,
  getAutoSkimStatus,
  DEFAULT_TARGET_WORKING_CAPITAL_SOL,
  DEFAULT_MIN_TRANSFER_AMOUNT_SOL,
  DEFAULT_MIN_WALLET_RESERVE_SOL,
} from "../tools/transfer.js";
import { config } from "../config.js";
import { executeTool } from "../tools/executor.js";

// Sample valid and invalid Solana public keys
const VALID_PIONEX_ADDRESS = "DFBHCEdXDCqHWPQDYPcp7RnhiGoM4dm4p2gCfv13QBMT";
const INVALID_FORMAT_ADDRESS = "not-a-valid-solana-address";
// Known off-curve PDA (Associated Token Account Program ID is an off-curve address or System Program PDA)
const PDA_OFF_CURVE_ADDRESS = PublicKey.findProgramAddressSync(
  [Buffer.from("test")],
  new PublicKey("11111111111111111111111111111111")
)[0].toBase58();

test("AutoSkim - validateDestinationAddress", () => {
  // Empty or non-string
  assert.equal(validateDestinationAddress("").valid, false);
  assert.equal(validateDestinationAddress(null).valid, false);
  assert.equal(validateDestinationAddress(undefined).valid, false);

  // Invalid base58
  const invalid = validateDestinationAddress(INVALID_FORMAT_ADDRESS);
  assert.equal(invalid.valid, false);
  assert.match(invalid.error, /Invalid Base58/);

  // PDA off-curve
  const offCurve = validateDestinationAddress(PDA_OFF_CURVE_ADDRESS);
  assert.equal(offCurve.valid, false);
  assert.match(offCurve.error, /not an on-curve/);

  // Valid on-curve address
  const valid = validateDestinationAddress(VALID_PIONEX_ADDRESS);
  assert.equal(valid.valid, true);
  assert.ok(valid.pubkey instanceof PublicKey);
  assert.equal(valid.pubkey.toBase58(), VALID_PIONEX_ADDRESS);
});

test("AutoSkim - getAutoSkimStatus calculation & threshold safety", async () => {
  // Mock config state
  config.autoSkim = {
    enabled: true,
    destinationAddress: VALID_PIONEX_ADDRESS,
    targetWorkingCapitalSol: 6.2529,
    minTransferAmountSol: 0.5,
    minWalletReserveSol: 0.1,
    transferIntervalMin: 60,
    maxDailyTransferSol: 2.0,
    requireTelegramConfirmation: false,
  };

  const status = await getAutoSkimStatus({ freshPositions: false });
  assert.equal(typeof status.enabled, "boolean");
  assert.equal(status.destinationValid, true);
  assert.equal(status.destination, VALID_PIONEX_ADDRESS);
  assert.equal(status.targetWorkingCapitalSol, 6.2529);
  assert.equal(typeof status.netCapitalAtRisk, "number");
  assert.equal(typeof status.totalEquitySol, "number");
  assert.equal(typeof status.surplusSol, "number");
  assert.equal(typeof status.transferableSol, "number");
  assert.equal(typeof status.canTransfer, "boolean");
});

test("AutoSkim - update_config supports autoSkim parameters", async () => {
  const original = { ...config.autoSkim };

  const res = await executeTool("update_config", {
    changes: {
      autoSkimEnabled: true,
      autoSkimTargetWorkingCapitalSol: 6.5,
      autoSkimMinTransferAmountSol: 0.5,
      autoSkimMinWalletReserveSol: 0.15,
      autoSkimTransferIntervalMin: 30,
      autoSkimMaxDailyTransferSol: 3.0,
    },
    reason: "Unit test autoSkim config update",
  });

  assert.equal(res.success, true);
  assert.equal(config.autoSkim.enabled, true);
  assert.equal(config.autoSkim.targetWorkingCapitalSol, 6.5);
  assert.equal(config.autoSkim.minTransferAmountSol, 0.5);
  assert.equal(config.autoSkim.minWalletReserveSol, 0.15);
  assert.equal(config.autoSkim.transferIntervalMin, 30);
  assert.equal(config.autoSkim.maxDailyTransferSol, 3.0);

  // Restore original
  await executeTool("update_config", {
    changes: {
      autoSkimEnabled: original.enabled,
      autoSkimTargetWorkingCapitalSol: original.targetWorkingCapitalSol,
      autoSkimMinTransferAmountSol: original.minTransferAmountSol,
      autoSkimMinWalletReserveSol: original.minWalletReserveSol,
      autoSkimTransferIntervalMin: original.transferIntervalMin,
      autoSkimMaxDailyTransferSol: original.maxDailyTransferSol,
    },
    reason: "Unit test autoSkim config restore",
  });
});
