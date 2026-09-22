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

1. **Saved-meal rules** (server only)
   - Scenario 3 + 1A: whole-meal-only matching; `saved_suggestions` on the
     result for the chip.
   - Scenario 2: "not from saved meals" on a correction turn re-parses the
     original text without saved meals, in the same mode, replacing the card.
2. **Agent** (server): Jev `steps` label + probe, Sonnet loop, parallel tools,
   status SSE events, turn cap enforced in code, traces.
3. **App**: status lines, save-and-log card, saved-meal chip. Capability gate.
4. **Eval**: multi-step case set, via `claude -p` only.

## Open

- "Don't offer that saved meal again for the rest of this chat" after a
  rejection: not in step 1.
