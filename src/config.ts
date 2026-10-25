/**
 * Configuration loading and validation for Threshold Guardian.
 *
 * The config file is the single place a user tunes behaviour: network,
 * wallet, token/spender addresses, the condition list with thresholds, and
 * the action description. Validation is strict and collects ALL problems so
 * a beginner can fix their file in one pass.
 *
 * No private key, mnemonic, or signing material is ever read here. This
 * project is read-only.
 */

import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { ConfigError } from "./errors.js";
import { isOperator, type Operator } from "./operators.js";
import { normalizeThresholdInput, isPlainDecimalString } from "./decimal.js";

/** Condition types supported by the guardian. */
export const CONDITION_TYPES = ["nativeBalance", "erc20Balance", "erc20Allowance"] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

/**
 * The demonstration requires at least three enabled, independent conditions.
 * Fewer than three would not exercise the multi-condition gate this Skill is
 * built to prove.
 */
export const MIN_ENABLED_CONDITIONS = 3;

/** Upper bound on configured conditions; guards against runaway RPC usage. */
export const MAX_CONDITIONS = 32;

export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl?: string;
  explorerUrl?: string;
}

export interface ConditionConfig {
  id: string;
  type: ConditionType;
  enabled: boolean;
  operator: Operator;
  /** Human-readable threshold exactly as written in the config file. */
  threshold: string;
  unit: string;
  /** Optional human-friendly label used in reports. */
  label?: string;
}

export interface ActionConfig {
  name: string;
  mode: "decision-only";
}

export interface FallbackConfig {
  enabled: boolean;
  rpcUrl: string;
}

export interface GuardianConfig {
  network: NetworkConfig;
  walletAddress: string;
  tokenAddress: string;
  spenderAddress: string;
  conditions: ConditionConfig[];
  action: ActionConfig;
  fallback: FallbackConfig;
  /** Absolute or cwd-relative path the config was loaded from. */
  sourcePath: string;
}

const DEFAULT_FALLBACK_RPC_URL = "https://atlantic.dplabs-internal.com";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Validate an EVM address and normalize it to checksummed form.
 * Accepts all-lowercase / all-uppercase input; rejects malformed hex.
 */
export function normalizeEvmAddress(value: unknown, context: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new ConfigError(`${context}: "${String(value)}" is not a valid 20-byte EVM address (expected 0x followed by 40 hex characters).`);
  }
  try {
    return getAddress(value);
  } catch {
    // getAddress rejects mixed-case strings with a bad EIP-55 checksum.
    throw new ConfigError(
      `${context}: "${value}" has an invalid EIP-55 checksum. Use an all-lowercase address or copy the checksummed form.`,
    );
  }
}

function expectNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError(`${context}: must be a non-empty string.`);
  }
  return value.trim();
}

function expectHttpsUrl(value: unknown, context: string): string {
  const url = expectNonEmptyString(value, context);
  if (!isHttpUrl(url)) {
    throw new ConfigError(`${context}: "${url}" is not a valid http(s) URL.`);
  }
  return url;
}

/**
 * Validate an already-parsed config object. Throws ConfigError listing every
 * problem found (not just the first one).
 */
