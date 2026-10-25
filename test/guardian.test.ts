import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGuardian, EXIT_CODES } from "../src/guardian.js";
import { startMockPharosMcp, startMockFallbackRpc, DEFAULT_MOCK_STATE, buildConfigObject, type MockMcpServer, type MockFallbackServer, type MockChainState } from "./helpers/mockPharosMcp.js";
import { writeFileSync, mkdtempSync } from "node:fs";

let mock: MockMcpServer | undefined;
let fallbackMock: MockFallbackServer | undefined;
let state: MockChainState;
let configDir: string;
let outDir: string;

beforeEach(() => {
  state = structuredClone(DEFAULT_MOCK_STATE);
  configDir = mkdtempSync(join(tmpdir(), "guardian-config-"));
  outDir = mkdtempSync(join(tmpdir(), "guardian-out-"));
});

afterEach(async () => {
  if (mock !== undefined) {
    await mock.close();
    mock = undefined;
  }
  if (fallbackMock !== undefined) {
    await fallbackMock.close();
    fallbackMock = undefined;
  }
});

function writeConfig(overrides: Parameters<typeof buildConfigObject>[0] = {}): string {
  const path = join(configDir, "guardian.json");
  writeFileSync(path, JSON.stringify(buildConfigObject(overrides), null, 2), "utf8");
  return path;
}

function runOptions(configPath: string) {
  return {
    configPath,
    outDir,
    saveArtifacts: true,
    mcpEndpoint: mock?.endpoint ?? "http://127.0.0.1:1/mcp",
    mcpMaxRetries: 0,
    now: () => new Date("2026-10-26T12:00:00Z"),
    runId: "deterministic-run",
  };
}

test("FIRE: all three conditions pass against mock chain values", async () => {
  mock = await startMockPharosMcp({ state });
  const configPath = writeConfig({
    conditions: [
      { id: "native-balance", type: "nativeBalance", enabled: true, operator: "gte", threshold: "0.05", unit: "PHRS" },
      { id: "token-balance", type: "erc20Balance", enabled: true, operator: "gte", threshold: "100", unit: "DEMO" },
      { id: "token-allowance", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "5", unit: "DEMO" },
    ],
  });

  const result = await runGuardian(runOptions(configPath));
  assert.equal(result.decision, "FIRE");
  assert.equal(result.exitCode, EXIT_CODES.FIRE);
  assert.equal(result.trace.summary.passed, 3);
  assert.ok(result.traceJsonPath !== null && existsSync(result.traceJsonPath));

  const saved = JSON.parse(readFileSync(result.traceJsonPath!, "utf8")) as { decision: { outcome: string }; conditions: Array<{ actualRaw: string }> };
  assert.equal(saved.decision.outcome, "FIRE");
  // Bigints are serialized as strings, never numbers.
  assert.equal(typeof saved.conditions[0]!.actualRaw, "string");

  // Block pinning: every MCP read carried the same block tag.
  for (const call of mock.calls) {
    if (call.tool === "get_balance" || call.tool === "eth_call") {
      assert.equal(call.args?.["block"], DEFAULT_MOCK_STATE.latestBlock);
    }
  }
});

test("FIRE boundary: gte passes when actual equals the threshold exactly", async () => {
  mock = await startMockPharosMcp({ state });
  const configPath = writeConfig({
    conditions: [
      { id: "native-balance", type: "nativeBalance", enabled: true, operator: "gte", threshold: "0.096356464", unit: "PHRS" },
      { id: "token-balance", type: "erc20Balance", enabled: true, operator: "gte", threshold: "1000", unit: "DEMO" },
      { id: "token-allowance", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "5", unit: "DEMO" },
    ],
  });
  const result = await runGuardian(runOptions(configPath));
  assert.equal(result.decision, "FIRE");
});

test("HOLD: one failing condition blocks the action and is reported", async () => {
  mock = await startMockPharosMcp({ state });
  const configPath = writeConfig({
    conditions: [
      { id: "native-balance", type: "nativeBalance", enabled: true, operator: "gte", threshold: "0.05", unit: "PHRS" },
      { id: "token-balance", type: "erc20Balance", enabled: true, operator: "gte", threshold: "100", unit: "DEMO" },
      { id: "token-allowance", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "50", unit: "DEMO" },
    ],
  });

  const result = await runGuardian(runOptions(configPath));
  assert.equal(result.decision, "HOLD");
  assert.equal(result.exitCode, EXIT_CODES.HOLD);
  const failed = result.trace.conditions.find((condition) => condition.id === "token-allowance");
  assert.equal(failed?.status, "FAIL");
  assert.match(result.trace.decision.reason, /token-allowance/);
  assert.match(result.report, /FINAL DECISION: HOLD/);
});

test("HOLD: operator lt on native balance fails when balance is above threshold", async () => {
  mock = await startMockPharosMcp({ state });
  const configPath = writeConfig({
    conditions: [
      { id: "native-low", type: "nativeBalance", enabled: true, operator: "lt", threshold: "0.01", unit: "PHRS" },
      { id: "token-balance", type: "erc20Balance", enabled: true, operator: "gte", threshold: "100", unit: "DEMO" },
      { id: "token-allowance", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "5", unit: "DEMO" },
    ],
  });
  const result = await runGuardian(runOptions(configPath));
  assert.equal(result.decision, "HOLD");
  assert.match(result.trace.decision.reason, /native-low/);
});

