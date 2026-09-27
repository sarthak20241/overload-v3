# Food agent plan (Nutrition box, multi-step)

Decided 2026-09-22 with the user.

## Goal

The "Tell Drona what you ate" box handles messages that need more than one
step, in every mode (Fast / Thorough / Precise):

> "save yesterday's oat meal from breakfast as a meal, and log it at lunch today"

Simple messages (a plain log, a plain save, a plain question) keep today's
fast path and today's latency.

## Decisions

- **1A** A bare food that is only PART of a saved meal ("oats", saved "Oats with
  milk") is searched as normal. The card offers a one-tap chip "Use your saved
  Oats with milk?". A saved meal is used only when the words mean the whole meal
  (its name, a dish name for it such as "oat meal", "my usual breakfast").
- **2A** Save + log is ONE card, ONE tap ("Save as Oat meal, and log to lunch").
- Jev gets a 4th label, `steps`, defined in words (what / not_for / examples)
  like the others. Only `steps` goes to the agent.
- The agent is **Sonnet** (same constant as Drona chat). It never produces a
  nutrition number.
- Numbers: `parse_food` runs the normal parser (Haiku, user's mode). Diary and
  saved-meal rows are copied as they are, never re-estimated.
- No written plan. Each turn Sonnet asks for every tool it needs NOW; we run
  them in parallel; it sees all results and picks the next move.
- Max 5 turns. Turn 5 says "last step" in the prompt AND the code offers only
  the finish tools on that turn.
- Every tool call streams a status line ("Checking yesterday's breakfast").
- Saving needs the user's tap. Logging follows today's auto-log rule.
- Old app builds: gated by `supports: ['food_agent']`; without it, today's path.

## Tools

| tool | kind | notes |
|---|---|---|
| read_diary(days_ago, meal?) | read | from PR #193 |
| list_saved_meals() | read | rows included |
| parse_food(text) | read | runParseMeal in the user's mode |
| propose_meal(name, items, log_to?) | finish | save card, optional log in the same tap |
| log_food(items, meal, days_ago?) | finish | normal log card / auto-log |
| reply(text) | finish | spoken answer |
| ask_user(question) | finish | clarification |

## Steps

1. **Saved-meal rules** (server only). DONE, PR #196, ai-coach v175.
   - Scenario 3 + 1A: whole-meal-only matching; `saved_suggestions` on the
     result for the chip.
   - Scenario 2: "not from saved meals" on a correction turn re-parses the
     original text without saved meals, in the same mode, replacing the card.
2. **Agent** (server): Jev `steps` label + probe, Sonnet loop, parallel tools,
   status SSE events, turn cap enforced in code, traces. BUILT.
   - Jev: HELD_OUT_4 13/13, steps answers at 95-100%. Floor 0.6. Unsure steps
     with no food = reply (questions about earlier food sat at 49-57%).
   - Agent probe (`npx tsx scripts/food-agent/probe.mts`, Sonnet via claude -p):
     6/6, then 4/4 of the runs the CLI completed. Every case took 2 turns.
   - Gated on `food_create` (builds that draw save cards). Status events are
     ignored by builds that do not know them, so no new capability was needed.
   - No log to past days yet: log_food writes today only.
3. **App**: status lines, saved-meal offer, "saved meal" label, Quick tier on
   follow-ups. DONE, PR #200, verified on the iOS simulator. The save-and-log
   card needed no change (existing create card with log_now). Status lines show
   on Quick only: Thorough/Precise use the JSON path, which has no stream.
   Also shipped from device testing: #199 ('not from saved meals' caught in
   code, no 'Logged.' before a tap).
4. **Eval**: multi-step case set, via `claude -p` only.

## Open

- "Don't offer that saved meal again for the rest of this chat" after a
  rejection: not in step 1.