export function validateConfig(raw: unknown, sourcePath: string): GuardianConfig {
  const problems: string[] = [];
  const collect = (problem: string): void => {
    problems.push(problem);
  };

  if (!isPlainObject(raw)) {
    throw new ConfigError(`${sourcePath}: top level of the config file must be a JSON object.`);
  }

  // --- network ---------------------------------------------------------
  const networkRaw = raw["network"];
  let networkName = "";
  let chainId = 0;
  let networkRpcUrl: string | undefined;
  let explorerUrl: string | undefined;
  if (!isPlainObject(networkRaw)) {
    collect("network: must be an object with a name and a chainId.");
  } else {
    try {
      networkName = expectNonEmptyString(networkRaw["name"], "network.name");
    } catch (error) {
      collect((error as Error).message);
    }
    const chainIdRaw = networkRaw["chainId"];
    if (typeof chainIdRaw !== "number" || !Number.isSafeInteger(chainIdRaw) || chainIdRaw <= 0 || chainIdRaw > 4294967295) {
      collect(`network.chainId: must be a positive whole number (got ${JSON.stringify(chainIdRaw)}).`);
    } else {
      chainId = chainIdRaw;
    }
    if (networkRaw["rpcUrl"] !== undefined) {
      try {
        networkRpcUrl = expectHttpsUrl(networkRaw["rpcUrl"], "network.rpcUrl");
      } catch (error) {
        collect((error as Error).message);
      }
    }
    if (networkRaw["explorerUrl"] !== undefined) {
      try {
        explorerUrl = expectHttpsUrl(networkRaw["explorerUrl"], "network.explorerUrl");
      } catch (error) {
        collect((error as Error).message);
      }
    }
  }

  // --- addresses -------------------------------------------------------
  let walletAddress = "";
  let tokenAddress = "";
  let spenderAddress = "";
  try {
    walletAddress = normalizeEvmAddress(raw["walletAddress"], "walletAddress");
  } catch (error) {
    collect((error as Error).message);
  }
  try {
    tokenAddress = normalizeEvmAddress(raw["tokenAddress"], "tokenAddress");
  } catch (error) {
    collect((error as Error).message);
  }
  try {
    spenderAddress = normalizeEvmAddress(raw["spenderAddress"], "spenderAddress");
  } catch (error) {
    collect((error as Error).message);
  }

  // --- conditions ------------------------------------------------------
  const conditionsRaw = raw["conditions"];
  const conditions: ConditionConfig[] = [];
  if (!Array.isArray(conditionsRaw) || conditionsRaw.length === 0) {
    collect("conditions: must be a non-empty array of condition objects.");
  } else {
    if (conditionsRaw.length > MAX_CONDITIONS) {
      collect(`conditions: at most ${MAX_CONDITIONS} conditions are allowed (got ${conditionsRaw.length}). This limit keeps RPC usage bounded.`);
    }
    const seenIds = new Set<string>();
    for (const [index, entry] of conditionsRaw.entries()) {
      const context = `conditions[${index}]`;
      if (!isPlainObject(entry)) {
        collect(`${context}: must be an object.`);
        continue;
      }
      const id = (() => {
        try {
          return expectNonEmptyString(entry["id"], `${context}.id`);
        } catch (error) {
          collect((error as Error).message);
          return `__invalid_${index}`;
        }
      })();
      if (seenIds.has(id)) {
        collect(`${context}.id: duplicate condition id "${id}". Condition ids must be unique.`);
      }
      seenIds.add(id);

      const type = entry["type"];
      if (typeof type !== "string" || !(CONDITION_TYPES as readonly string[]).includes(type)) {
        collect(
          `${context}.type: "${String(type)}" is not a supported condition type. ` +
            `Supported types: ${CONDITION_TYPES.join(", ")}.`,
        );
      }

      const enabled = entry["enabled"];
      if (typeof enabled !== "boolean") {
        collect(`${context}.enabled: must be true or false (got ${JSON.stringify(enabled)}).`);
      }

      const operator = entry["operator"];
      if (!isOperator(operator)) {
        collect(
          `${context}.operator: "${String(operator)}" is not a supported operator. ` +
            `Supported operators: gt, gte, lt, lte, eq.`,
        );
      }

      let threshold = "";
      try {
        const normalized = normalizeThresholdInput(entry["threshold"], `${context}.threshold`);
        if (!isPlainDecimalString(normalized)) {
          throw new ConfigError(
            `must be a non-negative decimal string like "1" or "0.05" (no negatives, no scientific notation).`,
          );
        }
        threshold = normalized;
      } catch (error) {
        collect(`${context}.threshold: ${(error as Error).message}`);
      }

      let unit = "";
      try {
        unit = expectNonEmptyString(entry["unit"], `${context}.unit`);
      } catch (error) {
        collect((error as Error).message);
      }

      let label: string | undefined;
      if (entry["label"] !== undefined) {
        try {
          label = expectNonEmptyString(entry["label"], `${context}.label`);
        } catch (error) {
          collect((error as Error).message);
        }
      }

      if (id !== `__invalid_${index}` && typeof type === "string" && typeof enabled === "boolean" && isOperator(operator) && threshold !== "" && unit !== "") {
        conditions.push({
          id,
          type: type as ConditionType,
          enabled,
          operator,
          threshold,
          unit,
          ...(label !== undefined ? { label } : {}),
        });
      }
    }
  }

  // --- action ----------------------------------------------------------
  let actionName = "";
  let actionModeRaw: unknown;
  if (!isPlainObject(raw["action"])) {
    collect("action: must be an object with a name and a mode.");
  } else {
    const actionRaw = raw["action"] as Record<string, unknown>;
    try {
      actionName = expectNonEmptyString(actionRaw["name"], "action.name");
    } catch (error) {
      collect((error as Error).message);
    }
    actionModeRaw = actionRaw["mode"];
  }
  if (actionModeRaw !== "decision-only") {
    collect(
      `action.mode: ${JSON.stringify(actionModeRaw ?? null)} is not supported. ` +
        `Threshold Guardian is a read-only decision skill; the only supported mode is "decision-only". ` +
        `It never signs or sends transactions.`,
    );
  }

  // --- fallback (optional) ----------------------------------------------
  let fallbackEnabled = true;
  let fallbackRpcUrl = DEFAULT_FALLBACK_RPC_URL;
  if (raw["fallback"] !== undefined) {
    const fallbackRaw = raw["fallback"];
    if (!isPlainObject(fallbackRaw)) {
      collect("fallback: must be an object with an enabled flag and an rpcUrl.");
    } else {
      const fallback = fallbackRaw;
      if (typeof fallback["enabled"] !== "boolean") {
        collect(`fallback.enabled: must be true or false (got ${JSON.stringify(fallback["enabled"])}).`);
      } else {
        fallbackEnabled = fallback["enabled"] as boolean;
      }
      if (fallback["rpcUrl"] !== undefined) {
        try {
          fallbackRpcUrl = expectHttpsUrl(fallback["rpcUrl"], "fallback.rpcUrl");
        } catch (error) {
          collect((error as Error).message);
        }
      }
    }
  }

  // --- enabled-conditions policy -----------------------------------------
  const enabledCount = conditions.filter((condition) => condition.enabled).length;
  if (conditions.length > 0 && enabledCount < MIN_ENABLED_CONDITIONS) {
    collect(
      `conditions: at least ${MIN_ENABLED_CONDITIONS} enabled, independent conditions are required for the ` +
        `demonstration (found ${enabledCount} enabled of ${conditions.length} configured). ` +
        `Enable more conditions or add new ones.`,
    );
  }

  if (problems.length > 0) {
    const bulletList = problems.map((problem) => `  - ${problem}`).join("\n");
    throw new ConfigError(
      `${sourcePath} contains ${problems.length} configuration problem${problems.length === 1 ? "" : "s"}:\n${bulletList}`,
    );
  }

  return {
    network: {
      name: networkName,
      chainId,
      ...(networkRpcUrl !== undefined ? { rpcUrl: networkRpcUrl } : {}),
      ...(explorerUrl !== undefined ? { explorerUrl: explorerUrl } : {}),
    },
    walletAddress,
    tokenAddress,
    spenderAddress,
    conditions,
    action: { name: actionName, mode: "decision-only" },
    fallback: { enabled: fallbackEnabled, rpcUrl: fallbackRpcUrl },
    sourcePath,
  };
}

/**
 * Load and validate a guardian config file.
 * Throws ConfigError (with an understandable message) for any problem.
 */
export function loadConfig(path: string): GuardianConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "file does not exist" : `could not be read (${(error as Error).message})`;
    throw new ConfigError(`Config file "${path}" ${reason}. Pass a different path with --config, or create the file (see docs/configuration.md).`);
  }

  let raw: unknown;
  try {
    // Strip a UTF-8 BOM if present (common when files are edited on Windows).
    const cleanText = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    raw = JSON.parse(cleanText);
  } catch (error) {
    throw new ConfigError(`Config file "${path}" is not valid JSON: ${(error as Error).message}`);
  }

  return validateConfig(raw, path);
}
