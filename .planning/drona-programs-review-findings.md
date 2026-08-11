# Drona Programs: open review findings

Handoff note for whoever owns the Drona Programs workstream. **None of this is
in a PR.** It was surfaced by CodeRabbit on [#97][pr97] (a conciseness change to
the coach prompt) because that PR briefly carried a sync of the deployed
`ai-coach` source into the repo. The Programs sync was then dropped from #97 to
keep it reviewable, so these findings have no other home.

Everything below describes code that is **already running in production**
(ai-coach v87 and later) but has **never been in a merged PR**. `main` still has
no Programs code at all. Verified against the deployed source on 2026-08-11 by
`supabase functions download ai-coach --project-ref rjmmslierxhvwdjgjilb`.

Line numbers refer to the DEPLOYED source, not `main`.

---

## 1. `forceToolAllowed` has no `generate_program` clause

`supabase/functions/ai-coach/index.ts`, in the mode-resolution block.

Mode resolves as `explicitMode ?? forceTool ?? 'chat'`. `'generate_program'` is
not a valid `explicitMode`, but it **is** a valid `forceTool`, so a request
carrying a bare `force_tool: 'generate_program'` resolves `mode` to
`'generate_program'`. The `forceToolAllowed` allowlist covers
`discuss_program` and `refine_program` but has no
`mode === 'generate_program' && forceTool === 'generate_program'` clause, so the
force is dropped:

- `effectiveForceTool` becomes `null`, so `tool_choice` is never set. The model
  sees `generate_program` as its only tool but is not compelled to call it.
- `statusPhase` degrades from `'generating_program'` to `'thinking'`.

**Severity: latent, not live.** Grepped the whole client (`app/`, `components/`,
`hooks/`, `lib/`) for `generate_program` and it appears nowhere, so nothing
reaches this path today. It becomes a real bug the moment a client forces the
tool directly, which is the natural way to add a "generate program" button.

The actual defect right now is the comment above the allowlist, which asserts:

> a resolved `mode === 'generate_program'` never happens because it is not an
> explicitMode value; program creation always routes through a discuss/refine
> program mode

The reasoning is wrong. The `?? forceTool` fallback is exactly how that mode
gets reached. The conclusion happens to hold only because no caller does it yet.

Fix: add the missing clause and correct the comment to say the path is currently
unused rather than unreachable.

## 2. `TARGET_CHANGE_BEHAVIOR` is ungated but `PROPOSE_TARGETS_TOOL` is not

`supabase/functions/ai-coach/prompt.ts`, `buildSystemPrompt`.

`TARGET_CHANGE_BEHAVIOR` is interpolated into `staticText` unconditionally, so
**every** mode gets it. `PROPOSE_TARGETS_TOOL` is only appended in the final
fallback branch of the tool selection, so only plain chat mode actually has the
tool.

Result: `generate_workout`, `generate_plan`, `generate_program`, and all the
`refine_*` / `discuss_*` modes are told "you can change the user's targets, but
ONLY through the propose_targets tool" while that tool is absent from their
toolkit.

**Severity: low but unambiguous.** Nothing in those modes prompts a target
change, so it is unlikely to misfire, but it is an instruction/tool mismatch and
it burns cached prompt tokens in every mode that cannot act on it.

Fix: gate the block to the same condition that appends `PROPOSE_TARGETS_TOOL`.
Note this changes the cached static block, so it invalidates the prompt cache on
first deploy.

## 3. Program schema has no numeric bounds

`supabase/functions/ai-coach/prompt.ts`, `GENERATE_PROGRAM_TOOL`.

The descriptions document ranges that the schema does not enforce:

- `duration_weeks` says "1-26" with no `minimum` / `maximum`
- `phases` says "Typically 2-6" with no `minItems` / `maxItems`

A zero-week phase or a 40-phase program is currently schema-valid, leaving the
client to defend against it.

Worth more attention on `PHASE_DIET_SCHEMA` and especially `PROPOSE_TARGETS_TOOL`,
where `calories` and `protein_g` flow to the user's profile. An out-of-range
calorie target there is a real user-facing problem, not just malformed data.

## 4. Confirm the plan-sized token budget covers a worst-case program

`supabase/functions/ai-coach/index.ts`, the `maxTokens` selection (both the
streaming and non-streaming paths).

Program modes reuse `GENERATE_PLAN_MAX_TOKENS`. A 6-phase program carries a
title, objective, rationale, plus four directive strings and a training block per
phase, which may exceed a plan payload.

Truncation is at least loud rather than silent: a partial terminal tool is caught
and surfaced as `tool_truncated`. But the user still loses the turn. Worth
measuring a serialized worst-case payload against the budget before the feature
ships more widely, and either raising the budget or bounding program size per
finding 3.

---

## Context worth knowing

`ai-coach` still has no single source of truth, and the drift is bidirectional:

- **Deployed is ahead of `main`** on the entire Programs surface
  (`PROGRAM_COACHING`, `TARGET_CHANGE_BEHAVIOR`, `GENERATE_PROGRAM_TOOL`,
  `PROPOSE_TARGETS_TOOL`, the program modes and their routing).
- **`main` is ahead of deployed** on the three #95 review-nit fixes
  (`RETRIEVAL_QUERY_TIMEOUT_MS` plus the optional `timeoutMs` arg on
  `callAnthropic`, and `recordTrace`'s missing-column retry stripping the 0095
  `retrieval_query_*` fields).

So **do not deploy ai-coach from `main`**. It would clobber Programs off live, as
the v85/v86 deploy already did once. Until the Programs work lands in `main`, any
deploy has to be grafted onto the deployed source:

```bash
supabase functions download ai-coach --project-ref rjmmslierxhvwdjgjilb
```

apply your hunks to that copy, then deploy from a directory that also contains a
`supabase/config.toml` carrying `verify_jwt = false` for `ai-coach` (without it
the gateway rejects the Clerk JWT). Verify by re-downloading and diffing; it
round-trips byte-identical. `git merge-file <yours> <git-base> <live>` is the
tool that worked for reconciling two forks.

Merging the Programs work into `main` and then doing one clean deploy from `main`
is what finally ends this.

[pr97]: https://github.com/sarthak20241/overload-v3/pull/97
