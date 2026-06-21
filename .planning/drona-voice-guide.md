# Coach Drona — Voice Guide

The spine of the "one story, one narrator" workstream. Every user-facing string the user reads as
*words* (not pure data) should sound like one person: Coach Drona. This is that person.

## Who Drona is

Your coach. A calm, seasoned mentor (named for Dronacharya, the master teacher) who has trained a
thousand lifters and believes in this one. He notices your numbers, remembers last time, and nudges
you to the next level without drama. He talks like a great strength coach standing next to you at the
rack, not like an app. Economical: he says the right short thing at the right moment, then lets you
work.

## The one story

**You overload a little more each session, and Drona is the one who notices and pushes you.**
You are the trainee hero. Drona is the mentor. Every line should ladder into that.

## The 5 rules

1. **Second person, always.** "You hit 47.5 for 8." Never "User logged 47.5kg." Talk *to* the
   trainee, never *about* them.
2. **Warm and direct, never clinical.** "Catch your breath, set 3's coming," not "Rest timer active."
   Short beats long.
3. **Notice and remember.** Reference last time, PRs, streaks. "Plus 2.5 on last week." A coach who
   remembers is a coach you trust.
4. **Earn every word, then be quiet.** No constant chatter, no filler. Silence is a valid state. One
   good line lands harder than three.
5. **Never the system voice.** No "Error", "Invalid input", "No data". No em dashes (reads as AI).
   Sentence case, not ALL-CAPS (except tiny scoped urgent micro-states). Numbers stay human:
   "47.5kg × 8", "Last time: 60 × 8".

## Where the voice goes (and where it doesn't)

Drona speaks in the **connective tissue**: empty states, prompts, moments (commit / rest / PR /
finish), coach surfaces, confirmations. He does **not** rewrite pure data labels. Column headers
(`SET`, `KG`, `REPS`), unit tags, and raw numbers stay terse and silent. A chatty column header is
worse than a clinical one. The reference tone already in the app is the rest line
("Recovering before set 3"). Match that everywhere.

## Before / after

| Spot | Before | After (Drona) |
|---|---|---|
| History empty | "No workouts logged yet" | "Your first session goes here. Let's start one." |
| Previous set | "Previous: 60kg × 8 reps" | "Last time: 60 × 8." |
| Save as routine | "Save as routine?" | "Want to run this again? I'll keep it in your routines." |
| Notes placeholder | "Exercise notes..." | "How did that feel? Jot it down." |
| Coach loading | "Coach Drona is designing your plan" | "Give me a second, I'm building your plan." |
| Weight prompt | "Weight" | "What's your weight today?" |
| No exercises yet | "Add an exercise to get started" | "Pick your first move and let's get to work." |

## The logging beats (workout screen)

These are the canonical five Drona lines for the set lifecycle. Keep them this tight.

- **Arrive:** "Set 2 of 3. You hit 47.5 for 8 last time. Let's stand it back up."
- **Dial in (optional nudge):** "That's plus 2.5 on last week. Right where I want you."
- **Commit:** "Logged. Banked."
- **Rest:** "Catch your breath. Ninety seconds, then set 3 asks for one more."
- **Overload (PR):** "New best. That's the overload."
- **Finish:** "Three solid sets. That's the work. See you next session."

Note: lines that interpolate live data (set number, weights, rest seconds) must read naturally for
every value, including 1 ("Set 1 of 3"), missing history ("First time on this one. Find a weight you
own."), and singulars ("one more rep", not "1 more reps").
