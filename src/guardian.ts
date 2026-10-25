/**
 * Guardian orchestrator: configuration -> chain reads -> decision -> trace.
 *
 * Run pipeline (read-only end to end; nothing here can sign or broadcast):
 *   1. Load and validate the config file.
 *   2. Verify the live chain matches the configured network (chain ID) and
 *      capture the latest block; every subsequent read is pinned to it.
 *   3. Read token metadata (decimals, symbol) and confirm deployed code.
 *   4. Read each ENABLED condition independently (MCP first, documented
 *      JSON-RPC fallback second). Disabled conditions are not read at all.
 *   5. Evaluate conditions and decide FIRE / HOLD / ERROR (pure evaluator).
 *   6. Persist the trace under artifacts/runs/ (JSON + Markdown) and render
 *      a human-readable report.
 *
 * Exit-code mapping lives in the CLI (FIRE=0, HOLD=2, ERROR=1); the
 * orchestrator returns the decision so tests can assert on it directly.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ChainMcpClient, DEFAULT_MCP_ENDPOINT } from "./chain/mcpClient.js";
import { FallbackRpcClient, hexToDecimalString } from "./chain/fallbackRpc.js";
import { readNativeBalance, readErc20Balance, readErc20Allowance, readTokenMeta, readCodeSize, NATIVE_DECIMALS, type ReaderContext, type ReadResult, type DataSource } from "./chain/readers.js";
import { evaluateCondition, decide, type EvaluatedCondition } from "./evaluator.js";
import { buildTrace, safeStringify, type GuardianTrace, type ChainVerification } from "./trace.js";
import { renderTerminalReport, renderMarkdownReport } from "./report.js";
import { loadConfig, type GuardianConfig } from "./config.js";
import { formatBaseUnits } from "./decimal.js";

export const EXIT_CODES = { FIRE: 0, ERROR: 1, HOLD: 2 } as const;

export interface GuardianRunOptions {
  configPath: string;
  /** Directory for trace artifacts. Default: artifacts/runs (relative to cwd). */
  outDir?: string;
  /** Set false to skip writing artifacts (tests). Default true. */
  saveArtifacts?: boolean;
  /** MCP endpoint override (default env GUARDIAN_MCP_ENDPOINT or the local official server). */
  mcpEndpoint?: string;
  /** Override MCP retry budget (tests). */
  mcpMaxRetries?: number;
  /** Injectable fetch for tests (applies to MCP + fallback clients). */
  fetchImpl?: typeof fetch;
  /** Injectable clock/ids for deterministic tests. */
  now?: () => Date;
  runId?: string;
  verbose?: boolean;
}

export interface GuardianRunResult {
  decision: GuardianTrace["decision"]["outcome"];
  exitCode: number;
  trace: GuardianTrace;
  report: string;
  traceJsonPath: string | null;
  traceMarkdownPath: string | null;
}

interface ChainState {
  verification: ChainVerification;
  pinnedBlock: string | null;
}

