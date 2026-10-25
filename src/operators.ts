/**
 * Comparison operators supported by Threshold Guardian conditions.
 *
 * Comparisons operate on integer base units (bigint) so that decimal token
 * amounts are never rounded through floating point.
 */

export const OPERATORS = ["gt", "gte", "lt", "lte", "eq"] as const;

export type Operator = (typeof OPERATORS)[number];

const OPERATOR_SYMBOLS: Record<Operator, string> = {
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  eq: "==",
};

const OPERATOR_DESCRIPTIONS: Record<Operator, string> = {
  gt: "strictly greater than",
  gte: "greater than or equal to",
  lt: "strictly less than",
  lte: "less than or equal to",
  eq: "exactly equal to",
};

export function isOperator(value: unknown): value is Operator {
  return typeof value === "string" && (OPERATORS as readonly string[]).includes(value);
}

export function operatorSymbol(operator: Operator): string {
  return OPERATOR_SYMBOLS[operator];
}

export function describeOperator(operator: Operator): string {
  return OPERATOR_DESCRIPTIONS[operator];
}

/** Evaluate `actual <operator> threshold` on integer base units. */
export function compareBaseUnits(actual: bigint, operator: Operator, threshold: bigint): boolean {
  switch (operator) {
    case "gt":
      return actual > threshold;
    case "gte":
      return actual >= threshold;
    case "lt":
      return actual < threshold;
    case "lte":
      return actual <= threshold;
    case "eq":
      return actual === threshold;
  }
}
