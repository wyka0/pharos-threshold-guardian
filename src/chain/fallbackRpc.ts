/**
 * Documented, read-only JSON-RPC fallback for Pharos Atlantic Testnet.
 *
 * Used ONLY when the official Chain MCP server cannot answer a read. Every
 * value obtained through this client is recorded in the decision trace with
 * data source "rpc-fallback" so it is never mistaken for an MCP read.
 *
 * Methods used (all read-only, no signing, no state changes):
 *   - eth_chainId        (network verification)
 *   - eth_blockNumber    (block pinning)
 *   - eth_getBalance     (native PHRS balance)
 *   - eth_call           (ERC-20 balanceOf / allowance / decimals / symbol)
 *   - eth_getCode        (contract existence check)
 */

import { ChainDataError } from "../errors.js";

export const DEFAULT_FALLBACK_TIMEOUT_MS = 20_000;

export class FallbackRpcClient {
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(rpcUrl: string, timeoutMs: number = DEFAULT_FALLBACK_TIMEOUT_MS, fetchImpl: typeof fetch = fetch) {
    this.rpcUrl = rpcUrl;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  get url(): string {
    return this.rpcUrl;
  }

  /** Raw JSON-RPC call with timeout. Throws ChainDataError on failure. */
  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new ChainDataError(`Fallback RPC ${this.rpcUrl} returned HTTP ${response.status} for ${method}.`);
      }
      const body = (await response.json()) as { result?: T; error?: { message?: string } };
      if (body.error !== undefined && body.error !== null) {
        throw new ChainDataError(`Fallback RPC ${method} failed: ${body.error.message ?? "unknown error"}`);
      }
      if (body.result === undefined) {
        throw new ChainDataError(`Fallback RPC ${method} returned no result.`);
      }
      return body.result;
    } catch (error) {
      if (error instanceof ChainDataError) {
        throw error;
      }
      throw new ChainDataError(`Fallback RPC ${method} request failed: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async chainId(): Promise<string> {
    return this.rpc<string>("eth_chainId", []);
  }

  async blockNumber(): Promise<string> {
    return this.rpc<string>("eth_blockNumber", []);
  }

  /** Native balance in wei as a decimal string. */
  async getBalance(address: string, blockTag: string): Promise<string> {
    const hex = await this.rpc<string>("eth_getBalance", [address, blockTag]);
    return hexToDecimalString(hex);
  }

  /** Raw eth_call result (hex-encoded return data). */
  async call(to: string, data: string, blockTag: string): Promise<string> {
    return this.rpc<string>("eth_call", [{ to, data }, blockTag]);
  }

  async getCode(address: string, blockTag: string): Promise<string> {
    return this.rpc<string>("eth_getCode", [address, blockTag]);
  }
}

/** Convert "0x1e66c4b" -> "31878219". */
export function hexToDecimalString(hex: string): string {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new ChainDataError(`Expected a 0x-prefixed hex quantity, got ${JSON.stringify(hex)}.`);
  }
  return BigInt(hex).toString(10);
}
