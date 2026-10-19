# Drona moments: cards the moment something happens

Status: BUILT 2026-10-19 (owner chose option 1, in the app). SQL live; server and app not shipped yet.

## Why

The owner's ask: "apart from the weekly cards, a proactive mechanism: as soon
as the app finds something a Drona card should say, prompt the user."

Today Drona speaks once a week. The weekly card reads a finished week, so
something that happened on Tuesday waits until next Monday. A good coach
speaks when it matters: the day you say your knee hurts, the morning after you
miss two sessions, the minute you hit a PR.

## What a "moment" is

A moment is a card about something that just happened. It is not about last week.
- **Its own card slot:** `moment`, next to `weekly` and `calories`.
- **The same card kinds and buttons:** request, notice, talk, act.
- **The same rules as the other cards:** cooldowns, mutes, the quiet week
  ("not hearing Drona"), and words beat numbers.

## The first moments (rules in code; Jev only where it reads words)

| Moment | When it is found | What Drona says (example) | Kind |
|---|---|---|---|
| **Pain** | right after the message or note that says it (the after-reply step already reads every message) | "Look after that knee. We can swap the moves that load it. If it is sharp or not getting better, get it checked." | talk |
| **Missed sessions** | the morning after the 2nd planned session in a row is missed | "Two sessions slipped. Want to move today's, or make this week lighter?" | talk |
| **A PR** | right after a workout with a new best | "New best on bench: 80 kg x 6. That is the work paying off." | notice |
| **Food far off plan** | the morning after the 3rd day running at 25% or more over or under target (whole days only) | "Three days well over your target. Want to look at what is driving it?" | talk |
| **A change you asked for** | the day after a plan change was asked for in chat and did not happen | "You asked to train 4 days. It has not changed yet. Want to sort it out now?" | talk |

The weekly card keeps the slower patterns: lift stalls, goals that disagree,
plan too big, and the calorie check-in.

## Not too much

A coach who talks all the time stops being heard.
- **At most 1 moment a day and 3 a week.** Pain does not count toward the cap.
- **No moment on the day the weekly card is still waiting,** except pain.
- **Each moment has its own cooldown,** like the weekly topics: 2 weeks, 4 after "Skip".
- **A moment nobody opened within 2 days expires.** It is about now, not later.

## How it reaches the person: you choose

**Option 1: in the app (recommended to start). App update by OTA, no new build.**
- The moment is made on the server as soon as it is found.
- **Found while the app is open:** it pops up at once (the app listens for new cards).
- **Found while the app is closed:** it pops up the next time they open it.
- **Downside:** someone who does not open the app does not hear it.

**Option 2: in the app AND as a phone notification.**
- Everything in option 1, plus a notification on the lock screen, for example "Drona: look after that knee".
- **Needs:**
  - a new app build (remote push needs an iOS permission that only a new binary can carry)
  - a place to store each phone's push address
  - sending through Expo's push service
  - a "Drona notifications" switch in settings
- **Downside:** a native build and store review, and more ways to annoy people.
  The caps above matter even more here.

My advice: build option 1 now, and watch how people respond to moments for a
few weeks. Then add push (option 2) with a native build, and only for the
moments that earned it: pain, and missed sessions.

## How it is built (option 1)

- **Detection:**
  - **Pain:** the after-reply memory step already reads every message. It also asks the existing word question "pain now", and on a yes makes the moment at once.
  - **PR:** checked when a workout is saved.
  - **Missed sessions, food, unanswered asks:** checked by the card worker's 15-minute timer, from the daily facts.
- **The card:** written by the same pick and words code as the weekly card (`_shared/dronaPick.ts`), with the same tests.
- **The app:** reads the `moment` slot alongside the other two. It listens for new cards while open, and shows a moment as a popup, after a waiting check-in and before the weekly card.
- **Proof:** unit tests per rule (each fails first), a dry run on live data (who would have got which moment over the last 4 weeks), and a simulator check of a moment popping up while the app is open.

## Built (2026-10-19)

- **SQL (live), `20261019161120_drona_moments`:**
  - the `moment` slot, with a `moment_day`; one card per week per slot stays for weekly and calories (now a partial unique index); one moment per person, day and topic
  - source `reply`
  - `drona_moment_asks`
  - `get_drona_moment_candidates` (one read for everyone): missed_sessions, food_off, asked_for_a_change, pr
- **`_shared/dronaMoments.ts`:**
  - `decideMoment`: priority, 1 a day, 3 a week, nothing while a weekly card made today is waiting, the 14/28-day cooldown on any slot, mutes, the quiet week
  - the words, and `momentRow`
  - `dronaMoments.test.ts`: 7 tests. 13 rules were each broken once, and a test failed every time.
- **`ai-coach`:** the after-reply step asks Jev "pain now", "where", "asks for a change" and "which" on the same call as the memory gate (`catchMemory` `extraQuestions`).
  - pain (chat only): a moment at once
  - an ask (chat only): a row in `drona_moment_asks`
- **`drona-cards`:** every 15-minute run makes moments after the weekly cards (`runMoments`). The summary reports `moments_made` and `moments_failed`.
- **App:**
  - `readMomentCard` (pending, not deferred, not expired)
  - on focus, and every 60 s while the dashboard is open
  - popup order: a waiting check-in, then a moment, then the weekly card
  - never over the coach chat
- **Words:** pain and asked-for-a-change reuse the weekly cards' words. Missed sessions, food off and PR are new. The PR card keeps `workout_id` in its payload, so the database never makes a second card for that workout.

### Dry run (`scripts/drona-facts/moments-dryrun.mts`, nothing written)

- **Now:** 4 people with something found. 2 PR moments; the other 2 are held because a weekly card made today is still waiting.
- **As of 13 Oct 04:00 UTC:** 4 (all PRs).
- **As of 16 Oct:** 5 (4 PRs, 1 missed sessions).

### Ship order

Server first is safe. The current app shows a moment only in From Drona, and does not pop it up. Then the OTA, so moments pop up.

