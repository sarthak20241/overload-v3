# Full-day logging + "Just log it" mode

Two features, one dependency: B was already built once and rejected because A
did not exist. Ship A first.

- **A. Full-day logging (plan item I8).** One message names several meals:
  "had 2 eggs for breakfast, dal chawal at lunch, oreos in snacks". Every item
  lands in the meal the user named. Low UI noise: the card only changes shape
  when the input actually spans meals.
- **B. "Just log it" (working name).** An opt-in mode. The user trusts Drona,
  types what they ate, hits send, can close the app. The server finishes the
  parse and writes the diary itself. Undo from the diary.

## Where things stand today (read from code, 2026-09-04)

- Meal type is per PARSE, not per item. `meal_type_from_text` is one value
  (parseMeal.ts:1009), the card has one Breakfast/Lunch/Dinner/Snacks chip row
  (ParsedMealCard.tsx:~370), and `logParsedMeal` takes one `meal_type`
  (dietData.ts:920). "breakfast was X, lunch was Y" collapses to one section.
  Plan I6 lists this as a known hole; I8 is the user's decision to fix it.
- The eval gate `audit-multi-meal-day` exists (cases.ts:857) but only asserts
  "2 items, one is egg". It cannot fail on the collapse. It has to.
- Logging is CLIENT-side only. The edge function never writes `meals` or
  `meal_entries`; nutrition.tsx calls `logParsedMeal` when the user taps Add.
