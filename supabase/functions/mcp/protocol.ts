// MCP over Streamable HTTP, stateless: every POST holds one JSON-RPC message
// and gets one JSON answer. No sessions, no server-sent events. The MCP spec
// allows a server to answer with plain application/json, and ChatGPT and
// Claude both accept it.
//
// This file has no I/O. index.ts passes in the tools and the signed-in user,
// so the tests can drive it with plain objects.

export const SERVER_INFO = { name: "overload", title: "Overload", version: "0.1.0" };

/** Newest first. We answer with the client's version when we know it. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export const INSTRUCTIONS =
  "Overload is the user's fitness app: food diary, workouts, and training plan. " +
  "Use these tools to read the user's data and to log what they ate or trained.";

export interface ToolContext {
  userId: string;
  email: string | null;
}

export interface ToolResult {
  text: string;
  /** Machine-readable copy of the answer, sent as structuredContent. */
  data?: Record<string, unknown>;
  isError?: boolean;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

type Id = string | number | null;

export interface RpcMessage {
  jsonrpc?: unknown;
  id?: Id;
  method?: unknown;
  params?: unknown;
}

export type RpcReply =
  | { jsonrpc: "2.0"; id: Id; result: unknown }
  | { jsonrpc: "2.0"; id: Id; error: { code: number; message: string } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

function ok(id: Id, result: unknown): RpcReply {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: Id, code: number, message: string): RpcReply {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * One JSON-RPC message in, one reply out. A notification (no id) gets null:
 * the caller answers it with HTTP 202 and no body.
 */
export async function handleMessage(
  msg: unknown,
  tools: Tool[],
  ctx: ToolContext,
): Promise<RpcReply | null> {
  if (!isObject(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    const id = isObject(msg) && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null;
    return fail(id, INVALID_REQUEST, "Not a JSON-RPC 2.0 request");
  }
  const isNotification = !("id" in msg) || msg.id === undefined;
  const id: Id = isNotification ? null : (msg.id as Id);
  const params = isObject(msg.params) ? msg.params : {};

  if (isNotification) return null;

  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      });
    case "tools/call": {
      const name = params.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(id, INVALID_PARAMS, `Unknown tool: ${String(name)}`);
      const args = isObject(params.arguments) ? params.arguments : {};
      try {
        const r = await tool.run(args, ctx);
        return ok(id, {
          content: [{ type: "text", text: r.text }],
          ...(r.data ? { structuredContent: r.data } : {}),
          isError: r.isError ?? false,
        });
      } catch (e) {
        // A tool failure is a tool result with isError, not a protocol error,
        // so the assistant sees it and can tell the user.
        console.error(`[mcp] tool ${tool.name} failed:`, e);
        return ok(id, {
          content: [{ type: "text", text: "Something went wrong on Overload's side. Try again in a minute." }],
          isError: true,
        });
      }
    }
    default:
      return fail(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}

/** Parse a POST body. A JSON array (a batch) is refused: the 2025-06-18
 *  spec removed batching. */
export function parseBody(raw: string): { msg: unknown } | { reply: RpcReply } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reply: fail(null, PARSE_ERROR, "Body is not valid JSON") };
  }
  if (Array.isArray(parsed)) return { reply: fail(null, INVALID_REQUEST, "Batches are not supported") };
  return { msg: parsed };
}