/** Verify the live chain matches the config; returns verification + block. */
async function verifyChain(config: GuardianConfig, mcp: ChainMcpClient | null, fallback: FallbackRpcClient | null): Promise<{ state: ChainState | null; error: string | null; warnings: string[] }> {
  const warnings: string[] = [];

  if (mcp !== null) {
    try {
      const info = (await mcp.callTool("get_chain_info")) as {
        chainId?: number | string;
        latestBlock?: string;
        nativeSymbol?: string;
        clientVersion?: string;
        chainIdMatches?: boolean;
      };
      const chainId = Number(info.chainId);
      if (!Number.isSafeInteger(chainId) || chainId <= 0) {
        throw new Error(`get_chain_info returned an unusable chainId: ${JSON.stringify(info.chainId)}`);
      }
      const matches = chainId === config.network.chainId;
      const verification: ChainVerification = {
        source: "chain-mcp",
        chainId,
        chainIdMatchesConfig: matches,
        latestBlock: typeof info.latestBlock === "string" ? info.latestBlock : null,
        clientVersion: typeof info.clientVersion === "string" ? info.clientVersion : null,
        nativeSymbol: typeof info.nativeSymbol === "string" ? info.nativeSymbol : null,
      };
      if (!matches) {
        return {
          state: null,
          error:
            `Network mismatch: configuration expects chain ID ${config.network.chainId} ("${config.network.name}") ` +
            `but the live chain reports ${chainId}. Refusing to read conditions against the wrong network.`,
          warnings,
        };
      }
      return {
        state: { verification, pinnedBlock: verification.latestBlock },
        error: null,
        warnings,
      };
    } catch (error) {
      warnings.push(`Chain MCP verification failed: ${(error as Error).message}`);
    }
  } else {
    warnings.push("Chain MCP client unavailable; verification will use the JSON-RPC fallback.");
  }

  if (fallback !== null) {
    try {
      const chainIdHex = await fallback.chainId();
      const chainId = Number(BigInt(chainIdHex));
      const matches = chainId === config.network.chainId;
      if (!matches) {
        return {
          state: null,
          error:
            `Network mismatch: configuration expects chain ID ${config.network.chainId} ("${config.network.name}") ` +
            `but the fallback RPC reports ${chainId}. Refusing to read conditions against the wrong network.`,
          warnings,
        };
      }
      let latestBlock: string | null = null;
      try {
        latestBlock = hexToDecimalString(await fallback.blockNumber());
      } catch {
        latestBlock = null;
      }
      return {
        state: {
          verification: {
            source: "rpc-fallback",
            chainId,
            chainIdMatchesConfig: true,
            latestBlock,
            clientVersion: null,
            nativeSymbol: null,
          },
          pinnedBlock: latestBlock,
        },
        error: null,
        warnings,
      };
    } catch (error) {
      warnings.push(`Fallback RPC verification failed: ${(error as Error).message}`);
    }
  }

  return { state: null, error: "No chain endpoint could verify the network (Chain MCP and JSON-RPC fallback both failed).", warnings };
}

function toBlockHex(decimal: string): string {
  return `0x${BigInt(decimal).toString(16)}`;
}

/** Read one enabled condition (dispatch by type). */
async function readConditionValue(condition: GuardianConfig["conditions"][number], ctx: ReaderContext): Promise<ReadResult> {
  switch (condition.type) {
    case "nativeBalance":
      return readNativeBalance(ctx);
    case "erc20Balance":
      return readErc20Balance(ctx);
    case "erc20Allowance":
      return readErc20Allowance(ctx);
  }
}

/** Run the guardian end-to-end. Never throws for decision outcomes; only
 * truly unexpected internal errors may throw. */
