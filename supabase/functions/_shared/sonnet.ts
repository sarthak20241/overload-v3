/**
 * Claude Sonnet 5.5: the model id and the request settings every Sonnet call
 * shares (ai-coach chat and generate modes, the fan-out plan, the food agent).
 *
 * Two things changed from Sonnet 4.6 that every caller has to handle:
 *
 *   1. Forced tool_choice ({type:"any"} or {type:"tool"}) is a 400. A call that
 *      must end in one tool sends tool_choice auto plus `requireTool`, an
 *      appended system message naming the tool, and checks that the call came
 *      back. The note is append-only, so the prompt cache and the history the
 *      model sees stay intact.
 *   2. Sonnet 5.5 thinks by default, and thinking spends max_tokens and adds
 *      latency before the first token. Sonnet 4.6 ran all of these calls with
 *      no extended thinking, so `SONNET_SETTINGS` keeps them that way with
 *      `between_tools`, the lowest setting: no thinking, only short progress
 *      notes between tool calls, which come back as `thinking` blocks WITH text
 *      and must be passed back unchanged in a tool loop.
 *
 * `between_tools` is Sonnet 5.5 only (any other model returns a 400), so it is
 * applied through `sonnetSettings(model)`, never spread unconditionally into a
 * body whose model can vary.
 */
export const SONNET_MODEL = "claude-sonnet-5-5";

/** No extended thinking, effort set explicitly. Effort is `high`, the API
 *  default and what Sonnet 4.6 ran at; with between_tools it may not go higher. */
export const SONNET_SETTINGS = {
  thinking: { type: "between_tools" },
  output_config: { effort: "high" },
} as const;

/** The settings for `model`, or nothing when it is not Sonnet 5.5 (an eval's
 *  fill model, a scripted test model). */
export function sonnetSettings(model: string): Partial<typeof SONNET_SETTINGS> {
  return model === SONNET_MODEL ? SONNET_SETTINGS : {};
}

/**
 * The replacement for a forced tool_choice. Append after the last user turn:
 * a mid-conversation system message must follow a user message, and it stays
 * in the history on later requests rather than being removed (removing it
 * would edit the history the model already answered).
 */
export function requireTool(tool: string): { role: "system"; content: string } {
  return {
    role: "system",
    content: `Call the ${tool} tool now. This turn must open with that call; do not answer in plain text instead.`,
  };
}

/**
 * The second ask, for when the model answered in text despite `requireTool`.
 * Sent as a user turn after the model's own reply, because a system message
 * cannot follow an assistant turn.
 */
export function retryTool(tool: string): { role: "user"; content: string } {
  return { role: "user", content: `Call the ${tool} tool now with what we have.` };
}
