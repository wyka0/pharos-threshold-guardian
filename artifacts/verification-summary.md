# Verification Summary — Pharos Threshold Guardian (Task 7)

Date: 2026-10-26
Project: `C:\pharos-threshold-guardian`
Network: **Pharos Atlantic Testnet** — chain ID `688689`, RPC
`https://atlantic.dplabs-internal.com`, official Chain MCP server at
`http://127.0.0.1:3999/mcp` (self-hosted; the hosted public MCP endpoint
serves Pacific Mainnet and was not used).

## 1. Contracts verified before use

| Contract | Address | Evidence |
| --- | --- | --- |
| DemoToken (DEMO, 18 decimals) | `0x39f964952f5259b6d7fe33f73b456e05519098a6` | MCP `get_code`: 3081 bytes; MCP `eth_call`: `symbol()` = DEMO, `decimals()` = 18 |
| SupportDemoTestnet (spender) | `0x7833a6d977381e76484bebf408fb8ce967aec0ad` | MCP `get_code`: 1375 bytes |

DemoToken is a test-only demo contract from earlier Arena tasks, not an
official Pharos token.

## 2. Chain MCP tools used (read-only only)

| Tool | Used for |
| --- | --- |
| `get_chain_info` | network verification (chainId 688689, latest block, native symbol PHRS) |
| `get_balance` | native PHRS balance of the wallet |
| `eth_call` | ERC-20 `balanceOf(wallet)`, `allowance(wallet, spender)`, `decimals()`, `symbol()` |
| `get_code` | deployed-code confirmation for token and spender |

`send_raw_transaction` was never invoked; nothing was signed or broadcast.

## 3. Actual chain reads performed (per demonstration run)

Wallet: `0xE9edd930130bC1F97EB68C86519d4dD1eE778657` (Arena demo deployer)

### FIRE demonstration — `npm run guardian:fire`

- Run ID `f99eef35-55dc-4f85-b306-0f9fe935b670`, all reads pinned to block **31879820**
- Chain verified via **Chain MCP** (`get_chain_info`): chainId 688689 matches config

| Condition | Actual on-chain value | Demonstration threshold | Data source | Result |
| --- | --- | --- | --- | --- |
| native-balance | **0.096356464 PHRS** | >= 0.05 PHRS | Chain MCP — `get_balance` | PASS |
| token-balance | **1000 DEMO** | >= 100 DEMO | Chain MCP — `eth_call` (`balanceOf`) | PASS |
| token-allowance | **5 DEMO** | >= 5 DEMO (equality passes) | Chain MCP — `eth_call` (`allowance`) | PASS |

**FINAL DECISION: FIRE** (exit code 0) — all three enabled conditions passed
their configured thresholds. No chain state was changed to force this; the
thresholds were configured at or below the genuinely observed values, and
the allowance condition deliberately demonstrates the `gte` boundary at
exact equality.

Trace: `artifacts/runs/2026-10-25T22-55-05-803Z_FIRE_f99eef35-55dc-4f85-b306-0f9fe935b670.json` (+ Markdown)

### HOLD demonstration — `npm run guardian:hold`

- Run ID `0226b9b7-5acd-4a26-859a-932cc39d1591`, all reads pinned to block **31879834**
- Same wallet, same real chain reads; only the demonstration allowance
  threshold differs (raised above the observed allowance).

| Condition | Actual on-chain value | Demonstration threshold | Data source | Result |
| --- | --- | --- | --- | --- |
| native-balance | **0.096356464 PHRS** | >= 0.05 PHRS | Chain MCP — `get_balance` | PASS |
| token-balance | **1000 DEMO** | >= 100 DEMO | Chain MCP — `eth_call` (`balanceOf`) | PASS |
| token-allowance | **5 DEMO** | >= 50 DEMO | Chain MCP — `eth_call` (`allowance`) | FAIL |

**FINAL DECISION: HOLD** (exit code 2) — the guardian held because the
observed allowance (5 DEMO) is below the configured demonstration threshold
(50 DEMO). The trace records the real observed value alongside the
configured threshold, making the distinction explicit.

Trace: `artifacts/runs/2026-10-25T22-55-25-329Z_HOLD_0226b9b7-5acd-4a26-859a-932cc39d1591.json` (+ Markdown)

### Default run — `npm run guardian`

HOLD (exit 2) with the task's example thresholds (1 PHRS / 100 DEMO /
50 DEMO): native-balance FAIL (0.096356464 < 1) and token-allowance FAIL
(5 < 50). Trace:
`artifacts/runs/2026-10-25T22-55-41-536Z_HOLD_9dddcde8-f0d2-41bd-8838-e889893bcc91.json`.

## 4. Fallback evidence

One earlier run (block 31879750) executed while the local MCP server was
down; it completed via the documented read-only JSON-RPC fallback and every
value is labeled `rpc-fallback` in
`artifacts/runs/2026-10-25T22-51-27-868Z_FIRE_428cdccc-7011-43bb-90ac-4097db6ead81.json`,
with the MCP outage recorded in the run notes. The final demonstrations
above are fully MCP-sourced.

## 5. Quality gates (executed, real results)

| Gate | Result |
| --- | --- |
| `npm test` (offline unit + integration, mock MCP/RPC, no network) | **84/84 passed** |
| `npm run test:live` with `GUARDIAN_LIVE=1` (real chain) | **3/3 passed** |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0 |
| `npm run build` | exit 0 |
| `npm run scan:secrets` | passed — no private keys, mnemonics, or committed `.env` files |
| `npm run audit:prod` and `npm audit` | 0 vulnerabilities |

## 6. Security notes

- Read-only project: no signing code, no private-key handling, no
  transaction construction; only read-only MCP tools are called.
- No secrets are included in any artifact — wallet addresses are public
  identifiers, and only balance/allowance quantities are recorded.
- Chain ID is validated before reads; unexpected networks abort with ERROR.
- RPC usage is bounded (≤ 32 conditions, per-call timeouts, ≤ 2 retries).

## 7. Testnet disclaimer

All values above are **Pharos Atlantic Testnet** quantities. The DEMO token
is a demo contract with no value. Nothing here involves mainnet or real
funds.
