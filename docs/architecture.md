# Threshold Guardian — Architecture

## 1. Overview

Threshold Guardian answers one question with auditable evidence: *should the
guarded action fire right now, given real on-chain state?* It is a
**decision-only** Skill: it reads, evaluates, explains, and records. It never
signs, never broadcasts, and never holds secrets.

## 2. Module map

```
src/index.ts                 CLI: arg parsing, help, exit codes (0/2/1)
src/guardian.ts              Orchestrator: pipeline + artifact persistence
src/config.ts                Config loading + strict validation
src/evaluator.ts             Pure decision engine (no I/O)
src/operators.ts             gt/gte/lt/lte/eq over bigint base units
src/decimal.ts               Decimal-string <-> base-unit conversion (viem parseUnits/formatUnits + strict guards)
src/trace.ts                 Trace types, builder, bigint-safe serialization
src/report.ts                Terminal + Markdown renderers (pure string builders)
src/errors.ts                ConfigError / ChainDataError / NetworkMismatchError
src/chain/mcpClient.ts       Streamable-HTTP JSON-RPC 2.0 MCP client (read-only tools)
src/chain/fallbackRpc.ts     Documented read-only JSON-RPC fallback (eth_* only)
src/chain/erc20.ts           Read-only ERC-20 encoding/decoding (viem, view functions only)
src/chain/readers.ts         The three condition readers + token metadata + code checks
```

## 3. Run pipeline

1. **Load + validate config** (`config.ts`). Validation collects *all*
   problems before failing, so a beginner can fix their file in one pass.
   Rules include: EVM address format, chain ID sanity, supported condition
   types/operators, decimal-string thresholds, unique condition ids, at
   least three enabled conditions (the demonstration bar), a maximum of 32
   conditions (bounds RPC usage), and `action.mode` locked to
   `decision-only`.
2. **Verify the network** before any condition read. `get_chain_info` via
   MCP (or `eth_chainId` via the fallback) must equal
   `network.chainId` (688689). A mismatch aborts with ERROR — the guardian
   refuses to reason about the wrong chain. The verification also captures
   the latest block, which pins **all** subsequent reads so the conditions
   describe one consistent state.
3. **Token metadata** (decimals + symbol) is read once per run. It is needed
   to scale configured thresholds into base units. A unit/symbol mismatch
   between config and chain is recorded as a warning note, not an error
   (labels stay as configured; comparisons use on-chain decimals).
4. **Contract existence** (`get_code`) for the token and spender addresses
   confirms deployed code before relying on the contracts (recorded as byte
   sizes in the trace).
5. **Condition reads** — each *enabled* condition is read independently by
   type. Disabled conditions are skipped without any RPC call. Each reader
   tries the official Chain MCP tool first; only if that fails does it use
   the documented JSON-RPC fallback, and the trace records which path
   produced the value (`chain-mcp` vs `rpc-fallback`). Empty `eth_call`
   results ("0x") and malformed payloads are read failures — never zeroes,
   never passes.
6. **Evaluation** (`evaluator.ts`, pure): thresholds are parsed to base
   units with the *observed* on-chain decimals and compared with bigint
   operators. Outcomes:
   - any enabled condition with missing/invalid data -> **ERROR**
   - else any enabled condition failing its threshold -> **HOLD**
   - else -> **FIRE**
   ERROR > HOLD > FIRE is the precedence, because missing data must never
   look like a pass and a partial pass must never look like a go.
7. **Trace + artifacts**: a structured run record (schema
   `threshold-guardian/run/v1`) is written as JSON and Markdown under
   `artifacts/runs/`, and a terminal report is rendered. Exit codes:
   FIRE=0, HOLD=2, ERROR=1.

## 4. Data sources and honesty rules

| Value | Primary source | Fallback source | Trace label |
| --- | --- | --- | --- |
| Native PHRS balance | MCP `get_balance` | `eth_getBalance` | `chain-mcp` / `rpc-fallback` |
| DEMO balance | MCP `eth_call(balanceOf)` | `eth_call` | same |
| DEMO allowance | MCP `eth_call(allowance)` | `eth_call` | same |
| decimals/symbol | MCP `eth_call` | `eth_call` | recorded in notes |
| code presence | MCP `get_code` | `eth_getCode` | recorded in notes |
| chain identity | MCP `get_chain_info` | `eth_chainId`/`eth_blockNumber` | `chainVerification.source` |

The fallback exists for resilience. When it is used, the trace says so in
every relevant field and in the run notes — a fallback value is never
presented as an MCP read.

## 5. Decimal safety

- Amounts live only as `bigint` base units (wei-style).
- Thresholds are validated as plain decimal strings (`/^\d+(\.\d+)?$/`).
- Scaling uses `parseUnits` after an explicit precision guard, because
  (verified in viem 2.57.7) `parseUnits("1.55", 1)` silently truncates to
  1.5 — the guard turns that class of typo into a config error instead.
- Comparison happens on base units, so `gte` on `5` DEMO means exactly
  5000000000000000000 base units. No floats anywhere in the decision path.
- JSON serialization writes bigints as strings (`safeStringify`), since JSON
  has no bigint type and number-encoding would risk precision loss.

## 6. Security posture

- Read-only by construction: the only MCP tools invoked are annotated
  `readOnlyHint: true` (`get_chain_info`, `get_balance`, `eth_call`,
  `get_code`). The fallback client implements five `eth_*` read methods.
  Nothing in the codebase can build or sign a transaction.
- No private key, mnemonic, or signing material is read, requested, or
  printed. `.env` files are gitignored; a secret-scan script (`npm run
  scan:secrets`) fails the build on 64-hex strings and secret-shaped
  assignments.
- RPC usage is bounded: one verification + one metadata pair + code checks +
  one read per enabled condition, with a cap of 32 conditions, per-call
  timeouts, and a maximum of two retries (honouring `Retry-After`).
- Chain ID is validated before reads; unexpected networks abort.

## 7. Testing strategy

- **Offline unit tests** (84) cover operators, decimal parsing/formatting,
  config validation (including the three-enabled-conditions policy and
  BOM tolerance), evaluator semantics, trace structure/serialization, and
  report rendering.
- **Offline integration tests** run the full pipeline against an in-process
  mock MCP server and mock JSON-RPC node (`test/helpers/mockPharosMcp.ts`),
  covering FIRE, HOLD (two shapes), ERROR (network mismatch, both endpoints
  down, empty `eth_call` data), fallback labeling, disabled-condition
  skipping, block pinning, and artifact writing.
- **Live tests** (`test/guardian.live.test.ts`) run only with
  `GUARDIAN_LIVE=1` and hit the real Atlantic Testnet via MCP.
