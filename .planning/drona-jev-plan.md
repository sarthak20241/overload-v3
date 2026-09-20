# Jev in Drona cards

Researched 2026-09-20 from the TypeSafe docs. **Nothing here is verified against
the live API yet** (no key in the project). Phase 0 proves it before we build on it.

## What Jev is

A "System One" model: you give it state, you give it named typed questions, it
answers them all in parallel with **calibrated probabilities**. It cannot write
text and it cannot return a wrong shape.

| | |
|---|---|
| Endpoint | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>` |
| Request | `{ model, state, questions }` where state is a string, object or array |
| Question types | `noul` (yes/no -> probability), `choice` (<=255 options -> choice + probabilities + confidence), `score` (2-10 levels -> weighted score + probabilities + confidence) |
| Response | `{ model, answers: { <id>: {...} }, usage }` |
| Latency | 70-500 ms |
| Price | $0.042 / MTok input. Output free. |
| Context | 64k total, 32k for state + longest question |
| Limits | 250k tokens/s, 1200 req/min (they say these move) |
| Errors | 401, 422, 429, 529. Back off on 429/529. |
| Batching | Questions are independent and scored separately. 13 in one call measured 12.2x cheaper than 13 calls, because the state is sent once. |

**Pin `jev-1.13.0`, never `jev-latest`.** We calibrate thresholds against a
model's behaviour; an alias that shifts under us would move every gate silently.
Their own docs say to pin when calibrated.

## Why it fits this feature

The original argument for a model call was yours: hard rules miss the dirty ugly
data. But the rules we ended up writing are still hard thresholds with guessed
numbers, and the LLM we added is slow, costly per user, and scored 2/6 then 5/6
on the ugly weeks. Jev is built for exactly the middle piece we were faking.

Three things it gives us that we do not have:

1. **A probability instead of a boolean.** `food_logging_is_representative: 0.31`
   is a usable signal. `days_logged >= 9` is a guess with a cliff edge.
2. **Confidence that can route.** This is the mechanism for "discuss with the
   user before changing the plan" (section L2):
   - confident -> **act** card, propose the change
   - unsure -> **talk** card, ask the question first
   - lost -> hold, say nothing
   That is a tunable dial, not an if/else I hand-wrote.
3. **Screening every user is now free.** ~1k tokens of state per user is
   $0.000042. A thousand users a week is about four cents. So the weekly run can
   ask twenty questions about everyone, instead of the rules letting three
   through to an expensive LLM.

## The pipeline, after

```
  SQL facts (unchanged, cheap)
    -> Jev: ONE batched call per user, ~20 typed questions        decide + confidence
    -> deterministic gates that must not be probabilistic         tier, cooldown, floors
    -> confidence routes: act | talk | hold
    -> LLM (Sonnet): writes the sentence for the ONE winning card  words only
    -> Jev: verifies that sentence against the facts (noul)        cheap hallucination check
    -> validator: the same hard safety checks as today             final veto
    -> store
