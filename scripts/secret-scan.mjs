#!/usr/bin/env node
/**
 * Secret scan for Threshold Guardian.
 *
 * Scans every tracked text file (or every file on disk when git is not
 * available) for patterns that indicate leaked secrets:
 *   - 64-hex-digit strings (private keys are 32 bytes = 64 hex chars)
 *   - explicit secret-style assignments (private key / mnemonic / seed)
 *   - the presence of committed .env files
 *
 * A line can opt out with a trailing "secret-scan:allow" marker (used only
 * for truncated example hashes in documentation).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const ALLOW_MARKER = "secret-scan:allow";

const HEX64_PATTERN = /\b0x[0-9a-fA-F]{64}\b/;
const SECRET_ASSIGNMENT_PATTERN = /(private[_-]?key|mnemonic|seed[_-]?phrase|secret[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9+/]{16,}/i;
const TEXT_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".txt", ".yml", ".yaml", ".mjs", ".example", ".gitignore"]);
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".eslintcache"]);

function listFilesViaGit() {
  try {
    const output = execSync("git ls-files", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split(/\r?\n/).filter((line) => line.trim().length > 0);
  } catch {
    return null;
  }
}

function listFilesRecursively(dir, collected) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const base = entry;
    if (SKIP_DIRS.has(base) || base === ".eslintcache") {
      continue;
    }
    const stats = statSync(full, { throwIfNoEntry: false });
    if (stats === undefined) {
      continue;
    }
    if (stats.isDirectory()) {
      listFilesRecursively(full, collected);
    } else {
      collected.push(full);
    }
  }
}

function shouldScanFile(path) {
  if (path.endsWith(".env") || /^\.env\./.test(path.split(sep).pop() ?? "")) {
    return true; // always scan .env-style names
  }
  const ext = path.slice(path.lastIndexOf("."));
  return TEXT_EXTENSIONS.has(ext) || path.endsWith("Dockerfile") || !path.includes(".");
}

const gitFiles = listFilesViaGit();
const candidates = gitFiles !== null ? gitFiles.map((file) => join(ROOT, file)) : [];
if (gitFiles === null) {
  const collected = [];
  listFilesRecursively(ROOT, collected);
  candidates.push(...collected);
}

const findings = [];

// Committed .env files are themselves a finding.
for (const file of candidates) {
  const rel = relative(ROOT, file).split(sep).join("/");
  const base = rel.split("/").pop() ?? "";
  if ((base === ".env" || base.startsWith(".env.")) && base !== ".env.example" && existsSync(file)) {
    findings.push(`${rel}: committed .env file (.env files must never be committed)`);
  }
}

for (const file of candidates) {
  if (!shouldScanFile(file) || !existsSync(file) || !statSync(file).isFile()) {
    continue;
  }
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const rel = relative(ROOT, file).split(sep).join("/");
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.includes(ALLOW_MARKER)) {
      continue;
    }
    if (HEX64_PATTERN.test(line)) {
      findings.push(`${rel}:${index + 1}: possible private key (64 hex chars) -> ${truncate(line.trim())}`);
    } else if (SECRET_ASSIGNMENT_PATTERN.test(line)) {
      findings.push(`${rel}:${index + 1}: possible secret assignment -> ${truncate(line.trim())}`);
    }
  }
}

function truncate(text) {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

if (findings.length > 0) {
  process.stdout.write(`SECRET SCAN FAILED - ${findings.length} finding(s):\n`);
  for (const finding of findings) {
    process.stdout.write(`  - ${finding}\n`);
  }
  process.stdout.write("\nRemove the secret, replace it with a placeholder, or (for non-secret long hashes in docs) add a trailing `secret-scan:allow` marker.\n");
  process.exit(1);
}

process.stdout.write("Secret scan passed: no private keys, mnemonics, or committed .env files found.\n");
process.exit(0);
