# Threshold Guardian — Pharos Agent Arena Task 7

Threshold Guardian is a read-only Skill that evaluates multiple configurable
on-chain conditions against **real Pharos Atlantic Testnet state** before
deciding whether an action should fire.

- **FIRE** when every enabled condition passes.
- **HOLD** when at least one enabled condition fails.
- **ERROR** when chain data is unavailable or invalid (missing data is never
  treated as a pass).

It reads; it never writes. The tool never signs transactions, never requests
private keys, and never sends anything to the chain.

---

## Task description

Build a Skill that acts as a threshold guardian for on-chain actions: before
an action fires, several independent conditions must hold — for example, the
wallet must have enough native gas, enough of a token, and a sufficient
spending allowance. The Skill must demonstrate both outcomes (FIRE and HOLD)
with real chain reads, produce auditable decision traces, and keep the
decision engine fully separate from chain reading and from action execution.

## Highlights

- Three independent conditions, each read directly from Atlantic Testnet:
  1. Native **PHRS** wallet balance — Chain MCP tool `get_balance`
  2. ERC-20 **DEMO** token balance — Chain MCP tool `eth_call` (`balanceOf`)
  3. ERC-20 **DEMO** allowance for a spender — Chain MCP tool `eth_call` (`allowance`)
- Configurable thresholds in `config/guardian.json` — no code changes needed.
- Operators: `gt`, `gte`, `lt`, `lte`, `eq`.
- Decimal-safe arithmetic on integer base units (bigint). Floating point is
  never used for amounts.
- Strict config validation with all problems reported in one pass.
- Structured JSON decision traces persisted under `artifacts/runs/`.
- Data-source attribution per condition: **Chain MCP** or the documented
  read-only **JSON-RPC fallback** (never mislabeled).
- Exit codes: `FIRE=0`, `HOLD=2`, `ERROR=1`.

## Installation

Requirements: Node.js >= 20 and npm.

```powershell
cd C:\pharos-threshold-guardian
npm install
npm run build
```

The official Pharos Chain MCP server must be reachable at
`http://127.0.0.1:3999/mcp` (self-hosted against the Atlantic Testnet RPC —
the hosted public MCP endpoint serves Pacific Mainnet and is **not** used
here). If the MCP server is down, the guardian automatically falls back to
the documented read-only JSON-RPC endpoint (`https://atlantic.dplabs-internal.com`)
and labels every such value `rpc-fallback` in the trace.

## Configuration

All thresholds live in `config/guardian.json`:

```json
{
  "network": { "name": "Pharos Atlantic Testnet", "chainId": 688689 },
  "walletAddress": "0xE9edd930130bC1F97EB68C86519d4dD1eE778657",
  "tokenAddress": "0x39f964952f5259b6d7fe33f73b456e05519098a6",
  "spenderAddress": "0x7833a6d977381e76484bebf408fb8ce967aec0ad",
  "conditions": [
    { "id": "native-balance", "type": "nativeBalance", "enabled": true, "operator": "gte", "threshold": "1", "unit": "PHRS" },
    { "id": "token-balance", "type": "erc20Balance", "enabled": true, "operator": "gte", "threshold": "100", "unit": "DEMO" },
    { "id": "token-allowance", "type": "erc20Allowance", "enabled": true, "operator": "gte", "threshold": "50", "unit": "DEMO" }
  ],
  "action": { "name": "Demo action", "mode": "decision-only" }
}
```

Edit thresholds, operators, and the enabled flags without touching code.
Invalid configuration is rejected with an itemized error list. See
[docs/configuration.md](docs/configuration.md) for every option and rule.

## How the Skill works

```
config/guardian.json ──> validate ──> verify chain (chainId) ──> pin block
                                     │
     ┌───────────────────────────────┘
     ▼
 read conditions (independent, MCP-first, RPC fallback second)
     │  nativeBalance   -> get_balance            (or eth_getBalance)
     │  erc20Balance    -> eth_call balanceOf     (or eth_call)
     │  erc20Allowance  -> eth_call allowance     (or eth_call)
     ▼
 evaluate (pure, bigint base units, no I/O)  ──>  FIRE | HOLD | ERROR
     ▼
 persist trace (artifacts/runs/*.json + .md) ──> render report, set exit code
```

Key invariants:

- Missing chain data **never** counts as a pass (it forces ERROR).
- Condition evaluation is separate from chain reading; action execution is
  separate from the decision (and is out of scope: decision-only).
- Every run pins all reads to one block so the three values describe one
  consistent chain state.

## Commands

