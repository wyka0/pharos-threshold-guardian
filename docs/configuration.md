# Configuration Guide

Threshold Guardian reads one JSON file. The default path is
`config/guardian.json`; pass another with `--config <path>`. Editing the file
changes behaviour — no code changes are ever needed.

## Full example with every option

```json
{
  "network": {
    "name": "Pharos Atlantic Testnet",
    "chainId": 688689,
    "rpcUrl": "https://atlantic.dplabs-internal.com",
    "explorerUrl": "https://atlantic.pharosscan.xyz"
  },
  "walletAddress": "0xE9edd930130bC1F97EB68C86519d4dD1eE778657",
  "tokenAddress": "0x39f964952f5259b6d7fe33f73b456e05519098a6",
  "spenderAddress": "0x7833a6d977381e76484bebf408fb8ce967aec0ad",
  "conditions": [
    {
      "id": "native-balance",
      "type": "nativeBalance",
      "enabled": true,
      "operator": "gte",
      "threshold": "1",
      "unit": "PHRS",
      "label": "Native PHRS balance"
    },
    {
      "id": "token-balance",
      "type": "erc20Balance",
      "enabled": true,
      "operator": "gte",
      "threshold": "100",
      "unit": "DEMO",
      "label": "DEMO token balance"
    },
    {
      "id": "token-allowance",
      "type": "erc20Allowance",
      "enabled": true,
      "operator": "gte",
      "threshold": "50",
      "unit": "DEMO",
      "label": "DEMO allowance for SupportDemoTestnet"
    }
  ],
  "action": {
    "name": "Demo action",
    "mode": "decision-only"
  },
  "fallback": {
    "enabled": true,
    "rpcUrl": "https://atlantic.dplabs-internal.com"
  }
}
```

## Field reference

### `network`

| Field | Type | Rules |
| --- | --- | --- |
| `name` | string | non-empty; used in reports |
| `chainId` | number | positive integer; **must match the live chain** or the run aborts with ERROR |
| `rpcUrl` | string (optional) | http(s) URL; informational, shown in traces |
| `explorerUrl` | string (optional) | http(s) URL; informational |

### Addresses

| Field | Meaning |
| --- | --- |
| `walletAddress` | the wallet whose balances/allowance are evaluated |
| `tokenAddress` | the ERC-20 contract (DEMO in the demos) |
| `spenderAddress` | the approved spender checked by `erc20Allowance` |

All three must be valid 20-byte EVM addresses (`0x` + 40 hex characters).
All-lowercase or all-uppercase is accepted; mixed-case input must carry a
correct EIP-55 checksum.

### `conditions`

An array of 1–32 conditions. **At least three must be enabled** — that is
the demonstration bar for this task (a guardian guarding on fewer
independent conditions is not exercised here).

| Field | Type | Rules |
| --- | --- | --- |
| `id` | string | unique, non-empty; appears in traces and reasons |
| `type` | string | `nativeBalance` \| `erc20Balance` \| `erc20Allowance` |
| `enabled` | boolean | required, explicit; disabled conditions are not read and never affect the decision |
| `operator` | string | `gt` \| `gte` \| `lt` \| `lte` \| `eq` |
| `threshold` | string (preferred) or whole number | non-negative decimal, e.g. `"1"`, `"0.05"`; **use strings for decimals** — JSON numbers are floats and non-integer numbers are rejected |
| `unit` | string | human label, e.g. `PHRS`, `DEMO`; compared against the on-chain symbol and any mismatch is recorded as a warning |
| `label` | string (optional) | report heading; defaults like "Native PHRS balance" are generated otherwise |

Operator semantics (compared in integer base units, exactly):

| Operator | Passes when |
| --- | --- |
| `gt` | actual > threshold |
| `gte` | actual >= threshold (equality passes) |
| `lt` | actual < threshold |
| `lte` | actual <= threshold |
| `eq` | actual == threshold, bit-exact in base units |

Precision rule: a threshold may not have more fractional digits than the
token's on-chain decimals. `"0.0000000000000000001"` (19 digits) with an
18-decimal token is rejected, because scaling it would silently round to
zero.

### `action`

| Field | Rules |
| --- | --- |
| `name` | non-empty string; shown in traces |
| `mode` | must be `"decision-only"`. Threshold Guardian never executes actions; any other mode is a configuration error. |

### `fallback` (optional)

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | allow the documented read-only JSON-RPC fallback when the Chain MCP server cannot answer |
| `rpcUrl` | `https://atlantic.dplabs-internal.com` | the fallback endpoint (http(s)) |

With `enabled: false` the run is MCP-only: an unreachable MCP server then
produces ERROR instead of falling back. Every fallback-sourced value is
labeled `rpc-fallback` in the trace — it is never presented as an MCP read.

## The three demonstration configs

| File | Purpose | Thresholds | Expected with current chain state |
| --- | --- | --- | --- |
| `guardian.json` | default / example | 1 PHRS, 100 DEMO, 50 DEMO | HOLD (native 0.096 < 1 and allowance 5 < 50) |
| `guardian.fire.json` | FIRE demo | 0.05 PHRS, 100 DEMO, 5 DEMO | FIRE (thresholds below or equal to observed values) |
| `guardian.hold.json` | HOLD demo | 0.05 PHRS, 100 DEMO, 50 DEMO | HOLD (allowance 5 < 50 fails) |

Observed on-chain values at block ~31879820: native **0.096356464 PHRS**,
DEMO balance **1000**, DEMO allowance **5**. Thresholds in the demo configs
are set relative to those observed values; the chain values themselves are
never adjusted.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `GUARDIAN_MCP_ENDPOINT` | `http://127.0.0.1:3999/mcp` | Pharos Chain MCP endpoint |

There is deliberately **no** private-key, mnemonic, or RPC-signing variable.
The Skill is read-only.

## Validation errors

Validation collects every problem in one pass, for example:

```
CONFIGURATION PROBLEM
config/guardian.json contains 3 configuration problems:
  - network.chainId: must be a positive whole number (got -5).
  - walletAddress: "bad" is not a valid 20-byte EVM address (expected 0x followed by 40 hex characters).
  - action.mode: "execute" is not supported. Threshold Guardian is a read-only
    decision skill; the only supported mode is "decision-only".
    It never signs or sends transactions.
```

Fix the listed items and run again. A UTF-8 BOM at the start of the file
(common on Windows editors) is tolerated.
