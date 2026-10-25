/**
 * Human-readable rendering of a decision trace.
 *
 * renderTerminalReport produces the beginner-friendly console report and
 * renderMarkdownReport produces the same information for a saved .md file.
 * Both functions are pure string builders (no I/O, no console) so they are
 * easy to test and reuse.
 */

import type { GuardianTrace } from "./trace.js";
import { operatorSymbol } from "./operators.js";

const RULE = "-".repeat(72);

function conditionBlock(trace: GuardianTrace, condition: GuardianTrace["conditions"][number]): string[] {
  const lines: string[] = [];
  lines.push(`Condition: ${condition.label} [${condition.id}]`);
  if (condition.status === "SKIPPED" || !condition.enabled) {
    lines.push(`Status:    SKIPPED (disabled in configuration; not read; does not affect the decision)`);
    lines.push("");
    return lines;
  }
  if (condition.status === "ERROR") {
    lines.push(`Actual:    UNAVAILABLE`);
    lines.push(`Required:  ${operatorSymbol(condition.operator)} ${condition.thresholdFormatted} ${condition.unit}`);
    lines.push(`Source:    ${condition.source}${condition.tool === null ? "" : ` (${condition.tool})`}`);
    lines.push(`Result:    ERROR`);
    lines.push(`Why:       ${condition.error ?? "Unknown error"}`);
    lines.push("");
    return lines;
  }
  lines.push(`Actual:    ${condition.actualFormatted ?? "unknown"} ${condition.unit}`);
  lines.push(`Required:  ${operatorSymbol(condition.operator)} ${condition.thresholdFormatted} ${condition.unit}`);
  lines.push(`Source:    ${sourceLabel(condition.source)} (${condition.tool ?? "unknown tool"})`);
  lines.push(`Result:    ${condition.status}`);
  lines.push("");
  return lines;
}

export function sourceLabel(source: GuardianTrace["conditions"][number]["source"]): string {
  switch (source) {
    case "chain-mcp":
      return "Chain MCP";
    case "rpc-fallback":
      return "RPC fallback (documented read-only JSON-RPC)";
    default:
      return "no read performed";
  }
}

export function renderTerminalReport(trace: GuardianTrace, options: { verbose?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push("THRESHOLD GUARDIAN");
  lines.push(`Network:   ${trace.network.name}`);
  lines.push(`Chain ID:  ${trace.network.chainId} (verified against live chain via ${sourceLabel(trace.chainVerification.source)})`);
  lines.push(`Wallet:    ${trace.walletAddress}`);
  if (trace.pinnedBlock !== null) {
    lines.push(`Block:     ${trace.pinnedBlock} (all reads pinned to this block for consistency)`);
  }
  if (trace.token !== null) {
    lines.push(`Token:     ${trace.token.symbol} at ${trace.token.address} (${trace.token.decimals} decimals, ${trace.token.codeBytes ?? "?"} bytes of deployed code)`);
  }
  lines.push(`Action:    ${trace.action.name} (mode: ${trace.action.mode}; this tool never sends transactions)`);
  lines.push("");
  lines.push(RULE);
  for (const condition of trace.conditions) {
    lines.push(...conditionBlock(trace, condition));
    if (options.verbose === true) {
      lines.push(`           type=${condition.type} thresholdBaseUnits=${condition.thresholdBaseUnits ?? "n/a"}`);
      lines.push(`           explanation=${condition.explanation}`);
    }
  }
  lines.push(RULE);
  lines.push(`FINAL DECISION: ${trace.decision.outcome}`);
  lines.push(`Reason: ${trace.decision.reason}`);
  lines.push("");
  lines.push(
    `Summary: ${trace.summary.passed} passed, ${trace.summary.failed} failed, ${trace.summary.errors} read errors, ` +
      `${trace.summary.skipped} skipped (of ${trace.summary.total} configured, ${trace.summary.enabled} enabled).`,
  );
  if (trace.notes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const note of trace.notes) {
      lines.push(`  - ${note}`);
    }
  }
  return lines.join("\n");
}

export function renderMarkdownReport(trace: GuardianTrace): string {
  const md: string[] = [];
  md.push(`# Threshold Guardian run \`${trace.runId}\``);
  md.push("");
  md.push(`- **Timestamp:** ${trace.timestamp}`);
  md.push(`- **Network:** ${trace.network.name} (chain ID ${trace.network.chainId})`);
  md.push(`- **Wallet:** \`${trace.walletAddress}\``);
  md.push(`- **Pinned block:** ${trace.pinnedBlock ?? "n/a"}`);
  if (trace.token !== null) {
    md.push(`- **Token:** ${trace.token.symbol} (\`${trace.token.address}\`), ${trace.token.decimals} decimals, ${trace.token.codeBytes ?? "?"} bytes of code`);
  }
  if (trace.spender !== null) {
    md.push(`- **Spender:** \`${trace.spender.address}\` (${trace.spender.codeBytes ?? "?"} bytes of code)`);
  }
  md.push(`- **Action:** ${trace.action.name} (mode: ${trace.action.mode})`);
  md.push(`- **Config:** \`${trace.configPath}\``);
  md.push("");
  md.push("## Conditions");
  md.push("");
  md.push("| Condition | Type | Actual | Required | Source | Result |");
  md.push("| --- | --- | --- | --- | --- | --- |");
  for (const condition of trace.conditions) {
    const actual = condition.status === "SKIPPED" ? "not read (disabled)" : condition.status === "ERROR" ? "UNAVAILABLE" : `${condition.actualFormatted ?? "?"} ${condition.unit}`;
    const required = `${operatorSymbol(condition.operator)} ${condition.thresholdFormatted} ${condition.unit}`;
    const source = condition.status === "SKIPPED" ? "n/a" : sourceLabel(condition.source);
    md.push(`| ${condition.label} \`${condition.id}\` | ${condition.type} | ${actual} | ${required} | ${source} | **${condition.status}** |`);
  }
  md.push("");
  md.push("## Details");
  md.push("");
  for (const condition of trace.conditions) {
    md.push(`### ${condition.label} [\`${condition.id}\`]`);
    md.push("");
    if (condition.status === "ERROR") {
      md.push(`- Result: **ERROR**`);
      md.push(`- Error: ${condition.error ?? "unknown"}`);
    } else if (condition.status === "SKIPPED") {
      md.push(`- Result: **SKIPPED** (disabled)`);
    } else {
      md.push(`- Actual: ${condition.actualFormatted ?? "?"} ${condition.unit} (raw ${condition.actualRaw ?? "?"} base units)`);
      md.push(`- Required: ${operatorSymbol(condition.operator)} ${condition.thresholdFormatted} ${condition.unit} (raw ${condition.thresholdBaseUnits ?? "?"} base units)`);
      md.push(`- Source: ${sourceLabel(condition.source)} (${condition.tool ?? "?"})`);
      md.push(`- Result: **${condition.status}**`);
    }
    md.push(`- Explanation: ${condition.explanation}`);
    md.push("");
  }
  md.push("## Decision");
  md.push("");
  md.push(`**${trace.decision.outcome}** - ${trace.decision.reason}`);
  md.push("");
  if (trace.notes.length > 0) {
    md.push("## Notes");
    md.push("");
    for (const note of trace.notes) {
      md.push(`- ${note}`);
    }
    md.push("");
  }
  return md.join("\n");
}