test("ERROR: network mismatch aborts before any condition read", async () => {
  mock = await startMockPharosMcp({ state, reportChainId: 999 });
  const configPath = writeConfig();
  const result = await runGuardian(runOptions(configPath));
  assert.equal(result.decision, "ERROR");
  assert.equal(result.exitCode, EXIT_CODES.ERROR);
  assert.match(result.trace.decision.reason, /Network mismatch/);
  // No condition reads were attempted.
  assert.equal(mock.calls.filter((call) => call.tool === "get_balance" || call.tool === "eth_call").length, 0);
});

test("ERROR: all endpoints down -> ERROR decision, never FIRE", async () => {
  // No mock: mcpEndpoint points at a dead port and fallback is disabled.
  const configPath = writeConfig({ fallback: { enabled: false } });
  const result = await runGuardian({
    ...runOptions(configPath),
    mcpEndpoint: "http://127.0.0.1:1/mcp",
  });
  assert.equal(result.decision, "ERROR");
  assert.equal(result.exitCode, EXIT_CODES.ERROR);
  assert.match(result.trace.decision.reason, /verify the network|fallback|failed/i);
});

test("ERROR: eth_call returns empty data (non-contract token) -> condition ERROR", { timeout: 30_000 }, async () => {
  mock = await startMockPharosMcp({ state, returnEmptyCall: true });
  // Disable the fallback so the run cannot silently recover via the real RPC;
  // this test must stay offline and prove that empty data is an ERROR.
  const configPath = writeConfig({ fallback: { enabled: false } });
  const result = await runGuardian(runOptions(configPath));
  assert.equal(result.decision, "ERROR");
  const failed = result.trace.conditions.find((condition) => condition.type !== "nativeBalance");
  assert.equal(failed?.status, "ERROR");
  assert.match(failed?.error ?? "", /empty data|unavailable/i);
});

test("fallback: MCP dead but JSON-RPC fallback alive -> reads succeed with rpc-fallback source", async () => {
  fallbackMock = await startMockFallbackRpc(state);
  const configPath = writeConfig({ fallback: { enabled: true, rpcUrl: fallbackMock.url } });
  const result = await runGuardian({
    ...runOptions(configPath),
    mcpEndpoint: "http://127.0.0.1:1/mcp",
  });
  assert.equal(result.decision, "FIRE");
  assert.equal(result.trace.chainVerification.source, "rpc-fallback");
  for (const condition of result.trace.conditions) {
    assert.equal(condition.source, "rpc-fallback");
  }
  assert.match(result.report, /RPC fallback/);
});

test("disabled conditions are skipped and excluded from the decision", async () => {
  mock = await startMockPharosMcp({ state });
  const configPath = writeConfig({
    conditions: [
      { id: "native-balance", type: "nativeBalance", enabled: true, operator: "gte", threshold: "0.05", unit: "PHRS" },
      { id: "token-balance", type: "erc20Balance", enabled: true, operator: "gte", threshold: "100", unit: "DEMO" },
      { id: "token-allowance", type: "erc20Allowance", enabled: false, operator: "gte", threshold: "999999", unit: "DEMO" },
      { id: "extra-native", type: "nativeBalance", enabled: true, operator: "gte", threshold: "0.01", unit: "PHRS" },
    ],
  });
  const result = await runGuardian(runOptions(configPath));
  assert.equal(result.decision, "FIRE");
  const skipped = result.trace.conditions.find((condition) => condition.id === "token-allowance");
  assert.equal(skipped?.status, "SKIPPED");
  assert.equal(result.trace.summary.skipped, 1);
  // Disabled conditions are not read: only 2 enabled conditions produce reads.
  const balanceCalls = mock.calls.filter((call) => call.tool === "get_balance").length;
  assert.ok(balanceCalls >= 2, `expected at least 2 get_balance calls (2 enabled native reads + verification), got ${balanceCalls}`);
});

test("invalid config raises ConfigError with all problems", async () => {
  const path = join(configDir, "bad.json");
  writeFileSync(path, JSON.stringify({ network: { name: "x", chainId: -1 }, conditions: [] }, null, 2), "utf8");
  await assert.rejects(runGuardian(runOptions(path)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /configuration problem/i);
    return true;
  });
});

test("missing config file raises ConfigError naming the path", async () => {
  await assert.rejects(
    runGuardian({ ...runOptions(join(configDir, "does-not-exist.json")) }),
    (error: unknown) => error instanceof Error && /does-not-exist\.json/.test(error.message),
  );
});

test("artifacts are written as JSON + Markdown pairs", async () => {
  mock = await startMockPharosMcp({ state });
  const configPath = writeConfig();
  const result = await runGuardian(runOptions(configPath));
  assert.ok(result.traceJsonPath !== null);
  assert.ok(result.traceMarkdownPath !== null);
  assert.ok(existsSync(result.traceMarkdownPath!));
  const files = readdirSync(outDir);
  assert.equal(files.length, 2);
  assert.ok(files.some((file) => file.endsWith(".json")));
  assert.ok(files.some((file) => file.endsWith(".md")));
  const markdown = readFileSync(result.traceMarkdownPath!, "utf8");
  assert.match(markdown, /FINAL|Decision/i);
});
