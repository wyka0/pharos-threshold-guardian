import { test } from "node:test";
import assert from "node:assert/strict";
import { parseThresholdToBaseUnits, normalizeThresholdInput, formatBaseUnits, isPlainDecimalString } from "../src/decimal.js";
import { ConfigError } from "../src/errors.js";

test("parses whole numbers into base units", () => {
  assert.equal(parseThresholdToBaseUnits("1", 18, "test"), 10n ** 18n);
  assert.equal(parseThresholdToBaseUnits("100", 18, "test"), 100n * 10n ** 18n);
  assert.equal(parseThresholdToBaseUnits("0", 18, "test"), 0n);
});

test("parses decimal fractions exactly (no float rounding)", () => {
  assert.equal(parseThresholdToBaseUnits("1.5", 18, "test"), 1_500_000_000_000_000_000n);
  assert.equal(parseThresholdToBaseUnits("0.05", 18, "test"), 50_000_000_000_000_000n);
  assert.equal(parseThresholdToBaseUnits("0.000000000000000001", 18, "test"), 1n); // one wei
});

test("parses with fewer decimals (e.g. 6-decimal token)", () => {
  assert.equal(parseThresholdToBaseUnits("1.5", 6, "test"), 1_500_000n);
  assert.equal(parseThresholdToBaseUnits("0.05", 2, "test"), 5n);
});

test("rejects empty and malformed strings with ConfigError", () => {
  for (const bad of ["", "   ", "abc", "-1", "1e18", "0x10", "1,5", "+1", "1.2.3"]) {
    assert.throws(
      () => parseThresholdToBaseUnits(bad, 18, "test"),
      (error: unknown) => error instanceof ConfigError,
      `expected "${bad}" to be rejected`,
    );
  }
});

test("rejects values with more precision than the unit supports", () => {
  assert.throws(
    () => parseThresholdToBaseUnits("0.0000000000000000001", 18, "test"), // 19 decimals
    (error: unknown) => error instanceof ConfigError && error.message.includes("more fractional digits"),
  );
});

test("error messages mention the config context", () => {
  try {
    parseThresholdToBaseUnits("abc", 18, 'condition "token-balance"');
    assert.fail("expected ConfigError");
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /condition "token-balance"/);
  }
});

test("normalizeThresholdInput passes strings through and accepts safe whole numbers", () => {
  assert.equal(normalizeThresholdInput("1.5", "test"), "1.5");
  assert.equal(normalizeThresholdInput("100", "test"), "100");
  assert.equal(normalizeThresholdInput(100, "test"), "100");
  assert.equal(normalizeThresholdInput(0, "test"), "0");
});

test("normalizeThresholdInput rejects unsafe and negative numbers", () => {
  assert.throws(() => normalizeThresholdInput(1.5, "test"), ConfigError);
  assert.throws(() => normalizeThresholdInput(-1, "test"), ConfigError);
  assert.throws(() => normalizeThresholdInput(Number.NaN, "test"), ConfigError);
  assert.throws(() => normalizeThresholdInput(2 ** 53, "test"), ConfigError); // not a safe integer
  assert.throws(() => normalizeThresholdInput(null, "test"), ConfigError);
  assert.throws(() => normalizeThresholdInput(undefined, "test"), ConfigError);
});

test("formatBaseUnits renders human-readable decimals", () => {
  assert.equal(formatBaseUnits(10n ** 18n, 18), "1");
  assert.equal(formatBaseUnits(50_000_000_000_000_000n, 18), "0.05");
  assert.equal(formatBaseUnits(1_500_000_000_000_000_000n, 18), "1.5");
  assert.equal(formatBaseUnits(96356464000000000n, 18), "0.096356464");
  assert.equal(formatBaseUnits(0n, 18), "0");
});

test("isPlainDecimalString accepts config-style decimals and rejects the rest", () => {
  assert.equal(isPlainDecimalString("1"), true);
  assert.equal(isPlainDecimalString("0.05"), true);
  assert.equal(isPlainDecimalString("100"), true);
  assert.equal(isPlainDecimalString(" 1 "), true);
  assert.equal(isPlainDecimalString("-1"), false);
  assert.equal(isPlainDecimalString("1e18"), false);
  assert.equal(isPlainDecimalString(""), false);
  assert.equal(isPlainDecimalString("abc"), false);
});