- Closing the app during a stream now CANCELS the server's model calls
  (index.ts:1887, `cancel() { abort.abort() }`, from main's 25c1f8e). Correct
  for review mode, fatal for B: "type, send, close" guarantees nothing logs.
- `EdgeRuntime.waitUntil` is already the house idiom for "finish after the
  response" (index.ts:1571, parse_traces). B builds on it.
- `meals.client_id` has a unique index for idempotent retries (0047). B uses it.
- The first auto-log (2026-07-07) was rejected for exactly two reasons: items
  landed in one section with no way to place them, and an 8s auto-commit timer
  felt out of control. A fixes the first. B fixes the second by having NO
  timer: send is the commit, and the user chose that when they turned it on.

---

## A. Full-day logging

### Contract

Each item carries its own meal. Resolution order, in code, never in the prompt:

    item.meal ?? meal_type_from_text ?? meal_hint ?? mealForHour(local_hour)

`meal_type_from_text` stays as the whole-message value ("for lunch I had A and
B" names lunch once for both). `item.meal` is only set when the text ties a
meal to THAT item. The parser must never infer a meal from the food or the
clock for an item - that rule already exists for the meal-level field
(parseMeal.ts:2011) and now applies per item.

`parsed.meal_type` stays for compatibility and the card header: it becomes the
meal of the FIRST item (not a majority vote - deterministic and explainable).

### Server

1. Extract schema (both `extract_meal` and the Fast `estimate_meal` tool): add
   `meal: { type: ["string","null"], enum: [breakfast,lunch,dinner,snack,null] }`
   per item, nullable, NOT required. Strict mode is rejected on cost (I7), so
   nullable stays free. Description mirrors the meal-level one.
2. `ExtractedItem.meal?: MealType | null` -> carried through `ResolvedItem` ->
   `ParsedItem.meal_type: MealType` (required on output; resolved by the order
   above before the card ever sees it).
3. Decide prompt: one line - the meal each item was given is fixed; do not
   move items between meals. Decide already never touches meal placement.
4. Traces: `items[].meal_type` lands in parse_traces via the existing items
   jsonb. No schema change.
5. Input length: the 500 cap in index.ts is trace truncation, not an input
   limit. Check the client `maxLength` on the composer; a day's worth of food
   needs ~800. Raise it with the feature, not before.

### Client

6. `logParsedMeal`: group items by `meal_type`, `findOrCreateMeal` per group,
   one insert per group. `LoggedParseRef` becomes `{ meals: LoggedParseRef[] }`;
   `undoParsedMeal` walks all of them. The single-meal case is the same code
   with one group.
7. Card, single-meal (the common case): NO visual change. Chip row and
   "Add to Lunch" exactly as today.
8. Card, multi-meal (>=2 distinct meal types among items): the chip row is
   replaced by grouped sections, each with a small header "Breakfast · 2 items"
   and its rows beneath. One button: "Add to 3 meals". Tapping a section header
   opens the existing move idiom (dietData `moveEntry` already exists for
   logged rows; reuse its sheet) to re-home the whole group; the pencil on a
   row already opens edit, and edit gains a meal picker. Discard unchanged.
   This is the whole "no noise" rule: extra UI appears only when the input
   demanded it, and disappears when it does not.
9. The `mealTypePicked` override (nutrition.tsx:393) applies to single-meal
   cards only. On a multi-meal card the user places groups, not the card.
10. Collapsed strip summary: "4 items · 812 kcal → 3 meals".

### Gate

- `audit-multi-meal-day`: add `meal` to `ItemExpectation`; assert egg ->
  breakfast, dal -> lunch. Add two held-out cases: three meals in one message,
  and "for lunch I had A and B" (meal named once, applies to both). Run with
  `EVAL_VIA_CLI=1` at concurrency 6-8.
- On-device: three-meal message, verify three diary sections fill and Undo
  clears all three.

---

## B. "Just log it"

### Name

Candidates: "Just log it", "Hands-free", "Trust Drona", "Auto-add". Pick
"Just log it": coach voice, says what happens, no jargon. Sub-copy:
"Drona adds it straight to your diary. Close the app if you like. Undo from the
diary any time."

### What the user sees

- Toggle lives INSIDE the existing logging-mode sheet (ParseSpeedSheet, the zap
  chip) under the Quick/Thorough cards, as a switch row. One sheet answers
  "how does Drona log what I type". No new chrome on the composer.
- When ON: the send button icon changes from arrow-up to check. The composer
  placeholder reads "Tell Drona what you ate, it goes straight in". That is
  the only always-visible signal, and it is the honest one: send now commits.
- After send, the card is a one-line strip, not the review card:
  "Adding to Lunch…" -> "Added to Lunch · 412 kcal · Undo". Streaming rows
  still show underneath while the app is open (people like watching it fill),
  but there is no Add button and no chip row.
- If the user closes the app: nothing else needed from them. On next open the
  diary shows the entries with a quiet inline chip on each auto-added row,
  "Added by Drona · Undo", cleared on the next app launch.
- Safety valves, always on in this mode:
  - A DECLINED parse never logs. The strip shows Drona's line instead.
  - A line that trips `implausibleLine` (163 g protein in two lattes) does NOT
    auto-log. The whole meal falls back to the review card with the flag
    shown. Trust mode is for ordinary meals, not for the one the parser itself
    doubts.
  - Corrections (a follow-up while the just-logged meal is recent) EDIT the
    logged meal, they never add a second one. Phase B3.

### Server

1. Request gains `auto_log: boolean` and `client_id: uuid` (per send, generated
   on the client). Per-request, not a profile column: the client is
   authenticated and this is the user's own diary; a server-side preference
   would only add a second place for the mode to be wrong.
2. When `auto_log`:
   - The parse promise is wrapped in `EdgeRuntime.waitUntil` and the stream's
     `cancel()` does NOT abort it. Client gone = keep going. This is the
     opposite of review mode's rule and it is scoped to this flag only.
   - On a non-declined, non-flagged result, the server writes the diary:
     port `findOrCreateMeal` + `logParsedMeal` into the edge function using the
     USER-scoped client (RLS holds; nothing runs as admin). Group by
     `meal_type` (this is why A ships first). `logged_via: 'ai_auto'`.
     `meals.client_id = client_id` on every meal created for this request, so
     a retry of the same send is a no-op at the unique index.
   - The `done` event (if anyone is still listening) carries
     `logged: { meals: [{ meal_id, meal_type, entry_ids }] }` so the card can
     go straight to "Added".
   - The trace records `auto_logged: true|false` and the reason when false
     (declined / flagged / write error).
3. A write error after a successful parse must not be silent: it is recorded
   on the trace AND the response still returns the parsed meal so a connected
   client can fall back to the review card and Add by hand.

### Client

4. `lib/parseSpeed.ts` grows a sibling `lib/autoLog.ts` (same AsyncStorage
   idiom: absence = off). Sticky per device.
5. On send in auto mode: generate `client_id`, persist
   `{ client_id, text, sent_at }` to a small "pending auto-logs" list in
   AsyncStorage BEFORE the request goes out. Then send with `auto_log: true`.
6. On `done` with `logged`: remove from pending, show the strip.
7. On app foreground (AppState) and on nutrition screen mount: for each pending
   entry older than ~5s, query `meals` by `client_id`. Found -> remove from
   pending, refresh the day. Not found after 3 minutes -> the request died
   before the server took it (network drop on send); surface one line in the
   diary: "Drona didn't get: '2 eggs and...' · Retry", which re-sends with the
   SAME client_id. Never silently re-send: the user closed the app trusting it
   went through, so a miss must be visible.
8. Undo: the strip's Undo and the per-row "Added by Drona · Undo" chip both
   call `undoParsedMeal` with the refs from `logged` (or, after a cold start,
   from a `meals.client_id` lookup).
9. Mode toggle also flips the composer placeholder and send icon (item above).

### Phasing

- **B1 (server):** flag, detached parse, server-side diary write with
  client_id idempotency, `logged` in done, trace fields. Testable with curl
  and a Clerk JWT: send, kill the connection mid-stream, confirm rows landed.
- **B2 (client):** toggle in the sheet, send/placeholder state, strip, pending
  list + foreground reconcile, Undo chips. On-device: send, force-quit the app
  before the card fills, reopen, entries are there with the chip.
- **B3:** corrections against an auto-logged meal (server update instead of
  insert; client keeps the last auto-logged meal as `previousItems` for a
  window). Without this, "actually 3 eggs" in trust mode adds 3 more eggs.
- **B4 (optional):** push notification "Logged: 2 eggs, 412 kcal" via Expo
  push. Needs push-token registration, which does not exist yet. Not in v1;
  the diary chip on reopen is the v1 confirmation.

### Gate

- B1: eval cases run with `auto_log` asserting `logged` present and
  `meals.client_id` populated; declined and flagged cases assert `logged`
  absent. Second identical send with the same client_id creates zero rows.
- B2: the force-quit test above, on both platforms (Android edge-to-edge and
  the Portal sheet rules apply to the toggle sheet).

---

## Decisions needed

1. Mode name: "Just log it" (recommended) or "Hands-free".
2. Toggle placement: inside the logging-mode sheet (recommended) or a standalone
   control beside the send button.
3. Confirmation when logged while away: diary chip on reopen only (recommended,
   v1) or push notification now (adds push-token work before B ships).

## Not doing

- A profile-level `auto_log` column. Per-request flag is enough and is one
  fewer place to drift.
- Auto-logging a meal the parser flagged. Trust mode does not override the
  parser's own doubt.
- An auto-commit timer of any kind. That is what got the first version killed.
