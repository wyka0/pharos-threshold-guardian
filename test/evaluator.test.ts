import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCondition, decide, type EvaluatedCondition } from "../src/evaluator.js";
import type { ConditionConfig } from "../src/config.js";
import type { ReadResult } from "../src/chain/readers.js";

function condition(overrides: Partial<ConditionConfig> = {}): ConditionConfig {
  return {
    id: "token-balance",
    type: "erc20Balance",
    enabled: true,
    operator: "gte",
    threshold: "100",
    unit: "DEMO",
    ...overrides,
  };
}

function okRead(overrides: Partial<Extract<ReadResult, { ok: true }>> = {}): ReadResult {
  return {
    ok: true,
    raw: 1000n * 10n ** 18n,
    decimals: 18,
    source: "chain-mcp",
    tool: "eth_call(balanceOf)",
    detail: "test read",
    ...overrides,
  };
}

function failedRead(error = "MCP unavailable"): ReadResult {
  return { ok: false, source: "none", tool: "eth_call(balanceOf)", error };
}

test("PASS: actual meets gte threshold", () => {
  const evaluation = evaluateCondition(condition(), okRead());
  assert.equal(evaluation.status, "PASS");
  assert.equal(evaluation.passed, true);
  assert.equal(evaluation.actualFormatted, "1000");
  assert.equal(evaluation.thresholdFormatted, "100");
});

test("FAIL: actual below gte threshold", () => {
  const evaluation = evaluateCondition(condition(), okRead({ raw: 5n * 10n ** 18n }));
  assert.equal(evaluation.status, "FAIL");
  assert.equal(evaluation.passed, false);
  assert.match(evaluation.explanation, /NOT greater than or equal to/);
});

test("threshold is scaled with on-chain decimals, not hardcoded values", () => {
  const evaluation = evaluateCondition(condition({ threshold: "1.5" }), okRead({ decimals: 6, raw: 1_500_000n }));
  assert.equal(evaluation.status, "PASS");
  assert.equal(evaluation.thresholdBaseUnits, 1_500_000n);
  assert.equal(evaluation.actualFormatted, "1.5");
});

test("eq passes only on exact equality", () => {
  const equal = evaluateCondition(condition({ operator: "eq", threshold: "1000" }), okRead());
  assert.equal(equal.status, "PASS");
  const off = evaluateCondition(condition({ operator: "eq", threshold: "1000.000000000000000001" }), okRead());
  assert.equal(off.status, "FAIL");
});

test("disabled conditions are SKIPPED, never read, and never pass or fail", () => {
  const evaluation = evaluateCondition(condition({ enabled: false }), null);
  assert.equal(evaluation.status, "SKIPPED");
  assert.equal(evaluation.passed, null);
  assert.equal(evaluation.source, "none");
  assert.match(evaluation.explanation, /disabled/);
});

test("missing chain data is ERROR and never a pass", () => {
  const evaluation = evaluateCondition(condition(), failedRead("boom"));
  assert.equal(evaluation.status, "ERROR");
  assert.equal(evaluation.passed, null);
  assert.equal(evaluation.error, "boom");
  assert.match(evaluation.explanation, /never counts as a pass/);
});

test("null read (no read performed) is also ERROR", () => {
  const evaluation = evaluateCondition(condition(), null);
  assert.equal(evaluation.status, "ERROR");
  assert.match(evaluation.error ?? "", /No chain read was performed/);
});

test("default labels are friendly; configured label wins", () => {
  const def = evaluateCondition(condition(), okRead());
  assert.equal(def.label, "DEMO token balance");
  const native = evaluateCondition(condition({ id: "n", type: "nativeBalance", unit: "PHRS", threshold: "1" }), okRead({ decimals: 18 }));
  assert.equal(native.label, "Native PHRS balance");
  const labelled = evaluateCondition(condition({ label: "Allowance for spender" }), okRead());
  assert.equal(labelled.label, "Allowance for spender");
});

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

function fakeEvaluation(overrides: Partial<EvaluatedCondition>): EvaluatedCondition {
  return {
    id: "c",
    type: "nativeBalance",
    label: "C",
    enabled: true,
    operator: "gte",
    thresholdConfigured: "1",
    thresholdBaseUnits: 1n,
    thresholdFormatted: "1",
    unit: "PHRS",
    actualRaw: 2n,
    actualFormatted: "2",
    status: "PASS",
    passed: true,
    source: "chain-mcp",
    tool: "get_balance",
    error: null,
    explanation: "ok",
    ...overrides,
  };
}

test("decide -> FIRE when all enabled conditions pass", () => {
  const result = decide([fakeEvaluation({ id: "a", status: "PASS" }), fakeEvaluation({ id: "b", status: "PASS" }), fakeEvaluation({ id: "c", status: "PASS" })]);
  assert.equal(result.outcome, "FIRE");
  assert.match(result.reason, /All 3 enabled condition\(s\) passed/);
});

test("decide -> HOLD when one enabled condition fails", () => {
  const result = decide([
    fakeEvaluation({ id: "a", status: "PASS" }),
    fakeEvaluation({ id: "b", status: "FAIL", actualFormatted: "5", thresholdFormatted: "50", unit: "DEMO" }),
    fakeEvaluation({ id: "c", status: "PASS" }),
  ]);
  assert.equal(result.outcome, "HOLD");
  assert.match(result.reason, /1 of 3 enabled condition\(s\) failed/);
  assert.match(result.reason, /"b"/);
  assert.match(result.reason, /actual 5 DEMO/);
});

test("decide -> ERROR when any enabled condition lacks chain data", () => {
  const result = decide([fakeEvaluation({ id: "a", status: "PASS" }), fakeEvaluation({ id: "b", status: "ERROR", error: "rpc down" }), fakeEvaluation({ id: "c", status: "PASS" })]);
  assert.equal(result.outcome, "ERROR");
  assert.match(result.reason, /"b"/);
  assert.match(result.reason, /missing data is never treated as a pass/);
});

test("decide -> ERROR takes precedence over HOLD and FIRE", () => {
  const mixed = [
    fakeEvaluation({ id: "a", status: "FAIL" }),
    fakeEvaluation({ id: "b", status: "ERROR", error: "x" }),
    fakeEvaluation({ id: "c", status: "PASS" }),
  ];
  assert.equal(decide(mixed).outcome, "ERROR");
});

test("decide -> HOLD takes precedence over FIRE", () => {
  const mixed = [fakeEvaluation({ id: "a", status: "FAIL" }), fakeEvaluation({ id: "b", status: "PASS" }), fakeEvaluation({ id: "c", status: "PASS" })];
  assert.equal(decide(mixed).outcome, "HOLD");
});

test("decide ignores disabled conditions entirely", () => {
  const result = decide([
    fakeEvaluation({ id: "a", status: "PASS" }),
    fakeEvaluation({ id: "disabled", status: "SKIPPED", enabled: false }),
    fakeEvaluation({ id: "c", status: "PASS" }),
  ]);
  assert.equal(result.outcome, "FIRE");
  assert.match(result.reason, /disabled condition\(s\) were skipped/);
});

test("decide -> FIRE with the minimum three enabled conditions", () => {
  const result = decide([fakeEvaluation({ id: "1" }), fakeEvaluation({ id: "2" }), fakeEvaluation({ id: "3" })]);
  assert.equal(result.outcome, "FIRE");
});
