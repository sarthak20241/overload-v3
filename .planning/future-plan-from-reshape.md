# Future plan: what to take from Reshape (reference app, 2026-10-31)

Source: the owner's 13-minute screen recording of Reshape (AI coach "Fio").
Trimmed cut and 30 key screens live in the session scratchpad (not in git).

## Shipped in this branch (for context)

- Phase 1 is built right after sign-up and kept as a DRAFT until Save
  (Reshape also does draft, then confirm, then "activated").
- Free users can talk the phase 1 draft through with Drona (8 turns).
- Next phase: Pro gets it built in the last 5 days; free gets told.
- Getting-started checklist on the dashboard (Reshape: "Today's Checklist 0/4").
- Vertical phase timeline that ends in the goal.
- "Log with Drona" row inside manual food search.
- Shorter AI mode lines. Guest mode closed to new people.

## Next, in order of value

### 1. Drona orb that stays with you (Reshape's lingering Fio)
- A small Drona orb on every main screen (bottom corner on question flows, in
  the header elsewhere). Tap opens a compact floating chat card over the
  current screen; expand goes full screen.
- The card knows which screen it sits on, so "how do I log weight?" answers
  with the place to tap (Reshape shows "Preparing feature instructions...").
- A red dot when Drona has something waiting (From Drona cards).

### 2. Memory you can see and edit (Reshape: "Personalize Fio")
- Profile > Drona > Memory: two switches, "Remember what I ask" and "Learn from
  chats", each with a list of saved facts that can be edited or deleted.
- Structured fields: allergies, diet, injuries, medical notes (we already store
  injury_notes and training_preferences; they have no UI yet).
- A custom instructions box ("metric units, short answers").
- An incognito chat that saves nothing.

### 3. Food logging
- "To review" row for a failed AI log, with Retry, instead of losing the text.
- After the first logged meal: offer a reminder for the next meal (one ask,
  honest copy, no fake stats).
- A floating log button with a pulsing hint "Log your first meal" that changes
  to "Log your next meal".
- Voice logging (Reshape's main path) and photo logging.
- User catalog in search: every food the user has logged (AI lines included,
  which today are NOT catalog rows) shows first in their search results.
  Needs a design talk first (see the cache notes in the chat).

### 4. Workouts
- Plan reveal: stat tiles (days, strength, cardio, exercises) and a front/back
  muscle map. Keep the day list visible, not hidden in a carousel (Reshape's
  weak spot).
- Weekly strip (Mon to Sun) with each day's session on the workout tab.
- "Replace" and "Customize" on today's session, plus a "Process in
  background" button on every slow AI job.

### 5. First-run shape
- Home that opens up step by step: new users see fewer tabs, more unlock as
  they log. Test against the current 5-tab bar before committing.
- Rate slider with a red "Not recommended" band (we have the slider; add the
  band).
- "Why do we ask this?" sheets on body questions.

## Do NOT copy

- Sign-in wall, phone number with marketing consent, and a hard paywall before
  the user sees any value.
- A plan that "starts next week".
- A save state that disagrees between chat and screen ("saved" in chat, Save
  button still on screen). Our draft store must be the single truth.
- Empty orb-only screens that are dead time.
