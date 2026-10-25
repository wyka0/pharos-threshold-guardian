/**
 * Independent on-chain condition readers for Pharos Atlantic Testnet.
 *
 * Three condition types are supported, each reading its value independently:
 *   1. nativeBalance    - native PHRS wallet balance      (MCP get_balance)
 *   2. erc20Balance     - ERC-20 token balanceOf(wallet) (MCP eth_call)
 *   3. erc20Allowance   - ERC-20 allowance(wallet,spend) (MCP eth_call)
 *
 * Every read goes to the official Pharos Chain MCP server first. If (and
 * only if) MCP cannot answer, a documented read-only JSON-RPC fallback is
 * used, and the trace records the fallback explicitly ("rpc-fallback") so a
 * fallback read is never mistaken for an MCP read.
 *
 * Readers never fabricate values: any transport failure, malformed payload,
 * or empty eth_call result becomes a failed read (ok: false) and the
 * decision engine treats missing data as ERROR - never as a pass.
 */

import type { Address } from "viem";
import type { ChainMcpClient } from "./mcpClient.js";
import type { FallbackRpcClient } from "./fallbackRpc.js";
import { ChainDataError } from "../errors.js";
import { encodeBalanceOf, encodeAllowance, encodeDecimals, encodeSymbol, decodeUint256Result, decodeDecimalsResult, decodeSymbolResult } from "./erc20.js";

export type DataSource = "chain-mcp" | "rpc-fallback";

export const NATIVE_DECIMALS = 18; // EVM native currency (wei) is fixed at 18 decimals.

export interface ReadSuccess {
  ok: true;
  /** Integer base units (never a float). */
  raw: bigint;
  /** Decimals of the returned value (18 for native, on-chain value for ERC-20). */
  decimals: number;
  source: DataSource;
  /** MCP tool or RPC method that produced the value. */
  tool: string;
  /** Human-readable detail for the trace. */
  detail: string;
}

export interface ReadFailure {
  ok: false;
  error: string;
  source: DataSource | "none";
  tool: string | null;
}

export type ReadResult = ReadSuccess | ReadFailure;

export interface TokenMeta {
  address: string;
  decimals: number;
  symbol: string;
  source: DataSource;
}

