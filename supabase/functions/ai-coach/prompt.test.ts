// Run with: deno test supabase/functions/ai-coach/prompt.test.ts
//
// The toolkit per mode and the blocks the static prompt must carry. Seen live
// 2026-09-18: Drona told a user it could not track body measurements. The app
// could; the prompt never said so. These tests pin what the prompt now says
// about the app and about memory, and which modes carry the memory tools.

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildSystemPrompt, CATALOG_MODES, MEMORY_TOOL_NAMES, TERMINAL_TOOLS, withExerciseCatalog } from "./prompt.ts";
import { APP_GUIDE_TOPICS } from "./appGuide.ts";

type Mode = NonNullable<Parameters<typeof buildSystemPrompt>[0]["mode"]>;

const names = (mode: Mode, freeTier = false) =>
  buildSystemPrompt({ userContext: null, mode, freeTier }).tools.map((t) => t.name);

const staticBlock = (mode: Mode = "chat") => buildSystemPrompt({ userContext: null, mode }).system[0].text;

Deno.test("the static prompt tells the coach what the app can do", () => {
  const text = staticBlock();
  assertStringIncludes(text, "<app_features>");
  assertStringIncludes(text, "TAPE MEASUREMENTS at 13 sites");
  assertStringIncludes(text, "Never tell them the app cannot do one of these");
  // and what it cannot, so the fix does not swing the other way
  assertStringIncludes(text, "barcode scanning");
});

Deno.test("the data schema names the body and plan tables", () => {
  const text = staticBlock();
  for (const table of ["body_measurements(", "daily_metrics(", "plan_changes(", "drona_cards(", "coach_memory(", "coach_programs("]) {
    assertStringIncludes(text, table);
  }
});

Deno.test("the memory block is in the static prompt for every mode", () => {
  for (const mode of ["chat", "refine_plan", "discuss_program", "live_workout", "generate_plan"] as Mode[]) {
    assertStringIncludes(staticBlock(mode), "<memory>");
    assertStringIncludes(staticBlock(mode), "remember_fact");
  }
});

Deno.test("memory distinguishes an emitted proposal from an applied app change", () => {
  const text = staticBlock("discuss_program");
  const memory = text.slice(text.indexOf("<memory>"), text.indexOf("</memory>"));
  assertStringIncludes(memory, "the user still has to Save or Apply");
  assertStringIncludes(memory, 'explicitly label it "proposed/unapplied"');
  assertStringIncludes(memory, "current persisted user_context and recent_plan_changes take precedence");
  assert(!memory.includes("save the decision in the same turn: what changed and why"));
});

Deno.test("memory tools ride every conversational mode", () => {
  for (const mode of [
    "chat", "refine_workout", "refine_plan", "discuss_workout", "discuss_plan",
    "discuss_program", "refine_program", "live_workout",
  ] as Mode[]) {
    const n = names(mode);
    assert(n.includes("remember_fact"), `${mode} lacks remember_fact`);
    assert(n.includes("forget_fact"), `${mode} lacks forget_fact`);
    // and the read tools the awareness fix adds
    assert(n.includes("coach_get_body_log"), `${mode} lacks coach_get_body_log`);
    assert(n.includes("coach_get_app_guide"), `${mode} lacks coach_get_app_guide`);
  }
});

Deno.test("the forced single-tool modes stay single-tool", () => {
  assertEquals(names("generate_workout"), ["generate_workout"]);
  assertEquals(names("generate_plan"), ["generate_plan"]);
  assertEquals(names("generate_program"), ["generate_program"]);
});

Deno.test("free tier keeps memory: it is not a terminal tool", () => {
  // index.ts strips TERMINAL_TOOLS for free users. Memory must survive that.
  for (const name of MEMORY_TOOL_NAMES) assert(!TERMINAL_TOOLS.has(name));
  const n = names("chat", true);
  assert(n.includes("remember_fact"));
  assert(!n.includes("propose_targets"));
});

Deno.test("the cache marker sits on the last tool only", () => {
  const { tools } = buildSystemPrompt({ userContext: null, mode: "chat" });
  const marked = tools.filter((t) => t.cache_control);
  assertEquals(marked.length, 1);
  assertEquals(tools[tools.length - 1].cache_control?.type, "ephemeral");
});

Deno.test("the app guide tool lists its topics so the model can pick", () => {
  const { tools } = buildSystemPrompt({ userContext: null, mode: "chat" });
  const guide = tools.find((t) => t.name === "coach_get_app_guide")!;
  assertStringIncludes(guide.description, "body_log");
  assertStringIncludes(guide.description, "not_available");
  const topic = (guide.input_schema.properties as Record<string, { enum?: string[] }>).topic;
  assertEquals(topic.enum, APP_GUIDE_TOPICS);
});

Deno.test("withExerciseCatalog: catalog sits after the static block and the cache markers stay at three in system", () => {
  const { system, tools } = buildSystemPrompt({ userContext: null, retrievedResearch: [], mode: "generate_workout" });
  const before = (system as { cache_control?: unknown }[]).filter((b) => b.cache_control).length;
  const out = withExerciseCatalog(system, ["Squat", "Bench Press"]) as { text: string; cache_control?: unknown }[];
  assertEquals(out.length, (system as unknown[]).length + 1);
  assert(out[1].text.includes("Squat; Bench Press"));
  assertEquals(out[0].cache_control, undefined);
  assertEquals(out[1].cache_control, { type: "ephemeral" });
  // The API allows four markers: tools carry one, so system may hold three.
  const markers = out.filter((b) => b.cache_control).length;
  assertEquals(markers, before);
  assert(markers + (tools as { cache_control?: unknown }[]).filter((t) => t.cache_control).length <= 4);
  assertEquals(withExerciseCatalog(system, []), system);
  assert(CATALOG_MODES.has("refine_plan") && !CATALOG_MODES.has("chat") && !CATALOG_MODES.has("generate_program"));
});

// Drawn blocks (tables, charts, stat tiles): taught only to a client that
// says it can draw them. An older app would show the raw fenced JSON.
Deno.test("showing_data is taught only when the client can draw it", () => {
  const withUi = (mode: Mode) =>
    buildSystemPrompt({ userContext: null, mode, richReplies: true }).system[0].text;
  assert(withUi("chat").includes("<showing_data>"), "chat with ui gets the format");
  assert(withUi("live_workout").includes("<showing_data>"), "live workout chat gets the format");
  assert(!staticBlock("chat").includes("<showing_data>"), "no ui flag, no format");
  for (const forced of ["generate_workout", "generate_plan", "generate_program"] as Mode[]) {
    assert(!withUi(forced).includes("<showing_data>"), `${forced} replies are not chat messages`);
  }
});
