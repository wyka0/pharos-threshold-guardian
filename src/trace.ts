/**
 * Decision trace: the auditable record of one guardian run.
 *
 * A trace captures who (wallet), where (network + pinned block), what was
 * read (actual on-chain values), what was required (configured thresholds),
 * where each value came from (Chain MCP vs documented RPC fallback), the
 * PASS/FAIL/SKIPPED/ERROR outcome per condition, and the final decision
 * (FIRE / HOLD / ERROR) with a plain-language reason.
 *
 * Serialization is bigint-safe: JSON has no bigint type, so base-unit values
 * are written as strings and never as numbers (no float corruption, no
 * precision loss).
 */

import { randomUUID } from "node:crypto";
import type { GuardianConfig } from "./config.js";
import type { EvaluatedCondition, Decision } from "./evaluator.js";
import type { TokenMeta, DataSource } from "./chain/readers.js";

export const TRACE_SCHEMA_VERSION = "threshold-guardian/run/v1";

export interface TraceCondition extends Omit<EvaluatedCondition, "thresholdBaseUnits" | "actualRaw"> {
  /** Base-unit values serialized as strings (JSON has no bigint). */
  thresholdBaseUnits: string | null;
  actualRaw: string | null;
}

export interface TraceNetwork {
  name: string;
  chainId: number;
  rpcUrl?: string;
  explorerUrl?: string;
}

export interface ChainVerification {
  source: DataSource | "none";
  chainId: number;
  chainIdMatchesConfig: boolean;
  latestBlock: string | null;
  clientVersion: string | null;
  nativeSymbol: string | null;
}

export interface TraceToken {
  address: string;
  symbol: string;
  decimals: number;
  codeBytes: number | null;
  source: DataSource | "none";
}

export interface TraceSpender {
  address: string;
  codeBytes: number | null;
}

export interface GuardianTrace {
  schema: string;
  runId: string;
  timestamp: string;
  network: TraceNetwork;
  chainVerification: ChainVerification;
  walletAddress: string;
  token: TraceToken | null;
  spender: TraceSpender | null;
  action: { name: string; mode: string };
  configPath: string;
  /** Every read in this run was pinned to this block (decimal string). */
  pinnedBlock: string | null;
  conditions: TraceCondition[];
  summary: {
    total: number;
    enabled: number;
    passed: number;
    failed: number;
    errors: number;
    skipped: number;
  };
  decision: { outcome: Decision; reason: string };
  notes: string[];
}

/** Convert an evaluated condition into its JSON-safe trace form. */
export function toTraceCondition(evaluation: EvaluatedCondition): TraceCondition {
  return {
    ...evaluation,
    thresholdBaseUnits: evaluation.thresholdBaseUnits === null ? null : evaluation.thresholdBaseUnits.toString(10),
    actualRaw: evaluation.actualRaw === null ? null : evaluation.actualRaw.toString(10),
  };
}

/** Build the complete trace for a run. */
export function buildTrace(input: {
  config: GuardianConfig;
  verification: ChainVerification;
  token: (TokenMeta & { codeBytes: number | null }) | null;
  spender: { address: string; codeBytes: number | null } | null;
  evaluations: readonly EvaluatedCondition[];
  decision: Decision;
  reason: string;
  pinnedBlock: string | null;
  notes: readonly string[];
  runId?: string;
  timestamp?: Date;
}): GuardianTrace {
  const evaluations = input.evaluations;
  const traceConditions = evaluations.map(toTraceCondition);
  return {
    schema: TRACE_SCHEMA_VERSION,
    runId: input.runId ?? randomUUID(),
    timestamp: (input.timestamp ?? new Date()).toISOString(),
    network: {
      name: input.config.network.name,
      chainId: input.config.network.chainId,
      ...(input.config.network.rpcUrl !== undefined ? { rpcUrl: input.config.network.rpcUrl } : {}),
      ...(input.config.network.explorerUrl !== undefined ? { explorerUrl: input.config.network.explorerUrl } : {}),
    },
    chainVerification: input.verification,
    walletAddress: input.config.walletAddress,
    token:
      input.token === null
        ? null
        : {
            address: input.token.address,
            symbol: input.token.symbol,
            decimals: input.token.decimals,
            codeBytes: input.token.codeBytes,
            source: input.token.source,
          },
    spender: input.spender,
    action: { name: input.config.action.name, mode: input.config.action.mode },
    configPath: input.config.sourcePath,
    pinnedBlock: input.pinnedBlock,
    conditions: traceConditions,
    summary: {
      total: evaluations.length,
      enabled: evaluations.filter((evaluation) => evaluation.enabled).length,
      passed: evaluations.filter((evaluation) => evaluation.status === "PASS").length,
      failed: evaluations.filter((evaluation) => evaluation.status === "FAIL").length,
      errors: evaluations.filter((evaluation) => evaluation.status === "ERROR").length,
      skipped: evaluations.filter((evaluation) => evaluation.status === "SKIPPED").length,
    },
    decision: { outcome: input.decision, reason: input.reason },
    notes: [...input.notes],
  };
}

/**
 * Serialize a value to JSON safely: bigint values become strings, and
 * malformed structures cannot crash the run (they render as an error note).
 */
export function safeStringify(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(
      value,
      (_key, inner: unknown) => (typeof inner === "bigint" ? inner.toString(10) : inner),
      indent,
    );
  } catch (error) {
    return JSON.stringify({ serializationError: (error as Error).message });
  }
}

/** Human-readable header line for one condition in text reports. */
export function conditionHeader(evaluation: TraceCondition): string {
  return `${evaluation.label} [${evaluation.id}]`;
}
