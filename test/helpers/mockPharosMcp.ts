/**
 * In-process mock of the Pharos Chain MCP server for offline tests.
 *
 * Implements just enough of the Streamable-HTTP JSON-RPC protocol (initialize
 * handshake, mcp-session-id header, SSE-framed responses, tools/call) plus a
 * tiny JSON-RPC fallback RPC server. No external network is contacted.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

export interface MockChainState {
  chainId: number;
  latestBlock: string; // decimal string
  nativeBalanceWei: string; // decimal string
  tokenSymbol: string;
  tokenDecimals: number;
  /** balanceOf result as decimal string or bigint. */
  tokenBalance: string | bigint;
  /** allowance result as decimal string or bigint. */
  allowance: string | bigint;
  tokenCode: string;
  spenderCode: string;
}

export interface MockOptions {
  state: MockChainState;
  /** Respond HTTP 429 to the first N tools/call requests (tests retries). */
  failWith429First?: number;
  /** Every tools/call returns a JSON-RPC error (simulates MCP outage). */
  failAllReads?: boolean;
  /** eth_call returns "0x" (simulates call to a non-contract). */
  returnEmptyCall?: boolean;
  /** get_chain_info reports this chain ID instead of state.chainId. */
  reportChainId?: number;
  /** Verify the client sends this block tag (recorded, not enforced). */
  recordOnly?: boolean;
}

export interface MockCall {
  method: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export interface MockMcpServer {
  endpoint: string;
  calls: MockCall[];
  close(): Promise<void>;
}

export const DEFAULT_MOCK_STATE: MockChainState = {
  chainId: 688689,
  latestBlock: "31878219",
  nativeBalanceWei: "96356464000000000",
  tokenSymbol: "DEMO",
  tokenDecimals: 18,
  tokenBalance: "1000000000000000000000",
  allowance: "5000000000000000000",
  tokenCode: "0x" + "6080".repeat(64),
  spenderCode: "0x" + "6080".repeat(64),
};

function toUint256Hex(value: string | bigint): string {
  const raw = typeof value === "bigint" ? value : BigInt(value);
  if (raw < 0n) {
    throw new Error("mock: negative uint256");
  }
  return raw.toString(16).padStart(64, "0");
}

function encodeAbiString(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  const lengthHex = bytes.length.toString(16).padStart(64, "0");
  const words = Math.ceil(bytes.length / 32);
  const dataHex = bytes.toString("hex").padEnd(words * 64, "0");
  return toUint256Hex(32n) + lengthHex + dataHex;
}

function okResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

function errorResult(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

export function startMockPharosMcp(options: MockOptions): Promise<MockMcpServer> {
  const calls: MockCall[] = [];
  let fourTwenties = options.failWith429First ?? 0;
  let sessionIdCounter = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      let body: { id?: unknown; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(errorResult(null, -32700, "mock: parse error"));
        return;
      }
      const isNotification = body.id === undefined || body.id === null;

      if (isNotification) {
        // notifications/initialized and friends: acknowledge, no body.
        res.writeHead(202, { "mcp-session-id": `mock-session-${sessionIdCounter}` });
        res.end();
        return;
      }

      const sessionHeader = `mock-session-${sessionIdCounter++}`;

      const respondSse = (payload: string): void => {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "mcp-session-id": sessionHeader,
          "Cache-Control": "no-cache",
        });
        res.end(`event: message\ndata: ${payload}\n\n`);
      };