export interface ReaderContext {
  /** Official Chain MCP client; null only if MCP is entirely unreachable. */
  mcp: ChainMcpClient | null;
  /** Read-only JSON-RPC fallback; null when disabled by config. */
  fallback: FallbackRpcClient | null;
  /** Block tag (decimal string) all reads are pinned to, for consistency. */
  blockTagDecimal: string;
  /** Same block as hex ("0x...") for the JSON-RPC fallback. */
  blockTagHex: string;
  /** Token metadata read once per run; null when unavailable. */
  token: TokenMeta | null;
  walletAddress: string;
  spenderAddress: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Shared plumbing: each helper tries MCP first, then the fallback once.
// ---------------------------------------------------------------------------

interface McpAttempt<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

async function tryMcp<T>(mcp: ChainMcpClient | null, tool: string, args: Record<string, unknown>, parse: (payload: unknown) => T): Promise<McpAttempt<T>> {
  if (mcp === null) {
    return { ok: false, error: "MCP client unavailable." };
  }
  try {
    const payload = await mcp.callTool(tool, args);
    return { ok: true, value: parse(payload) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

async function tryFallback<T>(fallback: FallbackRpcClient | null, run: (client: FallbackRpcClient) => Promise<T>): Promise<McpAttempt<T>> {
  if (fallback === null) {
    return { ok: false, error: "RPC fallback is disabled by configuration." };
  }
  try {
    return { ok: true, value: await run(fallback) };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

function combineErrors(mcpError: string, fallbackError: string, tool: string): string {
  return (
    `All read paths failed for ${tool}. ` +
    `Chain MCP error: ${mcpError}. ` +
    `RPC fallback error: ${fallbackError}.`
  );
}

// ---------------------------------------------------------------------------
// Token metadata (decimals + symbol), read once per run.
// ---------------------------------------------------------------------------

export async function readTokenMeta(ctx: ReaderContext, tokenAddress: string): Promise<{ meta: TokenMeta | null; error: string | null }> {
  if (!tokenAddress) {
    return { meta: null, error: "Token metadata address was not provided." };
  }

  const dataDecimals = encodeDecimals();
  const dataSymbol = encodeSymbol();

  const mcpDecimals = await tryMcp<string>(
    ctx.mcp,
    "eth_call",
    { transaction: { to: tokenAddress, data: dataDecimals }, block: ctx.blockTagDecimal },
    (payload) => {
      const result = (payload as { result?: unknown }).result;
      if (typeof result !== "string") {
        throw new ChainDataError(`eth_call(decimals) returned an unexpected payload: ${JSON.stringify(payload)}`);
      }
      return result;
    },
  );

  if (mcpDecimals.ok && mcpDecimals.value !== undefined) {
    try {
      const decimals = decodeDecimalsResult(mcpDecimals.value);
      const mcpSymbol = await tryMcp<string>(
        ctx.mcp,
        "eth_call",
        { transaction: { to: tokenAddress, data: dataSymbol }, block: ctx.blockTagDecimal },
        (payload) => {
          const result = (payload as { result?: unknown }).result;
          if (typeof result !== "string") {
            throw new ChainDataError(`eth_call(symbol) returned an unexpected payload: ${JSON.stringify(payload)}`);
          }
          return result;
        },
      );
      if (mcpSymbol.ok && mcpSymbol.value !== undefined) {
        const symbol = decodeSymbolResult(mcpSymbol.value);
        return { meta: { address: tokenAddress, decimals, symbol, source: "chain-mcp" }, error: null };
      }
      // Symbol failed via MCP; try the fallback for both values so the whole
      // meta block comes from one source.
    } catch (error) {
      // Malformed MCP payload; fall through to the fallback path.
      const mcpError = describeError(error);
      const fbDecimals = await tryFallback(ctx.fallback, async (client) => decodeDecimalsResult(await client.call(tokenAddress, dataDecimals, ctx.blockTagHex)));
      if (!fbDecimals.ok) {
        return { meta: null, error: combineErrors(mcpError, fbDecimals.error ?? "unavailable", "token decimals") };
      }
      const fbSymbol = await tryFallback(ctx.fallback, async (client) => decodeSymbolResult(await client.call(tokenAddress, dataSymbol, ctx.blockTagHex)));
      if (!fbSymbol.ok) {
        return { meta: null, error: combineErrors(mcpError, fbSymbol.error ?? "unavailable", "token symbol") };
      }
      return {
        meta: { address: tokenAddress, decimals: fbDecimals.value as number, symbol: fbSymbol.value as string, source: "rpc-fallback" },
        error: null,
      };
    }
  }

  // MCP decimals failed (or symbol path fell through): use the fallback.
  const fbDecimals = await tryFallback(ctx.fallback, async (client) => decodeDecimalsResult(await client.call(tokenAddress, dataDecimals, ctx.blockTagHex)));
  if (!fbDecimals.ok) {
    return {
      meta: null,
      error: combineErrors(mcpDecimals.error ?? "MCP unavailable", fbDecimals.error ?? "unavailable", "token decimals"),
    };
  }
  const fbSymbol = await tryFallback(ctx.fallback, async (client) => decodeSymbolResult(await client.call(tokenAddress, dataSymbol, ctx.blockTagHex)));
  if (!fbSymbol.ok) {
    return {
      meta: null,
      error: combineErrors(mcpDecimals.error ?? "MCP unavailable", fbSymbol.error ?? "unavailable", "token symbol"),
    };
  }
  return {
    meta: { address: tokenAddress, decimals: fbDecimals.value as number, symbol: fbSymbol.value as string, source: "rpc-fallback" },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Contract existence (get_code), used for pre-read verification.
// ---------------------------------------------------------------------------

export async function readCodeSize(ctx: ReaderContext, address: string): Promise<{ bytes: number | null; source: DataSource | "none"; error: string | null }> {
  const mcpCode = await tryMcp<string>(
    ctx.mcp,
    "get_code",
    { address, block: ctx.blockTagDecimal },
    (payload) => {
      const code = (payload as { code?: unknown }).code;
      if (typeof code !== "string") {
        throw new ChainDataError(`get_code returned an unexpected payload: ${JSON.stringify(payload)}`);
      }
      return code;
    },
  );
  if (mcpCode.ok && mcpCode.value !== undefined) {
    const bytes = (mcpCode.value.length - 2) / 2;
    return { bytes, source: "chain-mcp", error: null };
  }
  const fbCode = await tryFallback(ctx.fallback, async (client) => client.getCode(address, ctx.blockTagHex));
  if (fbCode.ok && fbCode.value !== undefined) {
    const bytes = (fbCode.value.length - 2) / 2;
    return { bytes, source: "rpc-fallback", error: null };
  }
  return { bytes: null, source: "none", error: combineErrors(mcpCode.error ?? "MCP unavailable", fbCode.error ?? "unavailable", `get_code(${address})`) };
}

// ---------------------------------------------------------------------------
// Condition readers
// ---------------------------------------------------------------------------

/** Condition 1: native PHRS wallet balance. */
export async function readNativeBalance(ctx: ReaderContext): Promise<ReadResult> {
  const tool = "get_balance";

  const mcpResult = await tryMcp<bigint>(
    ctx.mcp,
    tool,
    { address: ctx.walletAddress, block: ctx.blockTagDecimal },
    (payload) => {
      const wei = (payload as { balanceWei?: unknown }).balanceWei;
      if (typeof wei !== "string" || !/^\d+$/.test(wei)) {
        throw new ChainDataError(`get_balance returned an unexpected payload: ${JSON.stringify(payload)}`);
      }
      const value = BigInt(wei);
      if (value < 0n) {
        throw new ChainDataError("get_balance returned a negative balance, which is impossible; refusing to use it.");
      }
      return value;
    },
  );

  if (mcpResult.ok && mcpResult.value !== undefined) {
    return {
      ok: true,
      raw: mcpResult.value,
      decimals: NATIVE_DECIMALS,
      source: "chain-mcp",
      tool,
      detail: `Native balance read via Chain MCP tool ${tool} at block ${ctx.blockTagDecimal}.`,
    };
  }

  const fallbackResult = await tryFallback(ctx.fallback, async (client) => {
    const weiDecimal = await client.getBalance(ctx.walletAddress, ctx.blockTagHex);
    return BigInt(weiDecimal);
  });

  if (fallbackResult.ok && fallbackResult.value !== undefined) {
    return {
      ok: true,
      raw: fallbackResult.value,
      decimals: NATIVE_DECIMALS,
      source: "rpc-fallback",
      tool: "eth_getBalance",
      detail: `Native balance read via documented read-only JSON-RPC fallback (eth_getBalance) at block ${ctx.blockTagDecimal}; Chain MCP was unavailable (${mcpResult.error ?? "unknown error"}).`,
    };
  }

  return {
    ok: false,
    source: "none",
    tool,
    error: combineErrors(mcpResult.error ?? "MCP unavailable", fallbackResult.error ?? "unavailable", "native balance"),
  };
}

/** Condition 2: ERC-20 token balance of the wallet. */
export async function readErc20Balance(ctx: ReaderContext): Promise<ReadResult> {
  if (ctx.token === null) {
    return {
      ok: false,
      source: "none",
      tool: null,
      error: "Token metadata (decimals) is unavailable, so the token balance cannot be interpreted or compared safely.",
    };
  }
  const token = ctx.token;
  const data = encodeBalanceOf(ctx.walletAddress as Address);
  const tool = "eth_call(balanceOf)";

  const mcpResult = await tryMcp<bigint>(
    ctx.mcp,
    "eth_call",
    { transaction: { to: token.address, data }, block: ctx.blockTagDecimal },
    (payload) => {
      const result = (payload as { result?: unknown }).result;
      if (typeof result !== "string") {
        throw new ChainDataError(`eth_call(balanceOf) returned an unexpected payload: ${JSON.stringify(payload)}`);
      }
      return decodeUint256Result(result, "balanceOf");
    },
  );

  if (mcpResult.ok && mcpResult.value !== undefined) {
    return {
      ok: true,
      raw: mcpResult.value,
      decimals: token.decimals,
      source: "chain-mcp",
      tool,
      detail: `Token balance read via Chain MCP tool eth_call (selector balanceOf) at block ${ctx.blockTagDecimal}.`,
    };
  }

  const fallbackResult = await tryFallback(ctx.fallback, async (client) => decodeUint256Result(await client.call(token.address, data, ctx.blockTagHex), "balanceOf"));

  if (fallbackResult.ok && fallbackResult.value !== undefined) {
    return {
      ok: true,
      raw: fallbackResult.value,
      decimals: token.decimals,
      source: "rpc-fallback",
      tool: "eth_call(balanceOf)",
      detail: `Token balance read via documented read-only JSON-RPC fallback (eth_call balanceOf) at block ${ctx.blockTagDecimal}; Chain MCP was unavailable (${mcpResult.error ?? "unknown error"}).`,
    };
  }

  return {
    ok: false,
    source: "none",
    tool,
    error: combineErrors(mcpResult.error ?? "MCP unavailable", fallbackResult.error ?? "unavailable", "ERC-20 balance"),
  };
}

/** Condition 3: ERC-20 allowance of wallet -> spender. */
export async function readErc20Allowance(ctx: ReaderContext): Promise<ReadResult> {
  if (ctx.token === null) {
    return {
      ok: false,
      source: "none",
      tool: null,
      error: "Token metadata (decimals) is unavailable, so the allowance cannot be interpreted or compared safely.",
    };
  }
  const token = ctx.token;
  const data = encodeAllowance(ctx.walletAddress as Address, ctx.spenderAddress as Address);
  const tool = "eth_call(allowance)";

  const mcpResult = await tryMcp<bigint>(
    ctx.mcp,
    "eth_call",
    { transaction: { to: token.address, data }, block: ctx.blockTagDecimal },
    (payload) => {
      const result = (payload as { result?: unknown }).result;
      if (typeof result !== "string") {
        throw new ChainDataError(`eth_call(allowance) returned an unexpected payload: ${JSON.stringify(payload)}`);
      }
      return decodeUint256Result(result, "allowance");
    },
  );

  if (mcpResult.ok && mcpResult.value !== undefined) {
    return {
      ok: true,
      raw: mcpResult.value,
      decimals: token.decimals,
      source: "chain-mcp",
      tool,
      detail: `Allowance read via Chain MCP tool eth_call (selector allowance) at block ${ctx.blockTagDecimal}.`,
    };
  }

  const fallbackResult = await tryFallback(ctx.fallback, async (client) =>
    decodeUint256Result(await client.call(token.address, data, ctx.blockTagHex), "allowance"),
  );

  if (fallbackResult.ok && fallbackResult.value !== undefined) {
    return {
      ok: true,
      raw: fallbackResult.value,
      decimals: token.decimals,
      source: "rpc-fallback",
      tool: "eth_call(allowance)",
      detail: `Allowance read via documented read-only JSON-RPC fallback (eth_call allowance) at block ${ctx.blockTagDecimal}; Chain MCP was unavailable (${mcpResult.error ?? "unknown error"}).`,
    };
  }

  return {
    ok: false,
    source: "none",
    tool,
    error: combineErrors(mcpResult.error ?? "MCP unavailable", fallbackResult.error ?? "unavailable", "ERC-20 allowance"),
  };
}
