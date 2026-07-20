/**
 * A `fetch` stand-in that answers Anthropic Messages API calls by shelling out
 * to `claude -p`, so the eval can run on a Claude subscription instead of API
 * credit.
 *
 * parseMeal.ts only ever reaches the model through `deps.fetchFn`, so nothing
 * in the pipeline needs to know. What this has to bridge:
 *
 *   - The pipeline forces a tool call (`tool_choice`), which the CLI has no
 *     equivalent for. We inline the tool's JSON Schema into the system prompt
 *     and demand a bare JSON object back, then re-wrap it as a `tool_use`
 *     content block so callers see the response shape they expect.
 *   - The CLI is an agent, not a raw completion. `--system-prompt` replaces
 *     its default prompt outright and the tool flags stop it wandering off to
 *     read files, which keeps this close to a plain model call.
 *
 * Caveats, because they matter when reading the results:
 *   - LATENCY IS MEANINGLESS here. Each call pays CLI process startup and
 *     agent-session overhead, so it is seconds slower than the real path.
 *     Use this to check correctness, never to judge speed.
 *   - Prompt caching is not exercised, and token counts are the CLI's, so
 *     the token total is not comparable to an API run either.
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

const CLI_TIMEOUT_MS = 180_000;

interface ToolDef {
  name: string;
  description?: string;
  input_schema?: unknown;
}

/** The system field is either a string or the cache-control block form. */
function systemToText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

/**
 * Flatten a Messages conversation to plain text. The web-lookup path is
 * multi-turn and carries tool_use / tool_result blocks, so those are rendered
 * rather than dropped - the model needs the search results to answer.
 */
function messagesToText(messages: unknown[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const { role, content } = m as { role: string; content: unknown };
    const label = role === "assistant" ? "Assistant" : "User";
    if (typeof content === "string") {
      parts.push(`${label}: ${content}`);
      continue;
    }
    if (!Array.isArray(content)) continue;
    const chunks: string[] = [];
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      const block = b as Record<string, unknown>;
      if (block.type === "text") chunks.push(String(block.text));
      else if (block.type === "tool_use") {
        chunks.push(`[called ${String(block.name)} with ${JSON.stringify(block.input)}]`);
      } else if (block.type === "tool_result") {
        const c = block.content;
        chunks.push(`[result: ${typeof c === "string" ? c : JSON.stringify(c)}]`);
      }
    }
    if (chunks.length) parts.push(`${label}: ${chunks.join("\n")}`);
  }
  return parts.join("\n\n");
}

/** Pull the JSON object out of the CLI's reply, fenced or not. */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    // Fall back to the outermost braces: the model sometimes prefaces the
    // object with a sentence despite being told not to.
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error(`no JSON in CLI reply: ${body.slice(0, 300)}`);
    return JSON.parse(body.slice(start, end + 1));
  }
}

function runClaude(args: string[], stdin: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    // Run outside the repo so the CLI does not pick up CLAUDE.md, skills, or
    // project settings - those would contaminate the prompt under test.
    const child = spawn("claude", args, { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`claude -p exceeded ${CLI_TIMEOUT_MS}ms`));
    }, CLI_TIMEOUT_MS);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}

/**
 * Drop-in for `deps.fetchFn`. Only understands the Messages endpoint; anything
 * else falls through to real fetch (the eval also calls Voyage for embeddings).
 */
export function makeClaudeCliFetch(model: string): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!href.includes("api.anthropic.com")) return fetch(url as never, init);

    const payload = JSON.parse(String(init?.body ?? "{}")) as {
      system?: unknown;
      messages?: unknown[];
      tools?: ToolDef[];
      tool_choice?: { type: string; name?: string };
    };

    const forced = payload.tool_choice?.name;
    const tools = payload.tools ?? [];
    const tool = forced ? tools.find((t) => t.name === forced) : tools[0];
    if (!tool) throw new Error(`claude-cli shim: no tool to force (tool_choice=${JSON.stringify(payload.tool_choice)})`);

    const system = [
      systemToText(payload.system),
      "",
      "## Output contract",
      "",
      `You must answer by producing the arguments for a function called \`${tool.name}\`.`,
      tool.description ? `Its purpose: ${tool.description}` : "",
      "",
      "Its arguments must match this JSON Schema exactly:",
      "",
      JSON.stringify(tool.input_schema, null, 2),
      "",
      "Reply with ONLY that JSON object. No prose, no explanation, no code fence.",
      "Do not use any tools; answer from the conversation alone.",
    ].filter(Boolean).join("\n");

    const args = [
      "-p",
      "--output-format", "json",
      "--model", model,
      "--system-prompt", system,
      "--max-turns", "1",
      "--disallowed-tools", "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite",
    ];

    const { code, stdout, stderr } = await runClaude(args, messagesToText(payload.messages ?? []));
    if (code !== 0) {
      return new Response(`claude -p exited ${code}: ${stderr.slice(0, 400)}`, { status: 502 });
    }

    let envelope: { result?: string; usage?: { input_tokens?: number; output_tokens?: number }; is_error?: boolean };
    try {
      envelope = JSON.parse(stdout);
    } catch {
      return new Response(`claude -p gave non-JSON envelope: ${stdout.slice(0, 400)}`, { status: 502 });
    }
    if (envelope.is_error) {
      return new Response(`claude -p reported an error: ${String(envelope.result).slice(0, 400)}`, { status: 502 });
    }

    let input: unknown;
    try {
      input = extractJson(String(envelope.result ?? ""));
    } catch (e) {
      return new Response(`claude-cli shim: ${String(e).slice(0, 400)}`, { status: 502 });
    }

    // Re-wrap as a Messages API response so callers are none the wiser.
    return new Response(
      JSON.stringify({
        id: "msg_claude_cli",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "tool_use", id: "toolu_claude_cli", name: tool.name, input }],
        stop_reason: "tool_use",
        usage: {
          input_tokens: envelope.usage?.input_tokens ?? 0,
          output_tokens: envelope.usage?.output_tokens ?? 0,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}
