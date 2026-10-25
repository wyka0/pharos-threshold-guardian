/**
 * Minimal Streamable-HTTP JSON-RPC 2.0 client for the official Pharos Chain
 * MCP server (`pharos-mcp-server`, endpoint http://127.0.0.1:3999/mcp).
 *
 * Protocol notes (verified against the live server):
 *  - POST /mcp with JSON-RPC body; responses come back as SSE frames
 *    ("data: {...}") or plain JSON.
 *  - `initialize` returns an `mcp-session-id` response header that must be
 *    echoed on all subsequent calls, after a `notifications/initialized`.
 *  - Tool results arrive as `content: [{ type: "text", text: "<json>" }]`;
 *    the Pharos server packs its payload as a JSON string inside `text`.
 *
 * The client performs READ-ONLY tool calls only. It never invokes
 * send_raw_transaction and never touches signing material. Requests are
 * bounded: a per-call timeout and a small, capped retry budget (honouring
 * Retry-After on HTTP 429) so the guardian can never loop against an RPC.
 */

export const DEFAULT_MCP_ENDPOINT = "http://127.0.0.1:3999/mcp";
export const DEFAULT_MCP_TIMEOUT_MS = 20_000;
export const DEFAULT_MCP_MAX_RETRIES = 2;

export interface ChainMcpClientOptions {
  endpoint?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class McpClientError extends Error {
  public override readonly name = "McpClientError";
  constructor(message: string) {
    super(message);
  }
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class ChainMcpClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private sessionId: string | null = null;
  private nextId = 1;
  private connected = false;

  constructor(options: ChainMcpClientOptions = {}) {
    this.endpoint = options.endpoint ?? DEFAULT_MCP_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MCP_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  /**
   * Perform the MCP initialize handshake. Safe to call multiple times;
   * subsequent calls are no-ops.
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    const initResult = await this.rawRequest("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "pharos-threshold-guardian", version: "1.0.0" },
    });
    if (initResult.error !== undefined) {
      throw new McpClientError(`MCP initialize failed: ${initResult.error.message}`);
    }
    await this.rawNotification("notifications/initialized");
    this.connected = true;
  }

  /**
   * Call a read-only tool and return the parsed JSON payload from the first
   * text content block. Throws McpClientError on transport, JSON-RPC, or
   * tool-level errors.
   */
  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.connect();
    const response = await this.rawRequest("tools/call", { name: toolName, arguments: args });
    if (response.error !== undefined) {
      throw new McpClientError(`MCP tool ${toolName} failed: ${response.error.message}`);
    }
    const result = response.result as { isError?: boolean; content?: Array<{ type: string; text?: string }> } | undefined;
    if (result === undefined || result === null) {
      throw new McpClientError(`MCP tool ${toolName} returned an empty result.`);
    }
    if (result.isError === true) {
      const firstText = result.content?.[0]?.text ?? "unknown tool error";
      throw new McpClientError(`MCP tool ${toolName} reported an error: ${firstText}`);
    }
    const text = result.content?.find((block) => block.type === "text")?.text;
    if (typeof text !== "string") {
      throw new McpClientError(`MCP tool ${toolName} returned no text content.`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Not JSON; return the raw text so callers can still inspect it.
      return text;
    }
  }

  /** Best-effort close; the Streamable HTTP server needs no teardown. */
  async close(): Promise<void> {
    this.connected = false;
  }

  /**
   * POST one JSON-RPC message with timeout and bounded retries on transient
   * failures (HTTP 429/502/503/504, network errors).
   */
  private async rawRequest(method: string, params: unknown): Promise<JsonRpcResponse> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params });
    let lastError = "unknown error";

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        await this.sleepImpl(Math.min(500 * attempt, 2000));
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        };
        if (this.sessionId !== null) {
          headers["mcp-session-id"] = this.sessionId;
        }
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });

        const retryAfterHeader = response.headers.get("retry-after");
        if (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) {
          lastError = `HTTP ${response.status} from MCP endpoint`;
          if (attempt < this.maxRetries) {
            const retryAfterMs = retryAfterHeader !== null ? Number(retryAfterHeader) * 1000 : NaN;
            if (Number.isFinite(retryAfterMs) && retryAfterMs > 0 && retryAfterMs <= 10_000) {
              await this.sleepImpl(retryAfterMs);
            }
            continue;
          }
          break;
        }
        if (!response.ok) {
          throw new McpClientError(`MCP endpoint returned HTTP ${response.status} for ${method}.`);
        }

        const newSession = response.headers.get("mcp-session-id");
        if (newSession !== null) {
          this.sessionId = newSession;
        }

        const text = await response.text();
        return this.parseResponse(text, method);
      } catch (error) {
        if (error instanceof McpClientError) {
          throw error;
        }
        lastError = error instanceof Error ? error.message : String(error);
        // Transient network failures are retried; anything else falls through
        // to the retry cap as well (bounded by maxRetries).
      } finally {
        clearTimeout(timer);
      }
    }

    throw new McpClientError(
      `MCP request ${method} failed after ${this.maxRetries + 1} attempt(s): ${lastError}. ` +
        `Is the Pharos Chain MCP server running at ${this.endpoint}?`,
    );
  }

  /** Fire a notification (no id, no response expected). Best effort. */
  private async rawNotification(method: string): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.sessionId !== null) {
      headers["mcp-session-id"] = this.sessionId;
    }
    try {
      await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", method }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      // Notifications are advisory; a failure here must not block reads.
    }
  }

  /** Parse an SSE-framed or plain-JSON JSON-RPC response. */
  private parseResponse(text: string, method: string): JsonRpcResponse {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new McpClientError(`MCP endpoint returned an empty body for ${method}.`);
    }
    // SSE frames may include "event:" lines before the "data:" payload, so
    // scan for data: lines anywhere in the body rather than only at the start.
    const dataLines = trimmed
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length > 0) {
      try {
        return JSON.parse(dataLines.join("")) as JsonRpcResponse;
      } catch (error) {
        throw new McpClientError(`MCP endpoint returned malformed SSE data for ${method}: ${(error as Error).message}`);
      }
    }
    try {
      return JSON.parse(trimmed) as JsonRpcResponse;
    } catch (error) {
      throw new McpClientError(`MCP endpoint returned a non-JSON body for ${method}: ${(error as Error).message}`);
    }
  }
}
