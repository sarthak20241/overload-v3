# generate_plan eval harness

Accuracy gate and latency profile for Drona's plan generation, the slowest
call in the product and the one about to move into the onboarding funnel
(PR #66).

```bash
npx tsx tools/plan-eval/run.ts                       # 9 cases x 3 runs
npx tsx tools/plan-eval/run.ts --variant onboarding  # onboarding cases only
npx tsx tools/plan-eval/run.ts --only onb-hypertrophy-6d-advanced --repeat 5
npx tsx tools/plan-eval/run.ts --model claude-haiku-4-5 --json
```

Needs `ANTHROPIC_API_KEY` (read from `.env.local` at the repo root). Nothing
else: no Supabase, no Clerk, no network beyond Anthropic. A default pass is
~54k Sonnet output tokens.

Exit code is nonzero when any accuracy check fails. Latency is always
reported but only gates behind `--latency-gate`.

## Layout

| file | role |
|---|---|
| `cases.ts` | fixtures: 9 onboarding + 3 coach, with per-case expectations |
| `pipeline.ts` | variants under test + span instrumentation |
| `encoding.ts` | compact line format + parser (the `compact` variant) |
| `score.ts` | deterministic scoring, no LLM judge |
| `run.ts` | orchestration, repeats, percentiles, markdown report |
| `offline-test.ts` | parser/assembly/failure-path tests, **no network** |
| `probe-delivery.ts` | tool_use vs text stream delivery |
| `probe-catalog.ts` | latency cost of a 46 vs 787 name catalog |
| `reports/` | timestamped `.md` (and `.json` with `--json`) |

## Offline tests

```bash
npx tsx tools/plan-eval/offline-test.ts     # 57 assertions, zero API calls
```

Drives the real `supabase/functions/ai-coach/generatePlan.ts` with a mock
`TextCaller`, which is what `GeneratePlanDeps` exists to allow. Covers what the
API-backed eval cannot reach cheaply: malformed model output, clamping, the
skeleton-wins-on-naming rule, and above all the **failure thresholds**.

That last group is the important one. With every fill dead, `assemblePlan`
still returns a structurally valid plan in which every exercise is
`3 x 8-12 @ 90s` with no cue. A caller checking only for `null` sails past it
and onboarding saves it as Drona's work. Verified by mutation: disabling the
`tooManyDead` guard turns exactly two assertions red.

Run these before deploying. They need no credits and finish in seconds.

## Why it is built this way

**The prompt and tool schema are imported from production**, not copied.
`supabase/functions/ai-coach/prompt.ts` is pure TypeScript with no Deno APIs
specifically so a harness can import `buildSystemPrompt`. The older
`tools/eval/run.ts` copied them and has since drifted: it is still on a
4-block system prompt while production is on 8. Do not reintroduce that.

**Scoring is deterministic.** Every check is a fact about the output that
either holds or does not, so it is reproducible and safe in CI. That matters
because this harness exists to be the guardrail while we trade structure for
latency: if a change starts quietly degrading plans, these fail first. A
judged quality pass can layer on top, but it should never gate a merge alone.

**Repeats are the default.** Latency needs a distribution. Production had
n=14 for `generate_plan` across 90 days, which is not enough to say anything
about p95. `--repeat 3` is the floor; use more when comparing variants.

**Cases are hermetic.** The coach cases carry a synthetic
`get_user_coach_context()` blob rather than reading Supabase, so input size
is identical run to run and latency deltas are attributable to the pipeline
rather than to whichever user the eval happened to point at.

## What it measures

Per run, from the Anthropic SSE stream:

| span | meaning |
|---|---|
| `ttft_ms` | request sent to first byte. Prefill and queueing. |
| `decode_ms` | first byte to last. Token generation. |
| `total_ms` | wall clock for the Anthropic call. |
| `workout_complete_ms[i]` | when workout `i` finished streaming. What a progressive render could show, and when. |
| `intent_text_ms` | when the intent sentence finished. Today, the only thing the user sees before the plan lands. |

`workout_complete_ms` comes from `countCompleteWorkouts`, a brace-depth scan
over the accumulated `input_json_delta` buffer that is string- and
escape-aware, so a `}` inside a coaching note does not read as a closed
workout.

We always stream, even though the onboarding path (PR #66) is non-streaming.
Streaming does not change total latency and it is the only way to observe
TTFT and per-workout arrival. Runs that cross `PROD_NONSTREAM_TIMEOUT_MS`
(30s, the abort in `callAnthropic`) are counted separately, because on the
non-streaming path those would have failed and fallen back to the
deterministic starter plan.

## Scope

Covered: the Anthropic call, which is ~95% of the measured wall clock.

Not covered: JWT verification, the access gate, rate limiting, SSE
re-framing, and the client. Those are roughly 1s combined and are better
measured by production spans on `coach_traces` than by simulating them here.

## Adding a variant

`pipeline.ts` exports a `VARIANTS` map. A new pipeline shape (for example a
skeleton call followed by parallel per-day fills) implements the same
`(case, opts) => RunResult` signature and gets scored by the same rules, so
accuracy and latency are directly comparable against `baseline`.

## Forced tool_use does not stream

Measured, not assumed. `probe-delivery.ts` runs the same task two ways and
reports when the payload actually arrives:

```
tool_use (prod)  n=3  total=30.1s  1903 tok  63 tok/s  | 50% of payload by 98% of wall clock | max gap 22269ms
plain text json  n=3  total=18.1s  1216 tok  67 tok/s  | 50% of payload by 63% of wall clock | max gap  1729ms
```

A forced `tool_choice` delivers its `input_json_delta` in one burst at the
end: half the payload arrives at 98% of wall clock, with a 22s gap mid-
stream. Plain text streams smoothly. Reproduced with `curl --no-buffer`, so
it is the API's behavior and not a Node or undici artifact.

Consequences:

- `workout_complete_ms` is honest about what the client receives, but on the
  tool path every workout lands at ~99% of wall clock. It is a measure of
  delivery, not of generation progress.
- Progressive rendering of the plan is **not possible while the output comes
  from a forced tool call**. It becomes possible if the plan is emitted as
  streamed text and parsed incrementally.
- Throughput is the same either way (63 vs 67 tok/s), so constrained decoding
  is not the cost. The token *count* difference above is confounded: the text
  prompt omits the per-exercise `note` field, so do not read it as a clean
  measure of tool-schema overhead.

Re-run `probe-delivery.ts` before relying on any of this; it is one API
behavior away from changing.
