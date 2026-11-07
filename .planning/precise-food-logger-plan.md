# Precise food logger: design plan

Status: DRAFT v2 for the owner, 2026-11-06. Nothing here is built.
Scope: the Nutrition food box in **Precise mode only**. Quick mode is not part of this plan.

## 0. What "good" means

1. **Honest numbers.** Every line says how sure we are and why: your number, a label, your own past log, our catalog, a recipe we added up, or our best guess. A guess is allowed. It is the last option, and the card says it is a guess.
2. **Consistent.** The same food, said the same way, gets the same numbers every time.
3. **Never loses work.** A line leaves the card only when the user asks. An edit changes the line; it never adds a second copy. A card is never thrown away.
4. **Does what was asked.** A question gets an answer. A request gets done. Both in one message get both.
5. **Explainable.** "Why 150?" always has a real answer.

The user behaviours we must handle (learned from real logs):

| The user... | We do |
|---|---|
| gives full numbers ("161 kcal per their menu") | Use them. They beat every source. (Built: PR #223.) |
| gives one number ("about 150 cal", "30 g protein") | Keep that number. Fill the rest from the best source, or a guess. (Built: PR #223 partial fill.) |
| names a packaged product | Label from the web or our cache. |
| names a home dish or a non-branded food | Catalog row, or a recipe from its parts, or a guess as the last option. |
| corrects a line | Change that one line. No duplicate. |

## 1. What goes wrong today (from 30 days of traces, about 500 messages)

| Problem | Evidence |
|---|---|
| The chat reply step cannot act | 19 replies. "Save it as a meal" asked 6 times on Oct 22. "Bring back the card" 3 times on Nov 5. A false claim on Oct 8: "logging a casein shake for you now", and nothing was logged. |
| Corrections rebuild the whole card | 34 corrections. The model dropped lines in 22; code put them back. About 6 still lost lines ("where is rice and oil and onion", Nov 2). |
| A save card replaced the meal card | Nov 5 15:23. The lunch card was gone for good. |
| A recipe is stored as a rate | "60 g paneer" was read as 60 g of the whole dish at 95 kcal/100 g, so 57 kcal. |
| The recipe goes into the NAME | "Milky Mist low fat paneer sabji (20 g paneer, onion, oil)", "(65 g paneer, onion, tomato, little oil)", ... Each name is a new memory row: 6 rows for one dish, 95 to 317 kcal/100 g. |
| "manual" means 6 different things | 501 of about 1,000 AI lines in 30 days are saved as source "manual". The code stamps "manual" on: numbers the user typed (correct), lines the agent copied from the diary (`foodAgent.ts` 769), lines the agent changed (772), card lines kept through a correction (`parseMeal.ts` 429, 5903), lines from a saved meal (`savedMeals.ts` 169), and save-card lines (`lib/coachFoodCreate.ts` 214). Memory then serves the row with the same source. Memory trusts "manual" most (manual 4 > precise 3 > thorough 2 > fast 1). So a catalog row or a guess, copied once, becomes a top-trust fact. Example: "Cocoa, dry powder, unsweetened" is a catalog name, served as "manual". Soyabean sabji at 400 kcal/100 g got in the same way. |
| A saved meal match went to the wrong line | Nov 5 15:26, "we saved a meal for milky mist sabji please use that". Jev found the saved meal at 0.95. The parser offered it as a tap-to-use button on the **soyabean** line. It also marked the paneer line "untouched", so that line was never looked at again. |
| Steps see different context | The reply step saw the chat but no card. The parser saw the card but no chat on a first log. |
| The router is the boss | When Jev is wrong or unsure, the message goes to a box that cannot help. |

## 2. The shape

```
message (+ thread_id, + the app's copy of the open card and recent turns, with a version)
  |
  |-- first message of a thread?
  |      yes -> Jev: "is this a fully plain food log that asks nothing else?"   (~100 ms)
  |             in parallel: start the food pipeline (extract, search, decide)
  |             plain -> card from the pipeline. No agent.
  |             not plain -> agent (the pipeline result is waiting for it)
  |      no  -> agent
  |
  agent loop (Sonnet, max 5 turns, parallel tool calls)
  |   tools change the card ONE line at a time
  |   numbers come from tools, never typed by the agent
  |
  checks (code + Jev): no lost lines, no false claims, numbers add up
  |
  -> card + one reply line to the app; thread state saved
```

Removed: the chat reply step, the separate save step, and the router as the boss for later messages.

## 3. State: the app keeps it hot, the server keeps it safe

**The app already holds the open card and the recent turns in memory.** It sends them with each message, as it does today, plus a `version` number. That is the fast path: no database read.

**The server keeps the durable copy.** After each message it saves the turns and the card version. The server reads its own copy only when:
- the app's copy is missing (app restarted, phone memory cleared, another device), or
- the app's version is older than the server's, or
- the agent asks for something older (an earlier card, older turns).

**The version check (one rule, done by the database):**

1. Each card has a `version` number on the server. The app sends the version its copy started from (`base_version`).
2. The server uses the app's copy only when `base_version` equals the server's version. Otherwise it uses its own copy, works on that, and sends it back, so the app replaces its stale copy.
3. The save is one conditional write: "write version N+1 only if the current version is still N" (`update ... where card_id = $1 and version = $2`). If it changed in between (two devices, or a retry), nothing is written, and the server reloads and runs the message again once.
4. One message changes one card version. A retry of the same message (same `client_id`) does not make a second version.

Why not keep it in the server's memory: each food box message can start a new copy of the edge function (the logs show "booted" and "shutdown" around each message on Nov 5). Server memory does not live from one message to the next. The app's memory and the database do.

Tables (names are a first idea):

- `food_threads`: id, user_id, started_at, last_at, status (open / closed), summary (2 lines).
- `food_thread_turns`: thread_id, seq, role (user / drona), text, created_at. All turns.
- `food_cards`: id, thread_id, version, status (open / added / discarded / replaced), meal_type, day.
- `food_card_lines`: card_id, version, line_no, name, said_name, grams, quantity, unit, kcal, protein, carb, fat, fiber, source, source_ref, confidence, note.

A thread closes when its card is added, or after 30 minutes with no message (owner decision).

**Retention: 20 days** (owner decision, 2026-11-06). A daily job closes threads idle for more than 35 minutes (the app's 30 plus the server's 5-minute grace), then deletes closed threads whose last message is older than 20 days, with their turns, cards and card lines. An open thread is never deleted mid-use. Account deletion removes a user's threads at once. No summaries and no cold storage: lasting facts go to food memory when a card is added (step 4), and debugging uses `food_bar_traces` (30 days).

A save card no longer replaces the meal card. It is a second card in the same thread. The meal card stays.

## 4. Hot, warm and cold context

### Hot: always in the prompt (target 400 to 700 tokens)

```
<thread>
first_message: "i lunch i had 100g jeera rice and milky mist paneer sabji made of 60g paneer ..."
summary: Logging lunch. User says the sabji is 60 g low fat paneer + oil + onion, about 150 kcal.
open_card (lunch, Nov 5, v4):
  [L1] Jeera rice, 100 g, 171 kcal [your log, Oct 30]
  [L2] Milky Mist low fat paneer sabji, 1 serving, 150 kcal [your number]
  [L3] Soyabean sabji, 15 g, 18 kcal [catalog]
  [L4] Methi aloo, 20 g, 27 kcal [catalog]
last_turns: (the last 3, word for word)
matches (for this message, using today's cutoffs):
  saved meal "Milky Mist Low Fat Paneer Sabji": 1 serving, 150 kcal, P 11 C 4 F 10. Score 0.95. Saved Nov 5. Same food as card line [L2].
  your food "Jeera Rice": logged 6 times, usually 100 g, 171 kcal per 100 g (label). Score 0.92.
  maybe your food "Milky Mist low fat paneer": score 0.64 (check before using).
index: 2 earlier cards in this thread (save card v1, lunch v3). 12 saved meals. 41 foods you log. Diary: 30 days.
</thread>
```

The **matches** block is built by the code that exists today, at the same time as the rest. It holds only facts: what matched, how sure, the numbers, how often it is logged, and which card line it fits. It never holds an instruction. The agent puts it together with the user's own words.

It uses today's cutoffs, not new ones:
- **Your foods** (`user_food_cache`, `userFoodMemory.ts`): an exact alias skips Jev. Otherwise Jev scores "same food?". Live today: 0.75 serves. PR #314 (open) changes this to: 0.7 or more serves, 0.6 to 0.7 is "maybe" (decide checks it), and one Jev choice when the best score is 0.3 or more. The block follows whatever is live.
- **Saved meals**: 0.8 or more (`SAVED_MATCH_FLOOR`).
- Nothing over the cutoffs: the block is empty, and the agent can still call `list_saved_meals` or `recall_food`.

The **index** line says what exists, not what is in it. The tool list says how to get each thing. Same idea as `MEMORY.md`.

### Warm: one tool call away

| Data | Tool |
|---|---|
| Older turns of this thread | `read_thread(from_seq)` |
| Any earlier card or version | `get_card(card_id, version)`, `restore_card(card_id, version)` |
| Saved meals | `list_saved_meals(query)` (exists) |
| The diary | `read_diary(days_ago, meal)` (exists) |
| Your past numbers for one food | `recall_food(name)` (reads `user_food_cache`) |
| Earlier threads | `search_threads(query)` |

### Cold: code reads it, the model never does

Traces, token logs, old versions of food memory, diary older than 30 days.

### Hot or warm?

Needed in more than half of the calls: hot. Otherwise: a tool. PR #346 logs every tool call, so we decide by the numbers.

## 5. Where numbers come from

Two different numbers are on every line:

1. **The amount (grams).** Chosen by the model, from what the user said.
2. **The nutrition (kcal, protein, carb, fat).** Computed by code: the row's numbers per 100 g x grams / 100.

So "numbers come from code" means: once we have a row (catalog, label, cache, or your own past log), **code** turns grams into kcal. The model never types the kcal for a line that has a row. This is how decide works today: for a matched row it returns grams only, and the app computes the macros.

**How grams are chosen today (and stay):**

1. The user gave grams or ml ("100 g", "250 ml"): use them.
2. The user named a unit ("1 bottle", "1 scoop", "1 katori"): use the row's serving option for that unit. A label row often has one ("1 bottle (200 ml)"). Show it: "bottle (200 ml)".
3. No serving option fits: the model estimates one unit's weight for this food, says so ("Took a bottle as about 200 ml"), and the line is never "high" confidence.
4. No amount at all: one typical serving, said in the note.

Real traffic: decide reads "1 bottle" well when the label has a serving. "Took one Epigamia high protein milk as the 250 ml serving" and "Took the bottle as one 250 ml serving" (Provilac). It missed once: "epigamia turbo milkshake" became a 200 ml bottle, but the label says 250 ml.

**New: remember pack sizes.**
- When a label says "1 serving" and also gives the pack size (250 ml), save the pack size with the label in `precise_cache`.
- When the user adds a card where "1 bottle" was 250 ml, save "bottle = 250 ml" for that food in `user_food_cache`. Next time, "1 bottle" uses it with no guess.

**When the model writes nutrition itself:** only when no row fits (a guess, last option). Then the model writes all four macros, the line is marked as a guess, and code checks that kcal is close to 4 x protein + 4 x carb + 9 x fat.

**New: recipes.** A home dish with named parts ("60 g low fat paneer + oil + onion") is built from its parts. Each part gets a row and grams. Code adds them up. If a part has no amount (oil), the model assumes one from the dish, says so on the card, and asks once (see section 13). This turns many guesses into sums.

**Lookup order: personal first, web last (as today, keep it).**

1. **Your words for your foods.** An alias you confirmed ("paneer sabji" = your Milky Mist low fat paneer sabji) is an exact hit. No Jev call, no search.
2. **Your foods** (`user_food_cache`). You eat Milky Mist paneer sabji at lunch every day and type "that paneer sabji": Jev decides it is the same food, and your own numbers serve it. This is the personal layer: misspellings, short forms, your usual amounts.
3. **The shared label cache** (`precise_cache`), with your own aliases.
4. **Our catalog** (`foods`).
5. **The web**, only when nothing above was promising. Each web lookup costs money and seconds, so the steps above save both.

A new food that you never logged goes past steps 1 and 2 quickly and reaches the search. A food you log often stops at step 1 or 2. The plan keeps this order inside `log_foods`. The new parts (recipes, pack sizes, clear sources) make steps 1 and 2 more right, so more logs stop there.

**Source order** (a lower one never overwrites a higher one without the user's yes):
1. user typed it
2. label (web, Open Food Facts, FatSecret), with a link
3. your own past log of this food, from a card you added
4. our catalog
5. recipe sum
6. guess

## 6. Food memory: improve what exists, do not start over

What exists today:

| Table | What it is | Works well | Problem |
|---|---|---|---|
| `user_food_cache` | Each user's own foods: name, per-100 numbers, source, tier, aliases, brand, last log. Written by a database trigger AFTER the user adds a card. Read first on every log. | Matching: Jev decides "same food?" and code picks among matches by times logged, then trust, then newest. Eval: 46 of 60 right, 0 wrong. Aliases are learned from saved cards. | The recipe goes into the name (6 rows for one sabji). "manual" means 3 things. No history: a new number replaces the old one. A dish is stored as a rate only. |
| `precise_cache` (+ `precise_alias`) | Shared web label results for all users, with each user's own aliases. Good rows move into the catalog every day. | Saves paying for the same web lookup twice. | Not a problem for this plan. |
| Saved meals | Meals the user saved on purpose. | Jev found the saved sabji at 0.95 on Nov 5. | The parser path did not use that match. |

**Plan: change `user_food_cache`, keep the matching.**

1. **Split "manual" into clear sources:** `user_typed`, `label`, `catalog`, `recipe`, `guess`. Copying a line (from the diary, from memory, from a saved meal, or through a correction) **keeps the source it had**, and adds where it was copied from (`copied_from`). Only `user_typed` gets top trust. The 6 places that stamp "manual" today change to this.
2. **Add a `recipe` column** (parts with grams) and keep the name clean: "Milky Mist low fat paneer sabji". The 6 rows become 1 row.
3. **Add history:** a new number closes the old version (`valid_to`) and opens a new one. Nothing is overwritten.
4. **Use a match with the user's words.** If the user says "60 g paneer" and the memory row is a recipe, scale the paneer part, not the whole dish.
5. **Write rules stay where they are:** the trigger runs after the user adds a card. New rule: a `guess` never replaces a `user_typed` or `label` row; it waits as a lower version.
6. **Saved meal match:** when Jev finds a saved meal at 0.8 or more, it goes into the agent's hot context ("saved meal match: Milky Mist Low Fat Paneer Sabji, 0.95, 150 kcal"). The agent reads the user's words ("use that") next to the match, and calls `edit_line` on the right line. Code then copies the saved meal's numbers. Today the parser only shows the match as a button, it can pick the wrong line, and it cannot follow an instruction like "use that".

Migration of today's rows: today's `manual` cannot tell what the user typed from what was copied, so the migration never trusts that word alone.

1. **Recover the real source from evidence**, row by row:
   - `user_typed` only with proof: the line's trace has a `user_stated` / `user_stated_total` step, or its note starts "Your numbers", or the user changed the numbers by hand in the edit sheet (`loggedEntryEdit`).
   - `catalog`, `label` or `web`: the line has a food row id, or its trace shows that lookup.
   - Copied lines ("Same as you logged on ...", diary copies, saved meals, card lines kept through a correction): follow the copy back to the line it came from, and take that line's source.
2. **No proof: `unknown`.** It is trusted like a guess, below catalog. It is never promoted to `user_typed`.
3. Then the fixed rule picks the current row: newest `user_typed`, else highest trust, else newest.
4. The owner sees the list and approves it once. **End users are never asked.**

**Questions to end users:** at most 1 or 2 choices, with a default already applied. The card shows the default; the user taps only to change it.

## 7. The agent and its tools

Model: Sonnet. Max 6 turns (owner decision). All tool calls in one turn run in parallel. The last turn must finish: it can only reply or change the card.
Real traffic (59 agent runs): 15 used 1 turn, 31 used 2, 5 used 3, none used more. 3 failed with no tool call. 6 leaves room for the new tools (restore, recipe).

| Tool | What it does |
|---|---|
| `log_foods(text)` | Today's pipeline: extract, search (memory, cache, catalog, web), decide. Returns lines with sources. On the first message, its result is already running. |
| `find_label(product)` | Helper for one product's web label. Returns per-100, serving, link, confidence. Its search steps stay out of the agent's context. |
| `build_recipe(name, parts)` | Gets each part's row, adds them up in code. |
| `add_lines`, `edit_line(line_id, change)`, `remove_lines(line_ids)` | Change the open card one line at a time. `edit_line` changes that line only. |
| `restore_card(id, version)` | Brings back an earlier card. |
| `save_meal(from_card, lines, name)` | Saves a meal with all macros copied. |
| `recall_food`, `read_diary`, `list_saved_meals`, `read_thread`, `search_threads` | Warm reads. |
| `reply(text)` | The line shown to the user. Always last. |

**Card changes in one turn have a fixed order.** Reads and lookups in one turn run in parallel. Card changes do not:
- Every line has a stable `line_id` (shown in the hot context as `[L2]`, not a position). A removal never renumbers what another call points at.
- Code collects all card changes from the turn and applies them in one fixed order: edits, then removals, then additions, then a restore (a restore replaces the whole card, so it cannot share a turn with line changes: code rejects that mix and asks the agent to choose).
- Two changes to the same `line_id` in one turn are rejected with a message to the agent. Nothing is half-applied.

## 8. Pipeline on the first message (keep)

On the first message of a thread, the food pipeline starts at the same time as the Jev check. If the message is plain, its result is the card. If not, the agent gets the result the moment it asks. Later messages do not start it; the agent decides. We measure how often the early result is used.

## 9. What Jev does

1. **First-message gate:** "Is this a fully plain food log that asks for nothing else?" Plain goes straight to the pipeline. Anything else, or unsure, goes to the agent.
2. **Checks after the agent:** "Does the reply claim something that did not happen?" Code also checks that no line disappeared without `remove_lines`.
3. **Food memory matching:** as today.
4. **Saved meal matching:** as today, now passed to the agent.
5. **Grading evals.**

Not used: general hints for the agent.

## 9b. What we keep from today's design

The routes (log, edit, other, steps, continue, create) and their rules hold months of lessons from real traffic. The new design does not throw them away. Each lesson moves to a new home: a rule in the agent's instructions, a tool, a code check, or an eval case.

| Today | The lesson it holds | New home |
|---|---|---|
| **log** is the default and wins every tie | Losing a meal the user sat down to record is the worst outcome. | Agent rule: when in doubt, log the food and say what was assumed. Eval cases from real logs. |
| **create** needs an explicit ask (`INTENT_CRITERIA.create`) | Numbers and present tense are not a save request. A question about saving is not a save. "Could you keep X" is. | Agent rule for `save_meal`, with the same examples. |
| **create** floor 0.7, measured | "add my greek yogurt bowl" read as create at 64%. "u didn't even reply to me?" read as create at 0.50. | Eval cases. The checker flags a save card the user did not ask for. |
| **Bare ack** beside a card (`isBareAck`) | "ok", "cool", "looks good" read as create at 0.46 to 0.75. It means "the card is fine", not "save it". | Kept as code: a bare ack never starts a save or an edit. |
| **other**: questions get a spoken answer | Greetings, "how is it 240 kcal?", "am I eating enough protein" need words, not a card. | Agent `reply` tool. The agent can also act in the same turn. |
| **other**: the parser can veto | "lunch today was around 700 calories" read as other at 76%. Food in the message must still be logged. | Agent rule + eval case. |
| **No false claims** (`claimsAction`) | Oct 8: "logging a casein shake for you now", and nothing was logged. 8 of 8 false claims caught, 0 of 17 false alarms. | Kept as a code check on every agent reply. With the agent the claim is usually true, so the check also compares the claim with the tools that ran. |
| **steps**: look up earlier logs | "Copy lunch from yesterday", "same breakfast as Monday". The agent handled 10 of these in 30 days, each in 1 or 2 turns (each result not yet checked by hand). | `read_diary` + `add_lines`, unchanged. |
| **steps**: dates are code's job (`recentDays`) | Left to the model, "same lunch as Monday" read the wrong day 1 run in 3. | Kept in the hot context. |
| **continue**: answer to Drona's question | "the plain one", "150 grams", "use your estimate" finish the waiting meal. A waiting meal must survive a restart. | The open question lives in the thread state. The agent sees it in the hot context. |
| **continue**: "Choose any" failed (Oct 8 and 9) | The reply could not see the options it had offered. | The options are part of the open question in thread state, so the agent can pick. |
| **edit** goes to the agent beside a card | The agent can change one line. The parser rebuilds the card. | All later messages go to the agent. |
| **Correction guard** (puts dropped lines back) | The model dropped lines in 22 of 34 corrections. | Kept as a code check: no line leaves without `remove_lines`. |
| **Agent failed beside a card**: the card is served, not a canned line | The card is never lost to a bad agent turn. | Kept: if the agent fails, the card stays as it was. |
| **rejects_saved** ("not from my saved meal") | The real app sends no Drona turn naming the saved meal, so the words alone must be read. | Agent rule + eval case. |
| **User-stated numbers** (PR #223) | User numbers win over every source. Partial numbers keep the user's part. | Inside `log_foods` and `edit_line`, unchanged. |
| **Memory identity** (PR #235, #314) | Jev judges identity only. Times logged and recency are code's job, not Jev's. A misspelled brand needs respelling for Jev. | Kept inside the lookup order. |
| **research** ("look up the label") | Users ask for a label check after seeing a guess. | `find_label`. |
| **10 turns of 400 characters** | Corrections need the earlier words, not only the newest message (Navratri chana). | Replaced by the thread store: the first message and a summary are always hot. |

## 10. Region rules

- Country from the user's time zone, the same function the web search uses (`searchCountry.ts`).
- Region rules in the prompt only for that region. India: plain "tea" or "chai" is milk tea, plain "coffee" is milk coffee, katori and roti sizes, curated staples first.
- Examples come from the user's region, plus 1 or 2 from elsewhere.
- No region known: no defaults, and the assumption is said on the card.

## 11. Evals first

1. **Eval set** from real traces: about 60 cases. All the failures in section 1, plus normal logs, partial numbers, edits, saves, questions, and "bring it back".
2. Each case: the thread so far, the new message, and the right result (card lines, numbers in a range, what the reply must or must not claim).
3. **Metrics:** kcal error against the truth, lines kept, no duplicate lines, the right action done, false claims (must be 0), turns, time p50 / p95, cost per message.
4. Runs through the Claude CLI (`EVAL_VIA_CLI=1`). Time numbers only from API runs.
5. Every step must keep or improve the score before it ships.

## 12. Build order

Each step ships behind an on/off switch, shadow first where possible.

| Step | What | Fixes |
|---|---|---|
| 0 | Eval set + replay harness | Lets us measure everything |
| 1 | Thread store + card versions + `restore_card`; save card stops replacing the meal card | Lost cards, lost context |
| 2 | Agent for every later message, with `edit_line` / `remove_lines` / `save_meal` (built behind `FOOD_AGENT_LATER`, off; see the PR) | Dead-end replies, dropped lines, false claims |
| 3 | First-message Jev gate + agent for non-plain first messages | One path for everything that is not plain |
| 4 | Food memory: clear sources, `recipe` column, history, row clean-up | The 6-row problem, guesses with top trust |
| 5 | `build_recipe` + oil and other assumptions with one question | Home dishes |
| 6 | Region rules + mixed examples | Users outside India |

## 13. Owner decisions so far (2026-11-06)

- Precise mode only.
- Keep the first-message pipeline start.
- Jev as the first-message gate: "fully plain food log, asks nothing else".
- Thread closes when the card is added, or after 30 minutes idle.
- Threads are kept 20 days, then deleted (only closed ones). No summaries, no cold storage.
- A part with no amount (oil): assume one from the dish, show it, and ask once. Remember the answer in the recipe so it is not asked again.
- Agent turns: max 6.
- End users get at most 1 or 2 choices, with a default already applied. Memory clean-up is never asked of end users.
- Remember pack sizes ("bottle = 250 ml") per food.
- Keep the personal-first lookup order and today's memory cutoffs. The web is the last step.
- Keep the lessons of today's routes (section 9b). None are dropped without a replacement.

Still open:
1. Approve the memory clean-up rule in section 6, then the list of rows it picks.
2. How long can a non-plain first message take? The agent adds 2 to 4 seconds.
