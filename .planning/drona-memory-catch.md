# Drona remembers what people tell it

Status: BUILT 2026-10-19 (owner said "build"). SQL live. Not deployed: see "Built" at the end.

## Why

People tell Drona about themselves everywhere, including in the food box: "I'm
vegetarian now", "night shifts this month", "milk makes me bloated". A good
coach keeps that.

**Today Drona keeps nothing.** `coach_memory` has 0 rows, ever. The chat coach
has the `remember_fact` tool in every chat mode, with good instructions, and
uses its other tools often (about 60 data lookups since 19 Sep). In 613
requests it called `remember_fact` 0 times. Leaving it to the coach to decide,
in the middle of answering, does not work. The food logger has no memory tool at all.

Owner's ask (2026-10-18): one daily sweep, plus the remember tool in chat and in
food logging, used AFTER the request is served (serving it comes first), so
anything important is saved right away.

## The design

### 1. A memory pass after every reply (chat and food logging)

After the reply is sent (`keepAlive`, the same way traces are written now), so
it never slows or changes the reply:

1. **Jev asks one yes/no about the person's message:** "Does this tell something
   lasting about the writer?"
   - Yes: a preference or dislike, a diet rule or a food they avoid, an allergy
     or intolerance, an injury or health condition, equipment or where they
     train, their schedule, job or life situation, why they have their goal, or
     a decision.
   - No: what they ate or did just now, food amounts, a one-off state (today's
     soreness, mood, hunger), a question, a request to the coach.
   - A yes needs 0.75 or more, the same line as the word behaviours.
2. **Only on a yes, Drona writes the fact** with the same `remember_fact` tool.
   This is one small model call (Haiku 5.5), with the person's current memory in
   front of it, so it updates a fact instead of making a second one. It saves 0
   to 3 facts.

- **Chat:** the pass is skipped when the coach already saved something in that
  turn. The in-chat tool stays.
- **Food logging:** every path runs the pass: Quick, Balanced, Precise and the
  food agent. Most food texts are just food, so Jev says no and that costs about
  $0.0001.
- **Facts are labelled by where they came from:** `food_log` or `chat`.

### 2. One daily sweep

Once a day, per person, the same two steps run over yesterday's words that no
pass has read yet:
- workout notes, exercise notes, meal notes and sticky notes
- any message whose pass failed

### 3. Bookkeeping

- A new table, `coach_memory_seen` (person, text id, when, outcome), so no text
  is read twice and the sweep knows what is left.
- New memory sources `food_log` and `sweep` (the table and the save function
  allow them).
- A save function the sweep can call on the server for a given person
  (service role only). The chat one works only for the signed-in person.

### What it will not save

- What the app already tracks: lifts, weight, food logs, phases, readiness.
- One-off states.
- Anything said about someone else.
- The writer is told this, and the same rules as the chat coach's memory apply.

## Cost

- **Jev:** about $0.0001 per message or note.
- **The writer:** about $0.001, only on a yes. At today's volume (about 100
  real messages and notes a week, plus food logs) that is well under $1 a month.

## Proof before it ships

1. **A gate eval with Jev, made-up texts only, 40 to tune and 20 held back.**
   Hard cases: "2 eggs and toast" (no), "I'm vegetarian, so paneer" (yes, diet),
   "sore today" (no), "allergic to peanuts" (yes), "night shift this week" (yes,
   schedule). Bar: 18 of 20 held back. Costs under one cent.
2. **A writer check on the same texts:** right category, a short stable key, one
   sentence, and nothing saved on a no. The writer calls a tool, and the Claude
   CLI cannot test tool calls. So this uses the API: about 30 calls, about $0.05.
3. **Unit tests for the code parts**, each failing first.
4. **A dry run on live data that writes nothing:** how many facts would be saved,
   by category. Your own account's facts are shown in full; others only as counts.

## Ship

- **Database changes:** applied via MCP.
- **Server:** `ai-coach` gets the after-reply pass. Before deploying it I compare
  the live version with git, because it has drifted before.
- **The daily sweep needs a daily trigger.** This is a pg_cron job calling the
  function with a secret, and it needs the same 2 settings rows the card cron
  is waiting for (`private.runtime_config`). You add those, because I do not
  handle secrets. Until then, the after-reply pass works on its own.
- **No app update.** People cannot see their memory yet. A visible "Drona
  noted: vegetarian" line, with a way to undo it, is a later step.

## Built (2026-10-19)

- **SQL (live):**
  - `20261019053659_drona_memory_catch`:
    - sources `food_log` and `sweep`
    - `coach_remember_fact_for` (service role)
    - `coach_memory_seen`
    - `get_drona_memory_unseen`
    - the sweep cron, which is NOT scheduled: it needs the 2 runtime_config rows
  - `20261019053812_drona_memory_mark_seen`: counts tries, and never downgrades a read text to failed
- **`_shared/dronaMemory.ts`:** the Jev gate, the writer (Haiku 5.5, the `remember_fact` tool, current memory shown) and `catchMemory`.
- **`dronaMemory.test.ts`:** 7 tests. 9 rules were each broken once, and a test failed every time.
- **`ai-coach`:** `recordTrace` now returns the trace id and runs the catch after every successful chat or food-log reply, in `keepAlive`.
  - It never delays the reply.
  - It is skipped when the coach already called `remember_fact` that turn.
  - Turn it off with `MEMORY_CATCH=off`.
- **`drona-cards`:** a `memory_sweep` mode, behind the same cron secret.
  - It reads the last 3 days of unread texts.
  - It keeps each person's texts in order.
  - It stops starting new texts after 45 s.

**The gate line is 0.5, not 0.75.** On the tuning set every "no" scored 0.16 or less, and every real fact 0.65 or more. The gate only saves money; the writer still decides.

### Eval (`scripts/drona-memory/eval.mts`, made-up texts, live Jev and live writer)

| Set | Result |
|---|---|
| tune (40), gate only, at 0.75 | 37 of 40 (3 real facts at 0.65 to 0.71) |
| tune (40), gate at 0.5 plus writer | 39 of 40, no fact saved from a "no" text (a peanut allergy filed under constraint; then a category guide was added) |
| held (20), run once | 20 of 20, no fact saved from a "no" text |

### Dry run on live data (`scripts/drona-memory/dryrun.mts`, nothing written)

- **3 days:** 90 texts (88 food logs, 2 chats). 0 facts.
- **3 weeks:** 300 texts (273 food logs, 23 chats, 4 sticky notes). 1 fact (category other).
- People rarely tell Drona lasting facts yet, and food logs are almost never one. It stays quiet on them.

### Ship

- **The live pass needs `ai-coach` deployed.** Main also holds #266 (another session's food change, merged, not deployed: live `ai-coach` is v215 = `b9a9e8f`). Deploying the coach ships #266 too. That is the owner's call.
- **The sweep needs `drona-cards` deployed,** plus the 2 runtime_config rows. Then re-run the DO block in `20261019053659`.

