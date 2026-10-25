# Verification Guide

How to reproduce every claim in this repository, and what was actually run
on 2026-10-26 (UTC timestamps are local-clock ISO strings written by the
tool; the machine clock reads 2026-10-26, file stamps show 2026-10-25T22:xx
UTC).

## 1. Quality gates (all executed, real results)

| Gate | Command | Result |
| --- | --- | --- |
| Tests (offline) | `npm test` | **84/84 passed**, 0 failed |
| Live tests (gated) | `$env:GUARDIAN_LIVE="1"; npm run test:live` | **3/3 passed** |
| TypeScript typecheck | `npm run typecheck` | exit 0 |
| Lint | `npm run lint` | exit 0 |
| Build | `npm run build` | exit 0 |
| Secret scan | `npm run scan:secrets` | "Secret scan passed: no private keys, mnemonics, or committed .env files found." |
| Dependency audit (runtime deps) | `npm run audit:prod` | "found 0 vulnerabilities" |
| Dependency audit (incl. dev) | `npm audit` | "found 0 vulnerabilities" |

`npm run verify` chains lint + typecheck + tests + secret scan + audit.

## 2. Live chain verification (MCP)

The official Pharos Chain MCP server (`pharos-mcp-server` 0.1.0) runs at
`http://127.0.0.1:3999/mcp`, self-hosted against the Atlantic Testnet RPC.
Its `get_chain_info` tool reported:

```json
{
  "name": "Pharos",
  "chainId": 688689,
  "chainIdHex": "0xa8231",
  "chainIdMatches": true,
  "latestBlock": "31879820",
  "nativeSymbol": "PHRS",
  "clientVersion": "portal/1.0.0",
  "rpcUrl": "https://atlantic.dplabs-internal.com"
}
```

Contract existence was confirmed with `get_code` before relying on them:

- DemoToken `0x39f964952f5259b6d7fe33f73b456e05519098a6` — 3081 bytes of deployed code; `symbol()` = `DEMO`, `decimals()` = 18
- SupportDemoTestnet `0x7833a6d977381e76484bebf408fb8ce967aec0ad` — 1375 bytes of deployed code

## 3. FIRE demonstration (real reads)

Command: `npm run guardian:fire`
Trace: `artifacts/runs/2026-10-25T22-55-05-803Z_FIRE_f99eef35-55dc-4f85-b306-0f9fe935b670.json` (+ `.md`)

- Run ID: `f99eef35-55dc-4f85-b306-0f9fe935b670`
- Chain verification: `chain-mcp`, chainId 688689, block **31879820**
- All reads pinned to block 31879820

| Condition | Actual (on-chain) | Configured demo threshold | Source | Result |
| --- | --- | --- | --- | --- |
| Native PHRS balance | **0.096356464 PHRS** | >= 0.05 PHRS | Chain MCP (`get_balance`) | PASS |
| DEMO token balance | **1000 DEMO** | >= 100 DEMO | Chain MCP (`eth_call(balanceOf)`) | PASS |
| DEMO allowance | **5 DEMO** | >= 5 DEMO (equality passes) | Chain MCP (`eth_call(allowance)`) | PASS |

**FINAL DECISION: FIRE** — every enabled condition passed. The chain state
was not modified to force this outcome: the thresholds in
`config/guardian.fire.json` were simply chosen at or below the values the
chain actually reports. The allowance condition demonstrates the `gte`
boundary passing on exact equality (5 >= 5).

## 4. HOLD demonstration (real reads)

Command: `npm run guardian:hold`
Trace: `artifacts/runs/2026-10-25T22-55-25-329Z_HOLD_0226b9b7-5acd-4a26-859a-932cc39d1591.json` (+ `.md`)

- Run ID: `0226b9b7-5acd-4a26-859a-932cc39d1591`
- Chain verification: `chain-mcp`, chainId 688689, block **31879834**
- Same wallet, same real values; only the demonstration allowance threshold
  is raised above the observed on-chain allowance.

| Condition | Actual (on-chain) | Configured demo threshold | Source | Result |
| --- | --- | --- | --- | --- |
| Native PHRS balance | **0.096356464 PHRS** | >= 0.05 PHRS | Chain MCP (`get_balance`) | PASS |
| DEMO token balance | **1000 DEMO** | >= 100 DEMO | Chain MCP (`eth_call(balanceOf)`) | PASS |
| DEMO allowance | **5 DEMO** | >= 50 DEMO | Chain MCP (`eth_call(allowance)`) | FAIL |

**FINAL DECISION: HOLD** (exit code 2). Reason recorded in the trace:
`1 of 3 enabled condition(s) failed: "token-allowance" (actual 5 DEMO,
required >= 50 DEMO).` The held condition still shows its real observed
value (5 DEMO), so the trace distinguishes actual chain data from the
configured demonstration threshold.

## 5. Default run

Command: `npm run guardian` (config `guardian.json` with the task's example
thresholds 1 PHRS / 100 DEMO / 50 DEMO). Result: **HOLD** with two failing
conditions (native 0.096356464 < 1; allowance 5 < 50) — exit code 2. Trace:
`artifacts/runs/2026-10-25T22-55-41-536Z_HOLD_9dddcde8-f0d2-41bd-8838-e889893bcc91.json`.

## 6. Fallback evidence (resilience, labeled honestly)

During one earlier run the local MCP server was briefly down. The run
completed via the documented read-only JSON-RPC fallback
(`https://atlantic.dplabs-internal.com`) and every affected field in
`artifacts/runs/2026-10-25T22-51-27-868Z_FIRE_428cdccc-7011-43bb-90ac-4097db6ead81.json`
is labeled `rpc-fallback` (source per condition and in the run notes), with
the MCP outage recorded in the notes. Values from the fallback are never
presented as MCP reads. An offline integration test
(`fallback: MCP dead but JSON-RPC fallback alive ...`) locks this behaviour
in.

## 7. Reproducing the live demos

Prerequisites: the local Pharos Chain MCP server running at
`http://127.0.0.1:3999/mcp` (see `docs/architecture.md`), then:

```powershell
npm install
npm run build
npm run guardian:fire   # expect FIRE (exit 0)
npm run guardian:hold   # expect HOLD (exit 2)
npm test                # expect 84/84 (offline; no network)
```

Actual values may drift if someone transacts on the testnet wallet; the
demo configs would then need their thresholds re-checked against the fresh
observed values (the guardian reports the real values either way and never
fabricates one).

## 8. Security verification

- `npm run scan:secrets` passes (no 64-hex secrets, no secret-shaped
  assignments, no committed `.env`).
- The code contains no signing, no `eth_send*`, no `send_raw_transaction`
  calls; the only MCP tools invoked are read-only annotated ones.
- Chain ID is validated before any condition read; a mismatch aborts with
  ERROR (covered by the `network mismatch` offline test).