```powershell
npm run guardian        # default config (config/guardian.json)
npm run guardian:fire   # FIRE demonstration (thresholds <= observed values)
npm run guardian:hold   # HOLD demonstration (one threshold above observed)
```

Options:

```powershell
node dist/src/index.js --config config/guardian.json --json --verbose
node dist/src/index.js --out-dir artifacts/runs --no-save
```

- `--config <path>` — use a different config file
- `--json` — print the full decision trace as JSON
- `--verbose` — extra detail (tool names, base-unit values, notes)
- `--out-dir <dir>` — where traces are saved (default `artifacts/runs`)
- `--no-save` — do not write trace artifacts

## FIRE example (real run, 2026-10-26, block 31879820)

```
Condition: Native PHRS balance [native-balance]
Actual:    0.096356464 PHRS
Required:  >= 0.05 PHRS
Source:    Chain MCP (get_balance)
Result:    PASS

Condition: DEMO token balance [token-balance]
Actual:    1000 DEMO
Required:  >= 100 DEMO
Source:    Chain MCP (eth_call(balanceOf))
Result:    PASS

Condition: DEMO allowance for SupportDemoTestnet [token-allowance]
Actual:    5 DEMO
Required:  >= 5 DEMO
Source:    Chain MCP (eth_call(allowance))
Result:    PASS

FINAL DECISION: FIRE
```

Trace: `artifacts/runs/2026-10-25T22-55-05-803Z_FIRE_f99eef35-55dc-4f85-b306-0f9fe935b670.json`

## HOLD example (real run, 2026-10-26, block 31879834)

Same wallet, same real chain values — only the demonstration threshold for
the allowance is raised above what the chain actually shows:

```
Condition: Native PHRS balance          Actual: 0.096356464 PHRS  Required: >= 0.05 PHRS   PASS
Condition: DEMO token balance           Actual: 1000 DEMO         Required: >= 100 DEMO    PASS
Condition: DEMO allowance               Actual: 5 DEMO            Required: >= 50 DEMO     FAIL

FINAL DECISION: HOLD
Reason: 1 of 3 enabled condition(s) failed: "token-allowance"
(actual 5 DEMO, required >= 50 DEMO).
```

Exit code: `2`. Trace: `artifacts/runs/2026-10-25T22-55-25-329Z_HOLD_0226b9b7-5acd-4a26-859a-932cc39d1591.json`

## Tests

```powershell
npm test          # 84 offline unit/integration tests (mock MCP + mock RPC, no network)
npm run test:live # live tests, ONLY run when GUARDIAN_LIVE=1
npm run lint      # eslint
npm run typecheck # tsc --noEmit
npm run scan:secrets  # secret scan
npm run audit:prod    # npm audit (runtime dependencies)
npm run verify    # lint + typecheck + test + secret scan + audit
```

Offline tests use an in-process mock of the MCP server and a mock JSON-RPC
node; normal `npm test` never touches the network.

## Testnet disclaimer

This project targets the **Pharos Atlantic Testnet** (chain ID `688689`,
RPC `https://atlantic.dplabs-internal.com`). The DEMO token
(`0x39f964952f5259b6d7fe33f73b456e05519098a6`) is a demo contract deployed
for Pharos Arena tasks — it is **not** an official Pharos token and holds no
value. Balances and allowances observed here are testnet quantities only.
No mainnet endpoint is contacted, and no transaction is ever sent.

## Limitations

- **Decision-only.** The Skill stops at the decision; wiring the guarded
  action to real execution is deliberately out of scope (and would require
  signing, which this project refuses to do).
- At least **three enabled conditions** are required — that is the
  demonstration bar for this task; a guardian with a single condition would
  not exercise the multi-condition gate.
- The MCP endpoint defaults to `http://127.0.0.1:3999/mcp` (local official
  server). Override with `GUARDIAN_MCP_ENDPOINT` if your setup differs.
- The JSON-RPC fallback requires the endpoint to allow standard `eth_*`
  reads; results are labeled `rpc-fallback` in traces.
- Contract-level checks are limited to code presence (`get_code`) and the
  four read-only ERC-20 functions used here; deeper ABI introspection is not
  attempted.
- Traces pin reads to a single block for consistency; they do not detect
  reorgs after the read.

## Project layout

```
config/            guardian.json, guardian.fire.json, guardian.hold.json
src/               CLI, config validation, decision engine, chain readers
  chain/           MCP client, JSON-RPC fallback, ERC-20 helpers, readers
test/              offline tests + mock servers + gated live test
docs/              architecture, configuration, verification
artifacts/runs/    persisted decision traces (JSON + Markdown)
scripts/           secret-scan.mjs
```