```

The LLM's job shrinks from "judge and write" to "write". That is the thing an
LLM is reliably good at, and it makes the eval stable: we score Jev's judgment
and the LLM's wording separately, each against its own bar.

## What must stay deterministic, forever

Jev is a better judge. It is not a safety net. These never move to a model:

- the calorie floor (Mifflin-St Jeor), the max 10% step, the direction check
- "the routine slot still holds what the card claims" before a swap applies
- Pro tier, the 14-day grace, the cooldown, one card per week
- the seven-day Undo window
- `plan_changes` recording every write

A model decides WHETHER to propose. Code decides whether a proposal is allowed
to land.

## What changes in what is already built

| Piece | Today | After |
|---|---|---|
| `dronaCalories.uglyChecks` | 4 hand-tuned thresholds | Jev questions give nuance; the 4 checks STAY as the veto |
| `dronaCalories.calorieGate` | booleans with cliff edges | Jev probabilities; tier/floor stay hard |
| `dronaCards.signalsFrom` | `'unknown'` when data is thin | a real probability, and thin data shows up as low confidence |
| `dronaModel` (Sonnet) | judges AND writes | writes only |
| `dronaSwap` | run length 3/4 | unchanged. Counting sessions is a fact, not a judgment. |
| `drona-cards` worker | rules -> LLM | facts -> Jev -> route -> LLM -> verify |
| `scripts/drona-eval` | 6 packs, model vs pipeline | + a Jev score per pack; runs in seconds, not minutes |

## Phases

**Phase 0. Prove it. (half a day, needs the key)**
A throwaway script: send one real user's fortnight as state, ask the six eval
packs' questions, print answers and confidences. Confirm the response shape
matches the docs, measure real latency and token count, confirm 422 on a bad
question. **Checkpoint: if the shapes or the calibration disappoint, we stop
here and keep what we have.** Nothing else starts until this passes.

**Phase 1. Jev as a second opinion, shipping nothing. (1 day)**
Wire Jev into the eval harness only. Run the six B1 packs through it. Compare
its judgment with the rules and with Sonnet. **Checkpoint: Jev must get all six
right, and be honest (low confidence) on the two it would be wrong about.**

**Phase 2. Jev screens, rules still decide. (1-2 days)**
The worker calls Jev and STORES the answers on the card row (`facts.jev`),
but the existing rules still choose the card. Nothing the user sees changes.
This gives us a week of real, logged disagreements between Jev and the rules
before we trust it. **Checkpoint: read those rows together.**

**Phase 3. Confidence routes. (2 days)**
Jev decides. Confidence picks act / talk / hold. The talk card gets built here,
because this is what needs it. Thresholds come from Phase 2's real data, not
from guesses.

**Phase 4. Fold in the rest. (ongoing)**
A1 drift on top of the talk card, calories both ways (section L1), then G1.

## Cost and risk

Cost is a rounding error: about four cents per thousand users per week for
screening, plus the one Sonnet call per card that actually ships.

The real risks:
- **A new dependency in the weekly path.** Mitigation: Jev failing means the
  rules decide, exactly as today. Never a blank week.
- **Calibration drift on a model upgrade.** Mitigation: pin `jev-1.13.0`, and
  the eval packs are the regression test.
- **Early access.** Rate limits "adjust dynamically". Mitigation: the worker
  already backs off, and a 429 falls back to the rules.
- **Trusting a probability too early.** Mitigation: Phase 2 exists precisely so
  we see a week of disagreements before Jev gets the wheel.

## Phase 0 results (2026-09-20, live API, `scripts/drona-jev/probe.mts` + `probe2.mts`)

Run on the six B1 eval weeks. jev-1.13.0, about 1,670 input tokens a call
(roughly $0.00007), 360-430 ms warm and 1.2-1.4 s on a cold first call.

**The docs were wrong in one place already:** a `choice` needs `criteria` (a map
of option -> meaning). The launch blog's `options: [...]` returns 422.

**Jev SEES sharply.** One yes/no per signal, scored against the raw fortnight:

| Signal | On the week that has it | On the other five |
|---|---|---|
| a far-over-target day | 98% | 9-13% |
| protein adequate | 4% (collapsed week) | 97-98% |
| the user undid a cut by hand | 96% | 3-4% |
| weight is flat | 53% (jumpy scale) | 83-86% |

**Jev does NOT decide well.** Asked "what should the coach do" it was right
where one signal dominates (protein 93%, high days 81%) and wrong where signals
must be combined: it saw the undone cut at 96% and still voted to cut again
(58%). Asked "which kind of card" it returned 10-20% confidence on everything.
Handing it its own findings first (probe 2) barely moved it: "lowering is sound"
came out 53-65% on the clean weeks and 46-47% on two weeks where it is wrong,
and "ask first" sat at 73-80% for all six. No separation, no use.

Why: questions are scored independently against the state. There is no step
where one answer informs another, so a judgment that needs three signals
weighed together is outside what it does.

**One wording lesson:** "a real trend can be read from the weigh-ins" scored 19%
on every week, the clean ones included. A flat scale has no trend, so the
question was ambiguous, not the model. Every Jev question is a tiny prompt and
needs its own check against known weeks before it is trusted.

### What this does to the design

Jev is the PERCEPTION layer, not the policy layer:

```
  facts -> Jev: "can we see X here?" for ~25 signals, one call     perception (replaces guessed thresholds)
        -> a POLICY TABLE in code: each card lists the signals it
           needs and the signals that veto it                      policy (readable, tested, no nesting)
        -> thin margins or an INTENT veto  -> talk card            routing
        -> LLM: sizes the number, writes the sentence              judgment + words
        -> validator                                               veto
```

The if/else we disliked was never the policy. It was the perception: 135% of
target, 1.2 kg of range, 9 days of 14. Those go. The policy stays a table a
person can read, because "who decided to change my plan, and why" must have an
answer that is not "a probability said so".

## What is needed to start

The API key, in two places, added by the owner (I do not handle keys):
- `.env.local` as `JEV_API_KEY=...` for the eval and the probes
- a Supabase secret of the same name for the edge function
