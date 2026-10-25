import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ChainMcpClient, McpClientError } from "../src/chain/mcpClient.js";
import { startMockPharosMcp, DEFAULT_MOCK_STATE, type MockMcpServer, type MockChainState } from "./helpers/mockPharosMcp.js";

let mock: MockMcpServer;
let state: MockChainState;

beforeEach(() => {
  state = structuredClone(DEFAULT_MOCK_STATE);
});

afterEach(async () => {
  if (mock !== undefined) {
    await mock.close();
    mock = undefined as unknown as MockMcpServer;
  }
});

async function freshClient(options: { failWith429First?: number; failAllReads?: boolean } = {}): Promise<ChainMcpClient> {
  mock = await startMockPharosMcp({ state, ...options });
  return new ChainMcpClient({ endpoint: mock.endpoint, timeoutMs: 5000, maxRetries: 2 });
}

test("handshake + get_chain_info returns the configured chain", async () => {
  const client = await freshClient();
  const info = (await client.callTool("get_chain_info")) as { chainId: number };
  assert.equal(info.chainId, 688689);
  await client.close();
});

test("session id from initialize is reused on subsequent calls", async () => {
  const client = await freshClient();
  await client.callTool("get_chain_info");
  await client.callTool("get_balance", { address: "0xE9edd930130bC1F97EB68C86519d4dD1eE778657" });
  // Both calls landed on the mock (proves session handling works).
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[0]?.tool, "get_chain_info");
  assert.equal(mock.calls[1]?.tool, "get_balance");
  await client.close();
});

test("eth_call payload for uint256 selectors is parsed", async () => {
  const client = await freshClient();
  const result = (await client.callTool("eth_call", { transaction: { to: state.tokenSymbol, data: "0x70a08231" + "0".repeat(64) } })) as { result: string };
  assert.equal(BigInt(result.result), BigInt(state.tokenBalance));
  await client.close();
});

test("HTTP 429 is retried and succeeds on a later attempt", async () => {
  const client = await freshClient({ failWith429First: 1 });
  const info = (await client.callTool("get_chain_info")) as { chainId: number };
  assert.equal(info.chainId, 688689);
  await client.close();
});

test("persistent tool errors raise McpClientError with the tool name", async () => {
  const client = await freshClient({ failAllReads: true });
  await assert.rejects(client.callTool("get_chain_info"), (error: unknown) => error instanceof McpClientError && /get_chain_info/.test(error.message));
  await client.close();
});

test("unreachable endpoint raises McpClientError after bounded retries", async () => {
  // Port 1 is reserved; connection refused immediately on loopback.
  const client = new ChainMcpClient({ endpoint: "http://127.0.0.1:1/mcp", timeoutMs: 500, maxRetries: 1, sleepImpl: async () => {} });
  await assert.rejects(client.callTool("get_chain_info"), McpClientError);
});

test("unknown tools surface as JSON-RPC errors", async () => {
  const client = await freshClient();
  await assert.rejects(client.callTool("mint_money"), McpClientError);
  await client.close();
});
