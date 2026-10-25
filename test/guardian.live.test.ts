/**
 * Live integration test against the real Pharos Atlantic Testnet.
 *
 * GATED: this file contacts the local Pharos Chain MCP server and the
 * Atlantic testnet RPC. It runs ONLY when GUARDIAN_LIVE=1 is set:
 *
 *     GUARDIAN_LIVE=1 npm run test:live
 *
 * Normal `npm test` never touches the network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { runGuardian, EXIT_CODES } from "../src/guardian.js";

const LIVE = process.env["GUARDIAN_LIVE"] === "1";

if (!LIVE) {
  test("live check is gated behind GUARDIAN_LIVE=1", () => {
    assert.ok(true, "skipped: set GUARDIAN_LIVE=1 to run live integration tests");
  });
} else {
  const root = resolve(import.meta.dirname ?? ".");

  test("live: default config runs against Atlantic Testnet and produces a decision", { timeout: 120_000 }, async () => {
    const result = await runGuardian({
      configPath: join(root, "..", "..", "config", "guardian.json"),
      mcpMaxRetries: 2,
    });
    assert.equal(result.trace.network.chainId, 688689);
    assert.equal(result.trace.chainVerification.chainIdMatchesConfig, true);
    // Every enabled condition either has a real value or an explicit error.
    for (const condition of result.trace.conditions) {
      if (condition.enabled && condition.status !== "ERROR") {
        assert.ok(condition.actualFormatted !== null, `condition ${condition.id} has no value`);
        assert.ok(["chain-mcp", "rpc-fallback"].includes(condition.source), `unexpected source ${condition.source}`);
      }
    }
    assert.ok(["FIRE", "HOLD", "ERROR"].includes(result.decision));
    assert.ok(result.exitCode === EXIT_CODES.FIRE || result.exitCode === EXIT_CODES.HOLD || result.exitCode === EXIT_CODES.ERROR);
  });

  test("live: FIRE demonstration config FIREs or reports why it cannot", { timeout: 120_000 }, async () => {
    const result = await runGuardian({
      configPath: join(root, "..", "..", "config", "guardian.fire.json"),
      mcpMaxRetries: 2,
    });
    assert.equal(result.trace.network.chainId, 688689);
    assert.ok(["FIRE", "ERROR"].includes(result.decision), `expected FIRE or ERROR, got ${result.decision}: ${result.trace.decision.reason}`);
    if (result.decision === "FIRE") {
      assert.equal(result.exitCode, EXIT_CODES.FIRE);
      assert.equal(result.trace.summary.failed, 0);
      assert.ok(existsSync(result.traceJsonPath ?? "missing"));
    }
  });

  test("live: HOLD demonstration config HOLDs on a real failed condition", { timeout: 120_000 }, async () => {
    const result = await runGuardian({
      configPath: join(root, "..", "..", "config", "guardian.hold.json"),
      mcpMaxRetries: 2,
    });
    assert.equal(result.decision, "HOLD");
    assert.equal(result.exitCode, EXIT_CODES.HOLD);
    const failed = result.trace.conditions.filter((condition) => condition.status === "FAIL");
    assert.ok(failed.length >= 1, "expected at least one real FAIL in the HOLD demonstration");
    for (const condition of failed) {
      assert.ok(condition.actualFormatted !== null, "failed condition must still record its real observed value");
    }
  });
}
