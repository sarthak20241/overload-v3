# Drona's word behaviours

Status: BUILT 2026-10-18 (owner said "build"). SQL live; `drona-cards` NOT deployed.
No app change: the cards use kinds the app already shows. See "Built" at the end.

## Why

Every behaviour so far counts things: sessions, weigh-ins, food days. People
also TELL Drona things, in chat and in notes. Rule from the start: words beat
numbers. If someone wrote "travelling all week", a "Two quiet weeks" card is
the wrong thing to say.

Four behaviours read the words:

| Behaviour | Drona noticed | Example of what they wrote |
|---|---|---|
| `hurting` | pain or an injury, now | "left knee hurts on squats" |
| `life_got_in_the_way` | training dropped, and they said why | "travelling till Sunday" |
| `trains_not_logging` | they said they trained on a day with no session logged | "did legs today" |
| `asked_for_a_change` | they asked for a plan change, and nothing changed after | "can we make it 4 days a week" |

## The data (live, last 8 weeks)

- 697 texts from 14 people. Almost all are chat (about 100 a week from 4 to 7
  people). Notes are rare: about 1 a week.
- Rough keyword counts (not Jev, just to size it): change asks about 52 texts
  from 5 people; life reasons about 7 texts from 3 people; pain 1; "trained" 1.
- So `asked_for_a_change` will fire most. The other three will be rare, but
  they are the most personal cards Drona can say.
- Food logging in the Nutrition box is already left out (the word facts skip
  that chat mode). The server keeps only the first 200 characters of a chat message.
- 12 plan changes came from chat in 8 weeks (1 person); about 180 were made by
  hand. Either counts as "the change happened".

## Who decides what

Arithmetic in code, judgment in Jev (the house rule, `.planning/drona-jev-plan.md`).

**Code picks the texts** for the week just ended (`drona_word_facts`):
- chat messages, workout notes, exercise notes, meal notes, and sticky notes
  edited that week
- not repeats, not texts under 3 characters, at most the 20 newest
- not the opening lines our own talk cards send (an exact match to a card's
  `payload.prompt`). Otherwise Drona would read its own words back as theirs.

**Jev answers one yes/no question per text, per topic, in ONE call** (questions
named per text, so each answer is tied to a text and its day):

| Question | Yes when | No when |
|---|---|---|
| pain now | they say something hurts or is injured now | normal soreness after training, an old healed injury, someone else's pain |
| where (choice) | knee, shoulder, back, elbow or wrist, hip, ankle or foot, neck, other | |
| life reason | they give a life reason for missing training or logging: travel, illness, work or study, family or an event | a plan to train, a complaint about the plan |
| which reason (choice) | travel, illness, work_or_study, family_or_event, other | |
| trained | they say they trained or worked out that day | a plan ("will train tomorrow"), a question about training |
| asks for a change | they ask Drona to change their plan or targets, or ask whether they should | a question about how to do an exercise |
| what change (choice) | training_days, exercises, goal_or_weight, calories, other | |

A yes counts only at 0.75 or more; 0.25 to 0.75 is "not sure" and counts as
no. (Near 0.5 Jev is a coin flip.) The eval below sets the final line.

**Code decides the behaviour:**

| Behaviour | Fires when |
|---|---|
| `hurting` | any text is "pain now" |
| `life_got_in_the_way` | any text gives a life reason, AND sessions were under half the plan that week |
| `trains_not_logging` | a "trained" text sits on a day with no session logged (`drona_day_facts`) |
| `asked_for_a_change` | an "asks for a change" text, and no plan change (any source, the matching kind) from that day to the end of the week |

The answers are stored in a new table, `drona_word_signals` (one row per
person, week and signal, with the score and the text's day; service role only).
The card worker reuses them, so Jev is asked once per person per week. A person
who wrote nothing costs nothing. About $0.0001 and 0.5 s per person-week.

## The cards

Fixed words, numbers and names from code, same as the other behaviours. Talk
cards open the chat on an opening line.

| Behaviour | Priority | Kind | Title | Body |
|---|---|---|---|---|
| `hurting` | 5, before everything, new users too | talk | Look after that knee | You mentioned knee pain. We can work out which moves to swap or ease off until it settles. If it is sharp, swelling, or not getting better, get it checked by a professional. |
| `asked_for_a_change` | 15 | talk | You asked for a change | You asked to change your training days. Your plan has not changed yet. Want to sort it out now? |
| `life_got_in_the_way` | 18 | talk, or notice for illness | (by reason, below) | |
| `trains_not_logging` | 19 | notice | Log the sessions you do | You said you trained on Tuesday, but no session is logged that day. Logged sessions are how I see your progress. |

`life_got_in_the_way`, by reason:

| Reason | Kind | Title | Body |
|---|---|---|---|
| travel | talk | Training on the road | You mentioned travelling. Want a short plan you can do anywhere until you are back? |
| illness | notice | Get well first | You mentioned being unwell. Rest first. When you feel better, we will ease back in. |
| work_or_study | talk | A busy stretch | You mentioned a busy stretch. Want a lighter plan until it eases? |
| family_or_event / other | talk | Life comes first | Sounds like life got in the way. Want a lighter plan for now? |

Opening lines, for example: "I mentioned knee pain. Which exercises should I
swap or ease off until it settles?" and "I asked to change my training days and
it has not happened yet. Can we do it now?"

**What they quiet that week** (mutes, so two cards never argue):
- `hurting`: the stuck-lift, plan-too-big and skipped-exercise cards, and any
  "your plan is waiting" ask
- `life_got_in_the_way`: "Two quiet weeks", plan too big, "your plan is waiting"
- `trains_not_logging`: "Two quiet weeks", "your plan is waiting"
- `asked_for_a_change`: plan too big (when the ask was about days), goals
  unclear (when it was about the goal)

All follow the usual cooldown (2 weeks, 4 after "Skip") and the quiet week rule
(a hushed week says only what Drona saw).

## Where it runs

In the card worker, before the pick, for the week just ended: read the texts,
ask Jev (or reuse stored answers), write `drona_word_signals`, then the word
behaviours join the pick with the priorities above. If Jev fails, the numbers
cards still run as today, and the failure is counted in the cron summary.

## Proof before it ships

1. **An eval first, held out.** About 60 made-up texts (none copied from real
   users), each labelled for the four questions, including the hard ones:
   soreness after legs day (not pain), "my knee used to hurt" (not now), "will
   train tomorrow" (not trained), "how do I do a Romanian deadlift" (not a
   change). 40 to tune, 20 never looked at until the end. Bar: 18 of 20 on the
   held-out set, and no false "pain now". It calls the live Jev API: about 60
   calls, under one cent in total.