export async function runGuardian(options: GuardianRunOptions): Promise<GuardianRunResult> {
  const saveArtifacts = options.saveArtifacts ?? true;
  const verbose = options.verbose ?? false;
  const notes: string[] = [];

  const config = loadConfig(options.configPath);
  notes.push(`Configuration loaded from ${config.sourcePath}.`);

  const mcpEndpoint = options.mcpEndpoint ?? process.env["GUARDIAN_MCP_ENDPOINT"] ?? DEFAULT_MCP_ENDPOINT;
  const fetchImpl = options.fetchImpl ?? fetch;

  const mcp = new ChainMcpClient({ endpoint: mcpEndpoint, fetchImpl, ...(options.mcpMaxRetries !== undefined ? { maxRetries: options.mcpMaxRetries } : {}) });
  const fallback = config.fallback.enabled ? new FallbackRpcClient(config.fallback.rpcUrl, 20_000, fetchImpl) : null;
  if (!config.fallback.enabled) {
    notes.push("JSON-RPC fallback is disabled by configuration: reads are MCP-only for this run.");
  }

  // 1. Verify the network before any condition read.
  const { state: chainState, error: chainError, warnings } = await verifyChain(config, mcp, fallback);
  notes.push(...warnings);

  const timestamp = options.now ?? (() => new Date());
  const runId = options.runId;

  if (chainState === null) {
    const verification: ChainVerification = {
      source: "none",
      chainId: config.network.chainId,
      chainIdMatchesConfig: false,
      latestBlock: null,
      clientVersion: null,
      nativeSymbol: null,
    };
    const trace = buildTrace({
      config,
      verification,
      token: null,
      spender: null,
      evaluations: [],
      decision: "ERROR",
      reason: chainError ?? "Chain verification failed.",
      pinnedBlock: null,
      notes,
      runId,
      timestamp: timestamp(),
    });
    const paths = saveArtifacts ? persistTrace(trace, options.outDir ?? "artifacts/runs") : { jsonPath: null, markdownPath: null };
    return {
      decision: "ERROR",
      exitCode: EXIT_CODES.ERROR,
      trace,
      report: renderTerminalReport(trace, { verbose }),
      traceJsonPath: paths.jsonPath,
      traceMarkdownPath: paths.markdownPath,
    };
  }

  notes.push(`Chain verified: live chain ID ${chainState.verification.chainId} matches configured chain ID ${config.network.chainId} (source: ${chainState.verification.source === "chain-mcp" ? "Chain MCP get_chain_info" : "documented JSON-RPC fallback eth_chainId"}).`);
  if (chainState.pinnedBlock !== null) {
    notes.push(`All condition reads in this run are pinned to block ${chainState.pinnedBlock} so the three values describe one consistent state.`);
  }

  // 2. Token metadata (needed to scale thresholds for ERC-20 conditions).
  const ctxBase: ReaderContext = {
    mcp,
    fallback,
    blockTagDecimal: chainState.pinnedBlock ?? "latest",
    blockTagHex: chainState.pinnedBlock !== null ? toBlockHex(chainState.pinnedBlock) : "latest",
    token: null,
    walletAddress: config.walletAddress,
    spenderAddress: config.spenderAddress,
  };

  const needsTokenMeta = config.conditions.some((condition) => condition.enabled && (condition.type === "erc20Balance" || condition.type === "erc20Allowance"));
  let tokenMeta = null;
  let tokenMetaError: string | null = null;
  if (needsTokenMeta) {
    const metaResult = await readTokenMeta(ctxBase, config.tokenAddress);
    if (metaResult.meta !== null) {
      tokenMeta = metaResult.meta;
      ctxBase.token = tokenMeta;
      notes.push(`Token metadata: symbol ${tokenMeta.symbol}, ${tokenMeta.decimals} decimals (source: ${tokenMeta.source === "chain-mcp" ? "Chain MCP eth_call" : "documented JSON-RPC fallback eth_call"}).`);
      const configuredErc20Units = new Set(config.conditions.filter((condition) => condition.type !== "nativeBalance").map((condition) => condition.unit.toLowerCase()));
      if (configuredErc20Units.size > 0 && !configuredErc20Units.has(tokenMeta.symbol.toLowerCase())) {
        notes.push(`Warning: configured unit(s) ${[...configuredErc20Units].join("/")} do not match the on-chain token symbol ${tokenMeta.symbol}. Reports use the configured unit for labels, but comparisons use on-chain decimals.`);
      }
    } else {
      tokenMetaError = metaResult.error;
      notes.push(`Token metadata could not be read: ${tokenMetaError}`);
    }
  }

  // 3. Confirm deployed code exists at the token (and spender) addresses.
  let tokenCodeBytes: number | null = null;
  let spenderCode: { address: string; codeBytes: number | null } | null = null;
  if (needsTokenMeta) {
    const codeResult = await readCodeSize(ctxBase, config.tokenAddress);
    tokenCodeBytes = codeResult.bytes;
    if (codeResult.error !== null) {
      notes.push(`Token code check failed: ${codeResult.error}`);
    } else if (tokenCodeBytes === 0) {
      notes.push(`Warning: no deployed code found at token address ${config.tokenAddress}; ERC-20 reads will likely fail.`);
    } else {
      notes.push(`Token contract code confirmed at ${config.tokenAddress} (${tokenCodeBytes} bytes).`);
    }
    const spenderCodeResult = await readCodeSize(ctxBase, config.spenderAddress);
    spenderCode = { address: config.spenderAddress, codeBytes: spenderCodeResult.bytes };
    if (spenderCodeResult.error !== null) {
      notes.push(`Spender code check failed: ${spenderCodeResult.error}`);
    } else if (spenderCode.codeBytes === 0) {
      notes.push(`Note: spender ${config.spenderAddress} is an EOA (no code). Allowance is still meaningful for planned approvals.`);
    } else {
      notes.push(`Spender contract code confirmed at ${config.spenderAddress} (${spenderCode.codeBytes} bytes).`);
    }
  }

  // 4. Read each enabled condition independently.
  const evaluations: EvaluatedCondition[] = [];
  for (const condition of config.conditions) {
    if (!condition.enabled) {
      evaluations.push(evaluateCondition(condition, null));
      continue;
    }
    let read: ReadResult;
    try {
      read = await readConditionValue(condition, ctxBase);
    } catch (error) {
      read = { ok: false, source: "none", tool: null, error: `Unexpected reader failure: ${(error as Error).message}` };
    }
    let evaluation: EvaluatedCondition;
    try {
      evaluation = evaluateCondition(condition, read);
    } catch (error) {
      // A malformed threshold should have been caught by config validation;
      // treat it as an ERROR condition rather than crashing the run.
      evaluation = {
        ...evaluateCondition(condition, null),
        status: "ERROR",
        error: `Threshold could not be applied to chain data: ${(error as Error).message}`,
      } as EvaluatedCondition;
    }
    evaluations.push(evaluation);

    // Cross-check the configured unit against what the chain reports.
    if (read.ok) {
      if (condition.type === "nativeBalance" && chainState.verification.nativeSymbol !== null && chainState.verification.nativeSymbol !== condition.unit) {
        notes.push(`Warning: condition "${condition.id}" uses unit ${condition.unit} but the chain reports native symbol ${chainState.verification.nativeSymbol}.`);
      }
      if ((condition.type === "erc20Balance" || condition.type === "erc20Allowance") && tokenMeta !== null && tokenMeta.symbol !== condition.unit) {
        notes.push(`Warning: condition "${condition.id}" uses unit ${condition.unit} but the on-chain token symbol is ${tokenMeta.symbol}.`);
      }
    }
    if (verbose) {
      notes.push(`Read ${condition.id}: ${read.ok ? `raw=${read.raw.toString(10)} via ${read.source}` : `failed (${read.error})`}`);
    }
  }

  // 5. Decide (pure evaluation, no I/O).
  const { outcome, reason } = decide(evaluations);

  const trace = buildTrace({
    config,
    verification: chainState.verification,
    token: tokenMeta !== null ? { ...tokenMeta, codeBytes: tokenCodeBytes } : null,
    spender: spenderCode,
    evaluations,
    decision: outcome,
    reason,
    pinnedBlock: chainState.pinnedBlock,
    notes,
    runId,
    timestamp: timestamp(),
  });

  // 6. Persist artifacts and render the report.
  const paths = saveArtifacts ? persistTrace(trace, options.outDir ?? "artifacts/runs") : { jsonPath: null, markdownPath: null };
  const reportLines = renderTerminalReport(trace, { verbose });
  const report = paths.jsonPath !== null ? `${reportLines}\nTrace saved: ${paths.jsonPath}\nMarkdown report: ${paths.markdownPath}\n` : `${reportLines}\n`;

  return {
    decision: outcome,
    exitCode: EXIT_CODES[outcome],
    trace,
    report,
    traceJsonPath: paths.jsonPath,
    traceMarkdownPath: paths.markdownPath,
  };
}

/** Write the trace JSON + Markdown under the output directory. */
function persistTrace(trace: GuardianTrace, outDir: string): { jsonPath: string | null; markdownPath: string | null } {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  const stamp = trace.timestamp.replace(/[:.]/g, "-");
  const base = `${stamp}_${trace.decision.outcome}_${trace.runId}`;
  const jsonPath = join(dir, `${base}.json`);
  const markdownPath = join(dir, `${base}.md`);
  writeFileSync(jsonPath, safeStringify(trace, 2) + "\n", "utf8");
  writeFileSync(markdownPath, renderMarkdownReport(trace), "utf8");
  return { jsonPath, markdownPath };
}

/** Re-export for the CLI/tests. */
export { formatBaseUnits, NATIVE_DECIMALS, type DataSource };
