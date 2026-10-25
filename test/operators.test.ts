import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATORS, isOperator, compareBaseUnits, operatorSymbol, describeOperator } from "../src/operators.js";

test("operator list contains exactly the five supported operators", () => {
  assert.deepEqual([...OPERATORS].sort(), ["eq", "gt", "gte", "lt", "lte"]);
});

test("isOperator accepts valid operators and rejects everything else", () => {
  for (const operator of OPERATORS) {
    assert.equal(isOperator(operator), true);
  }
  assert.equal(isOperator("GTE"), false);
  assert.equal(isOperator(">="), false);
  assert.equal(isOperator(""), false);
  assert.equal(isOperator(42), false);
  assert.equal(isOperator(undefined), false);
  assert.equal(isOperator(null), false);
});

test("gt: strictly greater than", () => {
  assert.equal(compareBaseUnits(2n, "gt", 1n), true);
  assert.equal(compareBaseUnits(1n, "gt", 1n), false); // boundary: equal is not gt
  assert.equal(compareBaseUnits(0n, "gt", 1n), false);
});

test("gte: greater than or equal (equality passes)", () => {
  assert.equal(compareBaseUnits(2n, "gte", 1n), true);
  assert.equal(compareBaseUnits(1n, "gte", 1n), true); // boundary: equality passes
  assert.equal(compareBaseUnits(0n, "gte", 1n), false);
});

test("lt: strictly less than", () => {
  assert.equal(compareBaseUnits(0n, "lt", 1n), true);
  assert.equal(compareBaseUnits(1n, "lt", 1n), false); // boundary
  assert.equal(compareBaseUnits(2n, "lt", 1n), false);
});

test("lte: less than or equal (equality passes)", () => {
  assert.equal(compareBaseUnits(0n, "lte", 1n), true);
  assert.equal(compareBaseUnits(1n, "lte", 1n), true); // boundary
  assert.equal(compareBaseUnits(2n, "lte", 1n), false);
});

test("eq: exact equality on base units", () => {
  assert.equal(compareBaseUnits(1000n, "eq", 1000n), true);
  assert.equal(compareBaseUnits(1001n, "eq", 1000n), false);
  assert.equal(compareBaseUnits(999n, "eq", 1000n), false);
});

test("comparisons work on very large 18-decimal values without precision loss", () => {
  const oneToken = 10n ** 18n;
  const slightlyMore = 10n ** 18n + 1n; // one wei more
  assert.equal(compareBaseUnits(slightlyMore, "gt", oneToken), true);
  assert.equal(compareBaseUnits(slightlyMore, "eq", oneToken), false);
  assert.equal(compareBaseUnits(slightlyMore, "gte", oneToken), true);
});

test("operator symbols and descriptions are beginner friendly", () => {
  assert.equal(operatorSymbol("gte"), ">=");
  assert.equal(operatorSymbol("eq"), "==");
  assert.equal(describeOperator("gte"), "greater than or equal to");
  assert.equal(describeOperator("lt"), "strictly less than");
});