2. Unit tests for the code rules (days, plan changes, mutes, words), each
   failing first with its line broken.
3. A dry run on live data, read only: which behaviour each person would get.
   Shown to you as counts and the card each person would see, without quoting
   anyone's messages.

## Not in this step

- Long messages: the server keeps 200 characters, so a reason at the end of a
  long message can be missed.
- Prompts the app writes for people (the insight chips, "Walk me through my
  session") also land as chat. The card opening lines are excluded; the others
  are not, yet. They rarely mention pain, travel or plan changes.
- The profile's injury notes are long-term and are left out; this is about new pain.

## Built (2026-10-18)

- SQL, live: `drona_word_signals` (service role only; anon refused, 42501) and
  `get_drona_word_facts` (`20261018154739_drona_word_signals`), then
  `20261018155554_drona_word_facts_no_food`.
- **Food logs are not words.** The dry run found most stored "chat" is meals
  typed into the Nutrition box (their request called a food tool: about 400 of
  700 messages). The facts read leaves those out. (The word facts themselves
  still count them, so `wd_chat_messages` and `drifting_away`'s "said nothing"
  read food logging as talking. Not fixed here.)
- `_shared/dronaWords.ts` (texts, questions, readings, signals, behaviour rows)
  + `dronaWords.test.ts` (9 tests; 12 rules each broken once, a test failed every time).
- The four cards' words in `_shared/dronaPick.ts`, with quiet bodies; 2 new tests.
- `drona-cards`: the word step runs for everyone (new users too), stores its
  answers, and joins the pick. Pain comes first, before the swap and the
  new-user notice. Jev failures are counted as `words_failed` in the cron
  summary; the numbers cards still run. Reuses `ai-coach/jev.ts`.
- One rule found by the held-out eval: "trained" also reads soreness the
  morning after, so a session logged the day before answers it.

### Eval (`scripts/drona-words/eval.mts`, live Jev, made-up texts)

| Set | Result |
|---|---|
| tune (40) | 36 first; 40 twice after the pain/life/trained wording; 39 after the "lasting change" wording (one pain score at 0.74, a question not changed) |
| held (20), run once | 18 of 20, no false pain (both misses: soreness read as "trained", now handled in code) |
| held2 (10), written after the "lasting change" wording, run once | 10 of 10, no false pain |

### Dry run (`scripts/drona-facts/words-dryrun.mts`, live data, nothing written)

Four past Mondays, 4 to 7 people with words each week, 0 to 16 real texts each
(after food logs are left out). Only `asked_for_a_change` fired: twice in four
weeks. One is a known miss: "what should I do next session, with a sore
shoulder" read as a plan change (0.81). No pain, life or unlogged-training
signals in these weeks.

Ship: server only (merge + deploy `drona-cards`). No OTA needed.

### Review fixes (claude[bot], PR #265)

- **A failed word step no longer locks in a numbers card.** The weekly card is
  written once and cannot be replaced, so on Monday and Tuesday a Jev or facts
  failure holds the card (`words_failed`); the cron retries every 15 minutes
  and the app on its next launch. From Wednesday the numbers speak alone, so a
  long Jev outage cannot silence the week.
- Jev calls per person are capped at 5 in flight (the cron already runs 4
  people at once).
- Kept: the word step runs before the swap (pain outranks it), costing one Jev
  pass for swap users too; `hurting` repeats only after the usual cooldown
  (2 weeks, 4 after "Skip") and only from the week just ended. Both migrations
  were already live, so they stay two. `coach_traces.tool_calls` is `text[]`
  (checked live), so `&&` is right. Jev already reads food text in the coach;
  `JEV_API_KEY` is a project secret, shared by every function.
- Second review: a failed Jev text gets one more try before the week fails; a
  held card is listed in the cron `failures` (so it alerts), not only counted.
  `hurting` is cancelled by a LATER text that says the same place is fine now
  (an unplaced "fine" does not cancel). `painFirst` (pure, tested) picks the
  pain card before the swap and the new-user notice. The worker never runs the
  word step when this week's card exists (`runApp` checks first), so app opens
  do not repeat the Jev spend.

