/**
 * Decision engine - the pure, reusable evaluator.
 *
 * This module contains NO network code. It takes validated configuration
 * plus the results of independent chain reads and produces:
 *   - FIRE  only if every enabled condition passes,
 *   - HOLD  if at least one enabled condition fails,
 *   - ERROR if chain data is unavailable or invalid for any enabled
 *           condition (missing data must never count as a pass).
 *
 * Action execution is deliberately out of scope here: this Skill is
 * decision-only and never signs or sends transactions.
 */

import { compareBaseUnits, describeOperator, operatorSymbol, type Operator } from "./operators.js";
import { parseThresholdToBaseUnits, formatBaseUnits } from "./decimal.js";
import type { ConditionConfig, ConditionType } from "./config.js";
import type { ReadResult, DataSource } from "./chain/readers.js";

export type ConditionStatus = "PASS" | "FAIL" | "SKIPPED" | "ERROR";
export type Decision = "FIRE" | "HOLD" | "ERROR";

export interface EvaluatedCondition {
  id: string;
  type: ConditionType;
  label: string;
  enabled: boolean;
  operator: Operator;
  /** Threshold exactly as written in the config file. */
  thresholdConfigured: string;
  /** Threshold scaled to base units using the observed on-chain decimals. */
  thresholdBaseUnits: bigint | null;
  /** Threshold formatted in the unit used for the actual value. */
  thresholdFormatted: string;
  unit: string;
  actualRaw: bigint | null;
  actualFormatted: string | null;
  status: ConditionStatus;
  passed: boolean | null;
  source: DataSource | "none";
  tool: string | null;
  error: string | null;
  explanation: string;
}

export interface DecisionResult {
  outcome: Decision;
  reason: string;
}

function defaultLabel(type: ConditionType, unit: string): string {
  switch (type) {
    case "nativeBalance":
      return `Native ${unit} balance`;
    case "erc20Balance":
      return `${unit} token balance`;
    case "erc20Allowance":
      return `${unit} allowance`;
  }
}

/**
 * Evaluate one condition by combining its configuration with its chain read.
 * Pure function: same inputs always produce the same output, no I/O.
 */
export function evaluateCondition(condition: ConditionConfig, read: ReadResult | null): EvaluatedCondition {
  const label = condition.label ?? defaultLabel(condition.type, condition.unit);

  // Disabled conditions are never read and never influence the decision.
  if (!condition.enabled) {
    return {
      id: condition.id,
      type: condition.type,
      label,
      enabled: false,
      operator: condition.operator,
      thresholdConfigured: condition.threshold,
      thresholdBaseUnits: null,
      thresholdFormatted: condition.threshold,
      unit: condition.unit,
      actualRaw: null,
      actualFormatted: null,
      status: "SKIPPED",
      passed: null,
      source: "none",
      tool: null,
      error: null,
      explanation:
        "This condition is disabled in the configuration. It was not read from the chain and does not affect the decision.",
    };
  }

  // Missing chain data must never be treated as a passing condition.
  if (read === null || !read.ok) {
    const error = read === null ? "No chain read was performed for this enabled condition." : read.error;
    return {
      id: condition.id,
      type: condition.type,
      label,
      enabled: true,
      operator: condition.operator,
      thresholdConfigured: condition.threshold,
      thresholdBaseUnits: null,
      thresholdFormatted: condition.threshold,
      unit: condition.unit,
      actualRaw: null,
      actualFormatted: null,
      status: "ERROR",
      passed: null,
      source: read && !read.ok ? read.source : "none",
      tool: read && !read.ok ? read.tool : null,
      error,
      explanation:
        "The on-chain value could not be read. Missing or invalid chain data never counts as a pass, so the run cannot FIRE.",
    };
  }

  // Scale the configured threshold with the decimals observed on-chain, then
  // compare integer base units. No floating point anywhere.
  const thresholdBaseUnits = parseThresholdToBaseUnits(
    condition.threshold,
    read.decimals,
    `condition "${condition.id}"`,
  );
  const passed = compareBaseUnits(read.raw, condition.operator, thresholdBaseUnits);
  const actualFormatted = formatBaseUnits(read.raw, read.decimals);
  const thresholdFormatted = formatBaseUnits(thresholdBaseUnits, read.decimals);

  const explanation = passed
    ? `On-chain value ${actualFormatted} ${condition.unit} is ${describeOperator(condition.operator)} the configured threshold ${thresholdFormatted} ${condition.unit}.`
    : `On-chain value ${actualFormatted} ${condition.unit} is NOT ${describeOperator(condition.operator)} the configured threshold ${thresholdFormatted} ${condition.unit}.`;

  return {
    id: condition.id,
    type: condition.type,
    label,
    enabled: true,
    operator: condition.operator,
    thresholdConfigured: condition.threshold,
    thresholdBaseUnits,
    thresholdFormatted,
    unit: condition.unit,
    actualRaw: read.raw,
    actualFormatted,
    status: passed ? "PASS" : "FAIL",
    passed,
    source: read.source,
    tool: read.tool,
    error: null,
    explanation,
  };
}

/**
 * Decide the run outcome from evaluated conditions.
 *
 * Precedence: ERROR > HOLD > FIRE.
 *   - Any enabled condition with missing/invalid chain data -> ERROR.
 *   - Otherwise any enabled condition failing its threshold -> HOLD.
 *   - Otherwise (all enabled conditions pass) -> FIRE.
 */
export function decide(evaluations: readonly EvaluatedCondition[]): DecisionResult {
  const enabled = evaluations.filter((evaluation) => evaluation.enabled);
  const errors = enabled.filter((evaluation) => evaluation.status === "ERROR");
  const failures = enabled.filter((evaluation) => evaluation.status === "FAIL");
  const passes = enabled.filter((evaluation) => evaluation.status === "PASS");

  if (errors.length > 0) {
    const ids = errors.map((evaluation) => `"${evaluation.id}"`).join(", ");
    return {
      outcome: "ERROR",
      reason:
        `Chain data is unavailable or invalid for ${errors.length} enabled condition(s): ${ids}. ` +
        `A safe decision is impossible without real chain values, and missing data is never treated as a pass.`,
    };
  }

  if (failures.length > 0) {
    const details = failures
      .map((evaluation) => `"${evaluation.id}" (actual ${evaluation.actualFormatted ?? "unknown"} ${evaluation.unit}, required ${operatorSymbol(evaluation.operator)} ${evaluation.thresholdFormatted} ${evaluation.unit})`)
      .join("; ");
    return {
      outcome: "HOLD",
      reason:
        `${failures.length} of ${enabled.length} enabled condition(s) failed: ${details}. ` +
        `Every configured condition must pass before the action may fire.`,
    };
  }

  const skippedNote = enabled.length < evaluations.length ? ` (${evaluations.length - enabled.length} disabled condition(s) were skipped and did not affect this decision)` : "";
  return {
    outcome: "FIRE",
    reason: `All ${passes.length} enabled condition(s) passed their configured thresholds${skippedNote}.`,
  };
}