      if (body.method === "initialize") {
        respondSse(
          okResult(body.id, {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "mock-pharos-mcp-server", version: "0.1.0" },
          }),
        );
        return;
      }

      if (body.method === "tools/call") {
        if (fourTwenties > 0) {
          fourTwenties--;
          res.writeHead(429, { "Retry-After": "0" });
          res.end();
          return;
        }
        const tool = body.params?.name ?? "";
        const args = body.params?.arguments ?? {};
        calls.push({ method: body.method, tool, args });

        if (options.failAllReads === true) {
          respondSse(errorResult(body.id, -32000, "mock: upstream RPC unavailable"));
          return;
        }

        const text = (payload: unknown): string =>
          okResult(body.id, { content: [{ type: "text", text: JSON.stringify(payload) }] });

        switch (tool) {
          case "get_chain_info":
            respondSse(
              text({
                name: "Pharos",
                chainId: options.reportChainId ?? options.state.chainId,
                chainIdHex: `0x${(options.reportChainId ?? options.state.chainId).toString(16)}`,
                latestBlock: options.state.latestBlock,
                nativeSymbol: "PHRS",
                clientVersion: "mock/1.0.0",
              }),
            );
            return;
          case "get_balance":
            respondSse(
              text({
                address: args["address"],
                balanceWei: options.state.nativeBalanceWei,
                balanceHex: `0x${BigInt(options.state.nativeBalanceWei).toString(16)}`,
                symbol: "PHRS",
              }),
            );
            return;
          case "eth_call": {
            if (options.returnEmptyCall === true) {
              respondSse(text({ result: "0x" }));
              return;
            }
            const data = (args["transaction"] as { data?: string } | undefined)?.data ?? "";
            const selector = data.slice(0, 10);
            let resultHex: string;
            if (selector === "0x70a08231") {
              resultHex = `0x${toUint256Hex(options.state.tokenBalance)}`;
            } else if (selector === "0xdd62ed3e") {
              resultHex = `0x${toUint256Hex(options.state.allowance)}`;
            } else if (selector === "0x313ce567") {
              resultHex = `0x${options.state.tokenDecimals.toString(16).padStart(64, "0")}`;
            } else if (selector === "0x95d89b41") {
              resultHex = `0x${encodeAbiString(options.state.tokenSymbol)}`;
            } else {
              respondSse(errorResult(body.id, -32001, `mock: unsupported selector ${selector}`));
              return;
            }
            respondSse(text({ result: resultHex }));
            return;
          }
          case "get_code": {
            const target = typeof args["address"] === "string" ? (args["address"] as string).toLowerCase() : "";
            const code = target.endsWith("ad") ? options.state.spenderCode : options.state.tokenCode;
            respondSse(text({ code }));
            return;
          }
          default:
            respondSse(errorResult(body.id, -32601, `mock: unknown tool ${tool}`));
        }
        return;
      }

      respondSse(errorResult(body.id, -32601, `mock: unknown method ${body.method ?? "?"}`));
    });
  });

  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolvePromise({
        endpoint: `http://127.0.0.1:${address.port}/mcp`,
        calls,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => {
              resolveClose();
            });
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Mock JSON-RPC fallback (plain POST JSON-RPC 2.0, as an EVM node speaks).
// ---------------------------------------------------------------------------

export interface MockFallbackServer {
  url: string;
  close(): Promise<void>;
}

export function startMockFallbackRpc(state: MockChainState, opts: { failCalls?: boolean } = {}): Promise<MockFallbackServer> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      let body: { id?: unknown; method?: string; params?: unknown[] } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof body;
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(errorResult(null, -32700, "mock: parse error"));
        return;
      }
      const reply = (result: unknown): void => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(okResult(body.id, result));
      };
      const fail = (): void => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(errorResult(body.id, -32000, "mock: fallback upstream unavailable"));
      };

      switch (body.method) {
        case "eth_chainId":
          reply(`0x${state.chainId.toString(16)}`);
          return;
        case "eth_blockNumber":
          reply(`0x${BigInt(state.latestBlock).toString(16)}`);
          return;
        case "eth_getBalance":
          reply(`0x${BigInt(state.nativeBalanceWei).toString(16)}`);
          return;
        case "eth_call": {
          if (opts.failCalls === true) {
            fail();
            return;
          }
          const data = (body.params?.[0] as { data?: string } | undefined)?.data ?? "";
          const selector = data.slice(0, 10);
          if (selector === "0x70a08231") {
            reply(`0x${toUint256Hex(state.tokenBalance)}`);
          } else if (selector === "0xdd62ed3e") {
            reply(`0x${toUint256Hex(state.allowance)}`);
          } else if (selector === "0x313ce567") {
            reply(`0x${state.tokenDecimals.toString(16).padStart(64, "0")}`);
          } else if (selector === "0x95d89b41") {
            reply(`0x${encodeAbiString(state.tokenSymbol)}`);
          } else {
            fail();
          }
          return;
        }
        case "eth_getCode":
          reply(state.tokenCode);
          return;
        default:
          fail();
      }
    });
  });

  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolvePromise({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => {
              resolveClose();
            });
          }),
      });
    });
  });
}

/** Deterministic config factory used by several tests. */
export function buildConfigObject(overrides: {
  conditions?: unknown;
  chainId?: number;
  actionName?: string;
  fallback?: unknown;
  wallet?: string;
} = {}): Record<string, unknown> {
  return {
    network: {
      name: "Mock Pharos Atlantic Testnet",
      chainId: overrides.chainId ?? 688689,
    },
    walletAddress: overrides.wallet ?? "0xE9edd930130bC1F97EB68C86519d4dD1eE778657",
    tokenAddress: "0x39f964952f5259b6d7fe33f73b456e05519098a6",
    spenderAddress: "0x7833a6d977381e76484bebf408fb8ce967aec0ad",
    conditions:
      overrides.conditions ??
      [
        { id: "native-balance", type: "nativeBalance", enabled: true, operator: "gte", threshold: "0.05", unit: "PHRS" },
        { id: "token-balance", type: "erc20Balance", enabled: true, operator: "gte", threshold: "100", unit: "DEMO" },
        { id: "token-allowance", type: "erc20Allowance", enabled: true, operator: "gte", threshold: "5", unit: "DEMO" },
      ],
    action: { name: overrides.actionName ?? "Mock action", mode: "decision-only" },
    ...(overrides.fallback !== undefined ? { fallback: overrides.fallback } : {}),
  };
}
