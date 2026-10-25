/**
 * Decimal-safe helpers for token amounts.
 *
 * All threshold comparisons happen on integer base units (bigint). Human
 * values such as "1.5" are parsed into base units with viem's parseUnits,
 * which rejects malformed input and excess precision instead of silently
 * rounding. Floating point numbers are never used for amounts.
 */

import { parseUnits, formatUnits } from "viem";
import { ConfigError } from "./errors.js";

/**
 * Accepts only plain, non-negative decimal strings: "1", "0.05", "100".
 * Scientific notation ("1e18"), negatives, and hex are rejected so that a
 * mistake in the config file is reported instead of silently mis-scaled.
 */
const DECIMAL_STRING_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Convert a human-readable decimal string into integer base units.
 *
 * Example: parseThresholdToBaseUnits("1.5", 18) -> 1500000000000000000n
 *
 * Throws ConfigError with a beginner-friendly message on bad input.
 */
export function parseThresholdToBaseUnits(value: string, decimals: number, context: string): bigint {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ConfigError(`${context}: threshold must be a non-empty decimal string like "1.5".`);
  }
  if (!DECIMAL_STRING_PATTERN.test(trimmed)) {
    throw new ConfigError(
      `${context}: threshold "${value}" is not a valid non-negative decimal number. ` +
        `Use plain decimal strings such as "1", "0.05", or "100" (no negatives, no scientific notation).`,
    );
  }
  // Reject excess precision explicitly: parseUnits would silently truncate
  // "1.55" at 1 decimal to 1.5, which would silently mis-scale a threshold.
  const fractionalDigits = trimmed.includes(".") ? trimmed.split(".")[1]!.length : 0;
  if (fractionalDigits > decimals) {
    throw new ConfigError(
      `${context}: threshold "${value}" has more fractional digits than the unit supports ` +
        `(${decimals} decimals). Reduce the precision.`,
    );
  }
  try {
    return parseUnits(trimmed, decimals);
  } catch {
    throw new ConfigError(`${context}: threshold "${value}" could not be parsed as a decimal amount.`);
  }
}

/**
 * Accepts a config threshold that may be a decimal string (preferred) or a
 * JSON number. Numbers are only accepted when they are exact safe integers;
 * anything else risks floating point corruption and is rejected with an
 * explanation, keeping the "no floating point amounts" guarantee.
 */
export function normalizeThresholdInput(value: unknown, context: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) {
      return String(value);
    }
    throw new ConfigError(
      `${context}: numeric threshold ${value} must be a non-negative whole number. ` +
        `For decimal amounts use a quoted string instead, e.g. "1.5".`,
    );
  }
  throw new ConfigError(
    `${context}: threshold must be a decimal string (preferred) or a whole number, got ${typeof value}.`,
  );
}

/** Format integer base units back into a human-readable decimal string. */
export function formatBaseUnits(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

/** True when the string is a plain non-negative decimal number. */
export function isPlainDecimalString(value: string): boolean {
  return DECIMAL_STRING_PATTERN.test(value.trim());
}
