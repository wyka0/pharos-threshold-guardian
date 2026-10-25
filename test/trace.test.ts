import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTrace, safeStringify, TRACE_SCHEMA_VERSION, type GuardianTrace } from "../src/trace.js";
import { evaluateCondition, decide } from "../src/evaluator.js";
import { renderTerminalReport, renderMarkdownReport } from "../src/report.js";
import type { ConditionConfig } from "../src/config.js";
import type { ReadResult } from "../src/chain/readers.js";
import { buildConfigObject } from "./helpers/mockPharosMcp.js";
import { validateConfig } from "../src/config.js";

function condition(overrides: Partial<ConditionConfig> = {}): ConditionConfig {
  return { id: "token-balance", type: "erc20Balance", enabled: true, operator: "gte", threshold: "100", unit: "DEMO", ...overrides };
}

function okRead(raw = 1000n * 10n ** 18n, overrides: Partial<Extract<ReadResult, { ok: true }>> = {}): ReadResult {
  return { ok: true, raw, decimals: 18, source: "chain-mcp", tool: "eth_call(balanceOf)", detail: "test", ...overrides };
}

const config = validateConfig(buildConfigObject(), "test-config.json");

function sampleTrace(): GuardianTrace {
  const evaluations = [
    evaluateCondition(condition({ id: "native-balance", type: "nativeBalance", unit: "PHRS", threshold: "0.05", label: "Native PHRS balance" }), {
      ok: true,
      raw: 96356464000000000n,
      decimals: 18,
      source: "chain-mcp",
      tool: "get_balance",
      detail: "d",
    }),
    evaluateCondition(condition({ id: "token-allowance", type: "erc20Allowance", threshold: "50", label: "DEMO allowance" }), okRead(5n * 10n ** 18n, { tool: "eth_call(allowance)" })),
  ];
  const decision = decide(evaluations);
  return buildTrace({
    config,
    verification: { source: "chain-mcp", chainId: 688689, chainIdMatchesConfig: true, latestBlock: "31878219", clientVersion: "mock", nativeSymbol: "PHRS" },
    token: { address: config.tokenAddress, decimals: 18, symbol: "DEMO", source: "chain-mcp", codeBytes: 2048 },
    spender: { address: config.spenderAddress, codeBytes: 1024 },
    evaluations,
    decision: decision.outcome,
    reason: decision.reason,
    pinnedBlock: "31878219",
    notes: ["Test note."],
    runId: "test-run-id",
    timestamp: new Date("2026-10-26T12:00:00Z"),
  });
}

test("trace has the full auditable schema", () => {
  const trace = sampleTrace();
  assert.equal(trace.schema, TRACE_SCHEMA_VERSION);
  assert.equal(trace.runId, "test-run-id");
  assert.equal(trace.timestamp, "2026-10-26T12:00:00.000Z");
  assert.equal(trace.network.chainId, 688689);
  assert.equal(trace.walletAddress, config.walletAddress);
  assert.equal(trace.pinnedBlock, "31878219");
  assert.equal(trace.action.mode, "decision-only");
  assert.equal(trace.conditions.length, 2);
});

test("trace condition includes actual value, operator, threshold, unit, source, and result", () => {
  const trace = sampleTrace();
  const allowance = trace.conditions[1];
  assert.ok(allowance);
  assert.equal(allowance.actualFormatted, "5");
  assert.equal(allowance.operator, "gte");
  assert.equal(allowance.thresholdFormatted, "50");
  assert.equal(allowance.unit, "DEMO");
  assert.equal(allowance.status, "FAIL");
  assert.equal(allowance.source, "chain-mcp");
  assert.equal(allowance.tool, "eth_call(allowance)");
  assert.equal(allowance.actualRaw, "5000000000000000000");
  assert.equal(allowance.thresholdBaseUnits, "50000000000000000000");
});

test("summary counts enabled/passed/failed/errors/skipped correctly", () => {
  const trace = sampleTrace();
  assert.deepEqual(trace.summary, { total: 2, enabled: 2, passed: 1, failed: 1, errors: 0, skipped: 0 });
});

test("decision outcome and reason are recorded", () => {
  const trace = sampleTrace();
  assert.equal(trace.decision.outcome, "HOLD");
  assert.match(trace.decision.reason, /token-allowance/);
});

test("safeStringify converts bigints to strings and survives odd structures", () => {
  assert.equal(safeStringify({ value: 10n ** 18n }), '{"value":"1000000000000000000"}');
  // A top-level bigint becomes a JSON string: raw bigints are not valid JSON.
  assert.equal(safeStringify(123n), '"123"');
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  assert.match(safeStringify(circular), /serializationError/);
});

test("terminal report is beginner readable and contains the required lines", () => {
  const report = renderTerminalReport(sampleTrace());
  assert.match(report, /THRESHOLD GUARDIAN/);
  assert.match(report, /Network:.*Mock Pharos Atlantic Testnet/);
  assert.match(report, /Chain ID:.*688689/);
  assert.match(report, /Condition: Native PHRS balance/);
  assert.match(report, /Actual:\s+0\.096356464 PHRS/);
  assert.match(report, /Required:\s+>= 0\.05 PHRS/);
  assert.match(report, /Result:\s+PASS/);
  assert.match(report, /DEMO allowance/);
  assert.match(report, /Required:\s+>= 50 DEMO/);
  assert.match(report, /Result:\s+FAIL/);
  assert.match(report, /FINAL DECISION: HOLD/);
  assert.match(report, /Reason:/);
  assert.match(report, /Chain MCP/);
});

test("terminal report flags ERROR conditions without hiding the decision", () => {
  const trace = sampleTrace();
  trace.conditions[1]!.status = "ERROR";
  trace.conditions[1]!.actualFormatted = null;
  trace.conditions[1]!.error = "simulated read failure";
  trace.decision.outcome = "ERROR";
  trace.decision.reason = "Chain data is unavailable or invalid for 1 enabled condition(s): \"token-allowance\".";
  const report = renderTerminalReport(trace);
  assert.match(report, /Actual:\s+UNAVAILABLE/);
  assert.match(report, /Result:\s+ERROR/);
  assert.match(report, /simulated read failure/);
  assert.match(report, /FINAL DECISION: ERROR/);
});

test("terminal report shows skipped (disabled) conditions", () => {
  const trace = sampleTrace();
  trace.conditions[1]!.status = "SKIPPED";
  const report = renderTerminalReport(trace);
  assert.match(report, /SKIPPED \(disabled/);
});

test("markdown report contains tables and decision", () => {
  const markdown = renderMarkdownReport(sampleTrace());
  assert.match(markdown, /# Threshold Guardian run `test-run-id`/);
  assert.match(markdown, /\| Condition \| Type \| Actual \| Required \| Source \| Result \|/);
  assert.match(markdown, /\*\*HOLD\*\*/);
  assert.match(markdown, /## Notes/);
  assert.match(markdown, /Test note\./);
});

test("generated runId is a UUID when not injected", () => {
  const trace = buildTrace({
    config,
    verification: { source: "chain-mcp", chainId: 688689, chainIdMatchesConfig: true, latestBlock: null, clientVersion: null, nativeSymbol: null },
    token: null,
    spender: null,
    evaluations: [],
    decision: "ERROR",
    reason: "test",
    pinnedBlock: null,
    notes: [],
  });
  assert.match(trace.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
