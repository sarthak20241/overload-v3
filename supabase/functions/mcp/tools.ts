// The tools ChatGPT and Claude can call. Step 0 (the sign-in spike) has one:
// `ping`, which proves the sign-in reached the right Overload account. The
// read and write tools from .planning/mcp-tools-plan.md land in later steps.

import type { Tool } from "./protocol.ts";

export const ping: Tool = {
  name: "ping",
  title: "Check the Overload connection",
  description: "Checks that Overload is connected and says which account is signed in. " +
    "Use it when the user asks if the connection works.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
  run(_args, ctx) {
    const who = ctx.email ?? "your Overload account";
    return Promise.resolve({
      text: `Connected to Overload as ${who}.`,
      data: { connected: true, email: ctx.email },
    });
  },
};

export const TOOLS: Tool[] = [ping];
