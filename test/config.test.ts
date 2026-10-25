import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, loadConfig, MIN_ENABLED_CONDITIONS, CONDITION_TYPES, normalizeEvmAddress } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { buildConfigObject } from "./helpers/mockPharosMcp.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function expectProblems(raw: unknown, fragments: string[]): void {
  try {
    validateConfig(raw, "test-config.json");
    assert.fail(`expected ConfigError listing: ${fragments.join(" | ")}`);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got: ${String(error)}`);
    for (const fragment of fragments) {
      assert.ok(error.message.includes(fragment), `expected error message to include "${fragment}" but was:\n${error.message}`);
    }
  }
}

test("valid example-style config passes validation", () => {
  const config = validateConfig(buildConfigObject(), "test-config.json");
  assert.equal(config.network.chainId, 688689);
  assert.equal(config.network.name, "Mock Pharos Atlantic Testnet");
  assert.equal(config.walletAddress.toLowerCase(), "0xe9edd930130bc1f97eb68c86519d4dd1ee778657");
  assert.equal(config.conditions.length, 3);
  assert.equal(config.action.mode, "decision-only");
  assert.equal(config.fallback.enabled, true);
  assert.ok(config.fallback.rpcUrl.startsWith("https://"));
});

test("addresses are normalized to checksummed form (idempotent under getAddress)", () => {
  const config = validateConfig(buildConfigObject(), "test-config.json");
  // Normalization is idempotent: re-checksumming the normalized value is a no-op.
  assert.equal(normalizeEvmAddress(config.tokenAddress, "t"), config.tokenAddress);
  assert.equal(normalizeEvmAddress(config.spenderAddress, "s"), config.spenderAddress);
  assert.equal(normalizeEvmAddress(config.walletAddress, "w"), config.walletAddress);
});

test("network problems are reported with context", () => {
  const raw = buildConfigObject();
  (raw["network"] as Record<string, unknown>)["chainId"] = "688689";
  expectProblems(raw, ["network.chainId", "positive whole number"]);

  const raw2 = buildConfigObject();
  delete (raw2["network"] as Record<string, unknown>)["name"];
  expectProblems(raw2, ["network.name", "non-empty string"]);
});

test("chainId must reject zero, negative, non-integer, and absurd values", () => {
  for (const bad of [0, -1, 1.5, 2 ** 53, "688689", null]) {
    const raw = buildConfigObject();
    (raw["network"] as Record<string, unknown>)["chainId"] = bad;
    expectProblems(raw, ["network.chainId"]);
  }
});

test("invalid wallet/token/spender addresses are rejected", () => {
  const raw = buildConfigObject({ wallet: "0x1234" });
  expectProblems(raw, ["walletAddress", "not a valid 20-byte EVM address"]);

  const raw2 = buildConfigObject();
  raw2["tokenAddress"] = "not-an-address";
  expectProblems(raw2, ["tokenAddress"]);

  const raw3 = buildConfigObject();
  raw3["spenderAddress"] = 42;
  expectProblems(raw3, ["spenderAddress"]);
});

test("mixed-case addresses with a bad EIP-55 checksum are rejected", () => {
  assert.throws(() => normalizeEvmAddress("0xE9eDD930130BC1f97EB68c86519D4Dd1EE77865X", "x"), ConfigError);
});

test("conditions array must exist and be non-empty", () => {
  const raw = buildConfigObject({ conditions: [] });
  expectProblems(raw, ["conditions", "non-empty array"]);

  const raw2 = buildConfigObject({ conditions: "nope" });
  expectProblems(raw2, ["conditions"]);
});

test("each condition type is validated against the supported list", () => {
  const raw = buildConfigObject({
    conditions: [
      { id: "a", type: "solBalance", enabled: true, operator: "gte", threshold: "1", unit: "SOL" },
      { id: "b", type: "nativeBalance", enabled: true, operator: "gte", threshold: "1", unit: "PHRS" },
      { id: "c", type: "erc20Balance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
      { id: "d", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
    ],
  });
  expectProblems(raw, ['conditions[0].type: "solBalance"', CONDITION_TYPES.join(", ")]);
});

test("enabled must be an explicit boolean", () => {
  const raw = buildConfigObject({
    conditions: [
      { id: "a", type: "nativeBalance", enabled: "yes", operator: "gte", threshold: "1", unit: "PHRS" },
      { id: "b", type: "erc20Balance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
      { id: "c", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
    ],
  });
  expectProblems(raw, ["conditions[0].enabled", "true or false"]);
});

test("unsupported operators are rejected with the supported list", () => {
  const raw = buildConfigObject({
    conditions: [
      { id: "a", type: "nativeBalance", enabled: true, operator: ">=", threshold: "1", unit: "PHRS" },
      { id: "b", type: "erc20Balance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
      { id: "c", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
    ],
  });
  expectProblems(raw, ["conditions[0].operator", "gt, gte, lt, lte, eq"]);
});

test("malformed thresholds are rejected (no floats, no negatives, no scientific notation)", () => {
  for (const bad of ["-5", "1e18", "abc", "1.2.3", ""]) {
    const raw = buildConfigObject({
      conditions: [
        { id: "a", type: "nativeBalance", enabled: true, operator: "gte", threshold: bad, unit: "PHRS" },
        { id: "b", type: "erc20Balance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
        { id: "c", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
      ],
    });
    expectProblems(raw, ["conditions[0].threshold"]);
  }
});

test("float JSON-number thresholds are rejected; safe whole numbers accepted", () => {
  const bad = buildConfigObject({
    conditions: [
      { id: "a", type: "nativeBalance", enabled: true, operator: "gte", threshold: 1.5, unit: "PHRS" },
      { id: "b", type: "erc20Balance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
      { id: "c", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
    ],
  });
  expectProblems(bad, ["conditions[0].threshold", "quoted string"]);

  const good = validateConfig(
    buildConfigObject({
      conditions: [
        { id: "a", type: "nativeBalance", enabled: true, operator: "gte", threshold: 2, unit: "PHRS" },
        { id: "b", type: "erc20Balance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
        { id: "c", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
      ],
    }),
    "test-config.json",
  );
  assert.equal(good.conditions[0]?.threshold, "2");
});

test("duplicate condition ids are rejected", () => {
  const raw = buildConfigObject({
    conditions: [
      { id: "same", type: "nativeBalance", enabled: true, operator: "gte", threshold: "1", unit: "PHRS" },
      { id: "same", type: "erc20Balance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
      { id: "other", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
    ],
  });
  expectProblems(raw, ["duplicate condition id"]);
});

test("fewer than three enabled conditions is rejected for the demonstration", () => {
  const raw = buildConfigObject({
    conditions: [
      { id: "a", type: "nativeBalance", enabled: true, operator: "gte", threshold: "1", unit: "PHRS" },
      { id: "b", type: "erc20Balance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
      { id: "c", type: "erc20Allowance", enabled: false, operator: "gte", threshold: "1", unit: "X" },
    ],
  });
  expectProblems(raw, [`at least ${MIN_ENABLED_CONDITIONS} enabled`]);
});

test("three enabled plus one disabled is accepted; disabled conditions are preserved", () => {
  const config = validateConfig(
    buildConfigObject({
      conditions: [
        { id: "a", type: "nativeBalance", enabled: true, operator: "gte", threshold: "1", unit: "PHRS" },
        { id: "b", type: "erc20Balance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
        { id: "c", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "1", unit: "X" },
        { id: "d", type: "nativeBalance", enabled: false, operator: "lt", threshold: "100", unit: "PHRS" },
      ],
    }),
    "test-config.json",
  );
  assert.equal(config.conditions.length, 4);
  assert.equal(config.conditions[3]?.enabled, false);
});

test("too many conditions are rejected to keep RPC usage bounded", () => {
  const many = Array.from({ length: 33 }, (_, index) => ({
    id: `c${index}`,
    type: "nativeBalance",
    enabled: true,
    operator: "gte",
    threshold: "1",
    unit: "PHRS",
  }));
  const raw = buildConfigObject({ conditions: many });
  expectProblems(raw, ["at most 32 conditions", "bounded"]);
});

test("action.mode must be decision-only; other modes are refused", () => {
  const raw = buildConfigObject();
  (raw["action"] as Record<string, unknown>)["mode"] = "auto-execute";
  expectProblems(raw, ["action.mode", "decision-only", "never signs or sends transactions"]);
});

test("fallback configuration is validated when present", () => {
  const raw = buildConfigObject({ fallback: { enabled: "yes", rpcUrl: "https://ok.example.com" } });
  expectProblems(raw, ["fallback.enabled"]);

  const raw2 = buildConfigObject({ fallback: { enabled: true, rpcUrl: "not-a-url" } });
  expectProblems(raw2, ["fallback.rpcUrl"]);

  const ok = validateConfig(buildConfigObject({ fallback: { enabled: false } }), "test-config.json");
  assert.equal(ok.fallback.enabled, false);
  assert.ok(ok.fallback.rpcUrl.includes("atlantic"));
});

test("loadConfig tolerates a UTF-8 BOM (common on Windows editors)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "guardian-bom-"));
  const path = join(tmp, "guardian.json");
  writeFileSync(path, "\uFEFF" + JSON.stringify(buildConfigObject(), null, 2), "utf8");
  const config = loadConfig(path);
  assert.equal(config.network.chainId, 688689);
});

test("all problems are collected in one pass, not just the first", () => {
  const raw = buildConfigObject({ wallet: "bad", chainId: -5 });
  (raw["action"] as Record<string, unknown>)["mode"] = "execute";
  expectProblems(raw, ["walletAddress", "network.chainId", "action.mode", "3 configuration problem"]);
});
