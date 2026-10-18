# Drona cards read the weekly pick

Status: BUILT 2026-10-18 (owner said "build"). SQL live; `drona-cards` NOT deployed;
app change needs an OTA first. See "Built" at the end.

## Why

We built about 20 behaviours (`drona_behaviours`, `.planning/drona-behaviours.md`).
Drona judges each one per person per week. No user sees any of them. The weekly
card (`supabase/functions/drona-cards`) still uses the older P0 rules
(`_shared/dronaCards.ts decideCard`) and B1 (the model's calorie card).

This step makes the weekly card say what the behaviours found.

## What the weekly card does after this

The order for the weekly slot. The first step that gives a card wins.

1. **New user.** The "I am reading, not steering" notice. Same as today.
2. **Swap.** The permanent swap (C2/H1). Same as today: a habit the person
   already built is the most concrete thing Drona can say.
3. **The behaviour pick (new).** Last week's behaviours, best first, skipping:
   - `steer` rows (never a card, same as today)
   - `finding_maintenance` and `calories_off`: the calorie check-in owns them
     (its own slot). Without this skip, 3 people would get the same weigh-in ask twice.
   - a behaviour on cooldown (shown in the last 2 weeks, or 4 after "Skip")
   - a behaviour whose topic is muted that week (`topic:<x>` mutes)
4. **The old P0 rules** as the fallback (due session, weigh-in, log food), and
   they now obey the `topic:` mutes too. Today they ignore them.
5. Nothing. Most weeks.

**B1 is retired** from the weekly slot. The check-in now owns calories, and B1
has written 0 cards in the last 9 weeks. Its code stays; only the call goes.

**Meta.** When `not_hearing_drona` is there (two cards in a row went unanswered),
the pick is said as a notice with one "Got it" button: only what Drona saw, with
the ask cut off (a notice has no button to answer a question with). A card with
no such quiet form (the P0 asks) says nothing that week. (Changed 2026-10-18 from
"same words, no ask" after review: the words ended in questions.)

## The words

Fixed words per behaviour, filled from the behaviour's `detail`. No model call to
write the card. Numbers come from code, never from a model. The coach model
only speaks after the person taps "Talk it through".

Talk cards get a new action, `talk`. The button opens the Drona chat and sends
one opening line for the person, with the numbers in it, so the coach starts
from the same facts the card showed.

| Behaviour | Kind | Title (example from real data) | Body (example) | Button |
|---|---|---|---|---|
| `scale_untrusted` | request | Same scale, same mornings | Your readings swing about 15 kg. Weigh in after waking, on the same scale, and the trend gets honest. | Log a weigh-in |
| `logs_partial_days` | request | Log whole days, even rough ones | Your logged days average 417 kcal against an 1,800 target. Part days hide what you really eat. | Log food |
| `goals_unclear` | talk | Your goal and your program disagree | Your profile says hold at 72.5 kg. Your program is a cut to 69 kg. Tell me which one is right. | Talk it through |
| `drifting_away` | talk | Two quiet weeks | No sessions for two weeks. That happens. Tell me what got in the way and I will fit the plan around it. | Talk it through |
| `own_way` | talk | You train your own way | Most days you pick your own session. Calves and hamstrings got left out. Want a plan built around how you train? | Talk it through |
| `lift_stall` | talk | (one line per cause, below) | | Talk it through |
| `plan_too_big` | talk | The plan asks for 6, you do about 4 | Over 7 weeks you averaged 4.1 sessions. A 4-day plan you finish beats a 6-day plan you half do. | Talk it through |
| `exercise_skipped` | talk | You keep skipping Kelso shrugs | You skipped it 5 of 6 times. Want something you will do instead? | Talk it through |
| `topic_not_landing` | talk | I keep asking for weigh-ins | Two asks, no weigh-ins. Maybe it does not fit your week. Tell me, and I will stop asking or find another way. | Talk it through |
| `on_track` | notice | Right on plan | 6 of 6 sessions last week. Keep going. | Got it |

`lift_stall`, one body per cause (the cause is already in `detail`):

| Cause | Kind | Body |
|---|---|---|
| `real_plateau` | talk | {lift} has not moved in two weeks, and you are training enough. Time to change the stimulus. |
| `expected_on_cut` | notice | {lift} is holding while you cut. On a cut, holding strength is a win. |
| `recovery` | talk | {lift} has stalled, and your sleep has been short. Recovery is the likely cause. |
| `under_fuelled` | talk | {lift} has stalled, and protein has been short. Food is the first thing to fix. |
| `cant_tell` | request (log food) | {lift} has stalled. With part-day food logs I cannot tell why. Log whole days this week. |
| `inconsistent_training` | talk | {lift} has stalled, and sessions have been missed. Consistency first. |

Each card carries evidence chips (the numbers it rests on), like the cards today.
All words go through the same checks as today: no em dashes, coach voice.

## Data freshness

The Monday card must read the week that just ended. The daily rebuild may not
have reached the person yet. A new RPC, `get_drona_pick_facts(user, as_of)`,
rebuilds that person's facts first when last week's behaviours are older than
the week's end. This is the same pattern as `get_drona_energy_facts`.

## What changes where

| Part | Change | Ships by |
|---|---|---|
| SQL | `get_drona_pick_facts`: last week's behaviour rows, the mutes, recent cards | `apply_migration` |
| `_shared/dronaPick.ts` (new, pure) | choose the behaviour, skip rules, the words | edge deploy |
| `drona-cards/index.ts` | the new order above; B1 call removed | edge deploy |
| `_shared/dronaCards.ts` | the P0 fallback obeys `topic:` mutes | edge deploy |
| App: `DronaCardView`, `index.tsx`, From Drona | the `talk` action: "Talk it through" opens the chat with the opening line | OTA (JS only) |

**Ship order: app first.** An old app shows a `talk` card with an "Open" button
that does nothing. So: OTA, then deploy `drona-cards`.

## Proof before anything ships

- `_shared/dronaPick.test.ts`: every skip rule, every behaviour's words, the
  meta notice, the cooldown. Each test fails first with its line broken.
- A dry run on live data, read only: what each person would get next Monday.
  You check those cards before the deploy.
- The simulator: a talk card opens the chat with its opening line.

## What it would have shown (last 5 weeks, live data)

With the check-in's two behaviours skipped, the weekly pick was, per week:
`goals_unclear` 1-3 people, `drifting_away` 1, `lift_stall` 1, `topic_not_landing`
1-2, `plan_too_big` 1, `exercise_skipped` 1, `scale_untrusted` 1, `on_track` 1.
The cooldown spaces the repeats: `goals_unclear` fires for the same 3 people most
weeks, so they would see it every 2 weeks, or every 4 after "Skip".

## Not in this step

- The 4 word behaviours with Jev (life got in the way, trains but does not log,
  hurting, already asked for a change). They plug into the same pick later.
- The `drona-cards` cron. Cards still come only when the app opens.
- `weight_wrong_way` and `protein_short` mutes: no card reads those signals yet,
  so there is nothing to filter. The first card that reads one must obey them.

## Built (2026-10-18)

- `get_drona_pick_facts` live (migration `20261018114836_drona_pick_facts`).
  Service role only: anon is refused (42501). Same "rebuild first when today
  is not done" step as `get_drona_energy_facts`.
- `_shared/dronaPick.ts` + `dronaPick.test.ts` (19 tests). Each skip rule was
  broken on purpose and a test failed: check-in skip, steer skip, cooldown, the
  mute on what a card asks for, the meta notice, the priority order, the one-side
  goals detail, the "most skipped" choice, "twice", `hushed`.
- `hushed`: in a `not_hearing_drona` week the P0 fallback's card is a notice
  too (no ask), not only the pick's.
- `_shared/dronaCards.ts decideCard(facts, signals, muted)`: the P0 fallback
  skips muted topics (a new test; it fails with the check removed).
- `drona-cards/index.ts`: new user, swap, pick, P0. B1's call and its helper
  are gone from the worker; `dronaCalories.ts` and `dronaModel.ts` stay for the eval.
  The pick rows are saved in the card's `facts.pick`.
- App: `talk` action. The dashboard popup opens the coach chat on the card's
  opening line; From Drona leaves a `requestCoachOpen` and goes to the dashboard.
  "Talk it through" is the button.
- `scripts/drona-facts/pick-cards-dryrun.mts`: what each person would get, read only.

Dry run (cards each Monday would have shown):

| Card week | Pick | P0 |
|---|---|---|
| 2026-10-12 | goals_unclear 3, topic_not_landing 1 | weigh_in 1 |
| 2026-10-05 | topic_not_landing 2, lift_stall 1, goals_unclear 1, plan_too_big 1 | watching 1 |
| 2026-09-28 | goals_unclear 3, lift_stall 1, on_track 1 | watching 2 |

Ship order: OTA (the `talk` button) first, then deploy `drona-cards`.

## Simulator check (2026-10-18)

On the demo account (`user_3HKAcd0G...`, Pro), its week-of-12-Oct card was
turned into the real `goals_unclear` talk card the new code writes for it, then
restored exactly (facts md5 unchanged).

- The popup and From Drona both show it. "Talk it through" opens the coach chat
  and sends the opening line; the coach read the data and answered (it picked
  the cut, and pointed out 11 weeks with no sessions or weigh-ins).
- It found two bugs, both fixed: the popup has its own button-label list
  (`DronaCardPopup.primaryLabelFor`) and said "Open"; and the chips showed whole
  phrases in big type. Chips now hold short numbers only (a test checks every
  behaviour's chips stay 10 characters or less).

## Review fixes (claude[bot], PR #264)

- One cooldown across old and new cards: a pick ask waits after the same ask
  from an old P0 card (`weigh_in`, `log_food`, `due_session`), and the P0
  fallback skips a topic a pick card asked for lately (`askedLately`).
- A failed pick read says nothing that week. Without it, the mutes and the
  hush are unknown.
- Kept on purpose: B1's shared code (`dronaEnergy.ts` and the eval scripts
  still import `dronaCalories.ts`/`dronaModel.ts`); `facts.pick` on the card
  row (the audit of why that card was said); the rebuild in
  `get_drona_pick_facts` has no lock, the same as `get_drona_energy_facts`. In
  the worker the check-in runs first and sets `last_day_done`, so the pick read
  does not rebuild again.
- Second review: a test pins the P0 topics that `ASKS` maps to (`weigh_in`,
  `log_food`, `due_session`), and a behaviour with words but a too-thin detail
  now logs a `console.warn` when it is skipped. The advisory lock for the two
  fact reads is left for later: it is wasted work at worst, not wrong data.
- Third review: a failed pick read returns its own kind, `pick_failed`, and the
  cron summary counts it, so a read that keeps failing is visible. A test keeps
  `PICK_ASKS` in step with `WORDS` (every behaviour with words is checked).
  On the app path the pick read rarely rebuilds: the check-in read just before
  it has already done today's rebuild.
- Fourth review: a hushed card kept its question ("Tell me which one is
  right.") with no button to answer. Each card now carries a quiet body (what
  Drona saw, no ask); hushed uses it, and a card without one says nothing. A
  test checks every behaviour's hushed body for an ask.

