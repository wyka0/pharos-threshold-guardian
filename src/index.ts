/**
 * Threshold Guardian CLI.
 *
 * Usage:
 *   node dist/src/index.js [--config <path>] [--json] [--verbose] [--out-dir <dir>] [--no-save] [--help]
 *
 * Exit codes:
 *   0 = FIRE   (every enabled condition passed)
 *   1 = ERROR  (configuration invalid, or chain data unavailable/invalid)
 *   2 = HOLD   (at least one enabled condition failed its threshold)
 */

import { resolve } from "node:path";
import { runGuardian, EXIT_CODES } from "./guardian.js";
import { ConfigError } from "./errors.js";
import { safeStringify } from "./trace.js";

interface CliArgs {
  configPath: string;
  json: boolean;
  verbose: boolean;
  outDir: string;
  save: boolean;
  help: boolean;
}

const HELP = `
THRESHOLD GUARDIAN - Pharos Agent Arena Task 7
Evaluates configurable on-chain conditions on Pharos Atlantic Testnet and
decides whether an action should FIRE or HOLD. Read-only: this tool never
signs transactions and never asks for private keys.

Usage:
  npm run guardian [-- --config <path>] [--json] [--verbose]

Options:
  --config <path>   Path to the guardian config file
                    (default: config/guardian.json)
  --json            Print the full decision trace as JSON instead of the
                    human-readable report
  --verbose         Extra detail: tool names, base-unit values, per-read notes
  --out-dir <dir>   Directory for saved traces (default: artifacts/runs)
  --no-save         Do not write trace artifacts to disk
  --help            Show this help

Exit codes:
  0 = FIRE  (every enabled condition passed)
  2 = HOLD  (at least one enabled condition failed)
  1 = ERROR (bad configuration or chain data unavailable)

Environment:
  GUARDIAN_MCP_ENDPOINT  Override the Pharos Chain MCP endpoint
                         (default: http://127.0.0.1:3999/mcp)

Docs: README.md, docs/configuration.md, docs/architecture.md
`.trimStart();

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    configPath: "config/guardian.json",
    json: false,
    verbose: false,
    outDir: "artifacts/runs",
    save: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--config": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          writeOut(`Error: --config requires a file path argument.\n\n${HELP}`);
          process.exit(EXIT_CODES.ERROR);
        }
        args.configPath = value;
        i++;
        break;
      }
      case "--json":
        args.json = true;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--out-dir": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("--")) {
          writeOut(`Error: --out-dir requires a directory path argument.\n\n${HELP}`);
          process.exit(EXIT_CODES.ERROR);
        }
        args.outDir = value;
        i++;
        break;
      }
      case "--no-save":
        args.save = false;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        writeOut(`Error: unknown argument "${arg}".\n\n${HELP}`);
        process.exit(EXIT_CODES.ERROR);
    }
  }
  return args;
}

function writeOut(text: string): void {
  process.stdout.write(text);
}

function writeErr(text: string): void {
  process.stderr.write(text);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    writeOut(HELP);
    process.exit(EXIT_CODES.ERROR);
    return;
  }

  const configPath = resolve(args.configPath);

  let result;
  try {
    result = await runGuardian({
      configPath,
      outDir: resolve(args.outDir),
      saveArtifacts: args.save,
      verbose: args.verbose,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      writeErr(`\nCONFIGURATION PROBLEM\n${error.message}\n\nFix the config file and run again. See docs/configuration.md for examples.\n`);
      process.exit(EXIT_CODES.ERROR);
      return;
    }
    writeErr(`\nUNEXPECTED FAILURE\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(EXIT_CODES.ERROR);
    return;
  }

  if (args.json) {
    writeOut(safeStringify(result.trace, 2) + "\n");
  } else {
    writeOut("\n" + result.report);
  }

  if (!args.json && result.decision === "HOLD") {
    writeOut("Next step: review the failing conditions above. A HOLD is the safe outcome when a threshold is not met.\n");
  }

  process.exit(result.exitCode);
}

main().catch((error: unknown) => {
  writeErr(`\nFATAL\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(EXIT_CODES.ERROR);
});
