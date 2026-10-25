/**
 * ERC-20 read helpers used by the condition readers.
 *
 * Encoding/decoding uses viem with a minimal read-only ABI. Only view
 * functions are ever encoded here: balanceOf, allowance, decimals, symbol.
 * Nothing in this file can produce a state-changing transaction.
 */

import { encodeFunctionData, decodeFunctionResult, type Address } from "viem";
import { ChainDataError } from "../errors.js";

export const ERC20_READ_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

export function encodeBalanceOf(account: Address): string {
  return encodeFunctionData({ abi: ERC20_READ_ABI, functionName: "balanceOf", args: [account] });
}

export function encodeAllowance(owner: Address, spender: Address): string {
  return encodeFunctionData({ abi: ERC20_READ_ABI, functionName: "allowance", args: [owner, spender] });
}

export function encodeDecimals(): string {
  return encodeFunctionData({ abi: ERC20_READ_ABI, functionName: "decimals" });
}

export function encodeSymbol(): string {
  return encodeFunctionData({ abi: ERC20_READ_ABI, functionName: "symbol" });
}

/** Decode a balanceOf/allowance return payload into a bigint. */
export function decodeUint256Result(data: string, what: string): bigint {
  if (typeof data !== "string" || !data.startsWith("0x")) {
    throw new ChainDataError(`${what}: expected hex-encoded return data, got ${JSON.stringify(data)}.`);
  }
  const hex = data.slice(2);
  if (hex.length === 0) {
    throw new ChainDataError(
      `${what}: the call returned empty data (0x). The target is probably not an ERC-20 contract at this address.`,
    );
  }
  try {
    const value = decodeFunctionResult({ abi: ERC20_READ_ABI, functionName: "balanceOf", data: data as `0x${string}` });
    if (typeof value === "bigint") {
      return value;
    }
  } catch {
    // Fall through to the strict manual decode below.
  }
  // Strict fallback: a uint256 must be exactly 32 bytes.
  if (hex.length !== 64) {
    throw new ChainDataError(`${what}: expected 32 bytes of return data, got ${hex.length / 2} bytes.`);
  }
  return BigInt(`0x${hex}`);
}

/** Decode a decimals() return payload (uint8). */
export function decodeDecimalsResult(data: string): number {
  const value = decodeUint256Result(data, "decimals()");
  if (value > 255n) {
    throw new ChainDataError(`decimals(): value ${value} does not fit in uint8; the target is probably not an ERC-20 token.`);
  }
  return Number(value);
}

/** Decode a symbol() return payload (string). */
export function decodeSymbolResult(data: string): string {
  try {
    const symbol = decodeFunctionResult({ abi: ERC20_READ_ABI, functionName: "symbol", data: data as `0x${string}` });
    if (typeof symbol === "string" && symbol.length > 0) {
      return symbol;
    }
  } catch {
    // Rethrown below with context.
  }
  throw new ChainDataError("symbol(): could not decode the token symbol from the returned data.");
}
