# Drona Cards Plan (act / request / talk)

Status: PLAN, decisions locked, pre-P0 checks done (one blocker: 11.5). Owner: solo. Last revised: 2026-09-14.
Branch: `claude/user-plan-disobedience-b282bf`. Nothing built yet.

Drona cards are the proposal system: on a fixed schedule the app reads the
user's progress and plan adherence, turns it into signals, and shows ONE card
on the dashboard. The card is one of three kinds. The user acts on it.

This is a make-or-break feature. The thing it makes or breaks is TRUST. A card
that is wrong once ("your weight stalled" when the scale was not synced) costs
more than ten right cards earn. Every rule below leans that way: precision over
recall, hold is the default, every card shows its evidence, every card is
logged with the facts it fired on so it can be audited later.

---

## 1. The three cards

**Act.** Drona proposes a concrete change. Shows the insight, the change, the
why. Buttons: Apply, Not now, Why (opens chat). Examples:
- Cut, weight flat 2 weeks, intake on target: drop calories 2250 -> 2000.
- Bulk, weight flat 3 weeks, intake on target: add 150 kcal.
- Bench stalled 4 sessions: swap the top set for a back-off scheme (later).
- Readiness low today: make today's session lighter (later, phone-side).
- Missed most of phase 1: extend phase 1 by 2 weeks (dates shift).
- Change the targets of FUTURE phases, not only the current one (later).

**Request.** Drona asks for a behaviour, because the data it needs is missing
or thin. Also carries plain notices. Buttons: Do it (deep link), Got it.
Examples:
- "Weigh in 3 mornings this week. Then I can read the cut."
- "Log food 5 days this week. Then I can tie the scale to your intake."
- "Push A and Pull B are still due. One this week keeps the block alive."
- Notice: "You are new here. I am reading how your body responds. No changes yet."
- Notice: "I saw the 3-week weight trend flatten. Watching it, not moving yet."

**Talk.** Drona has a question. The card says "We need to talk" and a subtext
that names the topic. Tap opens a chat seeded with the topic and the facts.
Inside the chat Drona can do anything an act card does (propose targets,
shift dates) through the existing propose tools. Examples:
- Food logged 3 of 14 days, weight flat: "Are you eating off-log, or is the
  scale really stuck? I cannot tell which yet."
- Followed the plan 3 weeks, then 2 weeks of nothing: "Is something about the
  plan not sitting right?"
- Yesterday had no food logged (later, daily): "Skipped a day, or skipped the log?"

Who picks the kind (revised 2026-09-14, after the "ugly data" discussion):
rules GATE and VALIDATE, the model READS and decides. Rules alone cannot read
messy data (a vacation week, one spike weigh-in, breakfast-only logging) and a
decision table doubles with every new signal. The model alone guesses with
confidence on thin data, is not deterministic, and can cite a number that is
not in the facts. So: rules say whether there is enough clean data to speak
at all, the model says what to say, rules check the card before it is stored.
The talk card is the model's "I am not sure" exit: ugly data should become a
question, never a change.

---

## 2. Architecture: behaviours -> signals -> rules -> decision -> card

```
  cron (weekly, per user, local Monday 00:00)   or   app open (fallback)
                       |
   [1] FACTS      get_drona_facts(user, as_of)         SQL, free. RAW series
                       |                               (weigh-ins with dates,
                       |                               per-day kcal, sessions),
                       |                               notes, last talk answer
   [2] SIGNALS    signalsFrom(facts)                   pure TS, tested, free.
                       |                               What each count means.
                       |                               unknown when thin
   [3] RULES      rulesFrom(facts, signals, memory)    pure TS, tested, free.
                       |                               Which cases fired, plus
                       |                               the gates: enough clean
                       |                               data? grace period?
                       |                               cooldown? tier?
                       |        -> not eligible        -> rules-only table (2c):
                       |                                  request / notice / hold
                       |        -> eligible (Pro)      -> decision
   [4] DECISION   ai-coach mode `drona_card`           the model. Sees the raw
                       |                               facts, the signals, the
                       |                               rules that fired, and
                       |                               Drona's memory (2d).
                       |                               Returns hold | request |
                       |                               act | talk, with cited
                       |                               evidence and a rationale
   [5] VALIDATE   validate(card, facts, history)       pure TS, tested. Kind
                       |                               allowed, topic off
                       |                               cooldown, numbers in
                       |                               bounds, every cited
                       |                               number matches the
                       |                               facts. Any miss -> hold
   [6] STORE      drona_cards row (pending)
                       |
   [7] CLIENT     DronaCard on the dashboard; Apply / Do it / Open chat
                       |
   [8] LEARN      status + facts snapshot + model output per card
```

Same split the app already uses: insights (`lib/insights.ts`) and the weekly
report (`0090 get_weekly_report_facts`) keep facts free and deterministic and
make the model the paid narrator. Nothing new in principle. New in reach.

### 2a. Behaviours (what the user did)
Counted, not judged. All from tables that exist today.
- Food: days logged in 14, mean kcal, mean protein, per-day distance from target.
- Weight: weigh-ins in 14 and 28 days (`daily_metrics.bodyweight_kg`), values.
- Sessions: done vs planned (planned = training days in `week_pattern` x weeks),
  days since last, off-plan count (workout whose routine is not in the current
  phase's split), short sessions (sets done vs routine sets), duration.
- Lifts: per exercise, top set trend over last N sessions (later; today only
  the phone computes stalls in `lib/insights.ts`).
- Recovery: readiness days, mean, low days, sleep mean (`daily_metrics`).
- Tenure: days since first workout, total sessions, days since sign-up.
- Plan: goal kind (cut/bulk/hold), target weight, phase seq, week X of Y,
  days since last target change, days since program start.
- History: last 5 cards, kind, topic, status, date.

### 2b. Signals (what the behaviours mean)
Boolean or small enum. Each has a coverage gate: not enough data = signal is
`unknown`, never `false`. Thresholds are provisional; tune from card logs.

| Signal | Rule (v1 proposal) |
|---|---|
| new_user | < 14 days since first workout OR < 6 sessions |
| weight_sparse | < 6 weigh-ins in 14 days |
| food_sparse | < 9 food days in 14 |
| weight_stalled | cut: 14-day slope > -0.15 kg/wk; bulk: slope < +0.10; needs >= 6 weigh-ins |
| weight_moving_too_fast | cut: slope < -1.0 kg/wk; bulk: > +0.5 (later) |
| kcal_met | >= 70% of logged days within +/-10% of target |
| kcal_over / kcal_under | >= 50% of logged days above / below the 10% band |
| protein_low | mean protein < 80% of target on logged days |
| sessions_missed | done < 60% of planned over 14 days, and at least one done |
| no_training | >= 7 days since last session |
| off_plan | >= 2 off-plan workouts in 14 days |
| recovery_low | mean readiness < 50 on >= 5 of last 7 days, or sleep mean < 6 h |
| recent_change | targets or program changed < 14 days ago |
| card_cooldown(kind, topic) | same kind+topic shown < 14 days ago, or dismissed < 28 days ago |
| lift_stalled(exercise) | later: same top set 4 sessions running |

### 2c. Rules (what fired) and the rules-only table
Rules are the third layer. Each rule names a case and lists the signals that
make it fire. The fired list goes to the decision layer as input. For free
users, and when the model is off or fails, the table below IS the decision:
top match wins, one card per week.
| # | When | Card | Topic |
|---|---|---|---|
| 1 | new_user, no notice yet | request (notice) | watching |
| 2 | no_training and not new_user | talk | plan_drift |
| 3 | sessions_missed 2 weeks running | talk | plan_fit |
| 4 | weight_stalled and food_sparse | talk | logging_vs_eating |
| 5 | weight_stalled and kcal_met and not recent_change | act | targets |
| 6 | weight_stalled and kcal_over (cut) or kcal_under (bulk) | request | hit_target |
| 7 | weight_sparse and goal is weight-based | request | weigh_in |
| 8 | food_sparse | request | log_food |
| 9 | protein_low and kcal_met | act | targets (protein only) |
| 10 | recovery_low | later: act lighter week; v1: notice | recovery |
| 11 | off_plan | later: talk swap_into_plan | |
| 12 | else | hold | |

Row 4 sits above row 5 on purpose: a stall with thin food logs is a question,
not a calorie cut. That is the "correlation" step in one line: the same weight
signal means different things depending on the logging signal.

### 2d. Memory (Drona's record of past clarifications)
The decision must know what the user already said. "Last week you said you
eat off-log on weekends" turns a stall from a question into a plan. Without
it the same talk fires every week and trust dies.

What exists today: nothing. No coach memory table and no `remember_fact` tool
are on disk (the coach-enhancement plan describes them, migration 0040 on
disk is Sonnet pricing, not memory). So v1 memory is this feature's own:
- Every card row keeps its status. A dismissed act on a topic is memory.
- Every talk that ends stores a one-line `summary` on its card row, written by
  the chat when the user answers ("ate off-log on weekends", "plan feels too
  long", "scale was not synced, 4 real weigh-ins"). The chat gets a small
  non-terminal tool `close_talk(summary)` for this. The card status goes to
  `done`.
- The reader gets the last 8 cards with status and summary as the memory
  block. Rules read it too (cooldowns, "already asked").
Later, when general coach memory lands (per-fact rows, `remember_fact`), the
reader gets those facts as a second memory block. The card summaries can be
promoted into it. No schema change needed here; the `summary` column stays.

---

## 3. Where the model sits

- **The model is the decision layer.** Once a week for every Pro user who
  passes the gates. Input: the raw facts (series with dates, not booleans),
  the signals, the rules that fired, the rules-only table's answer as an
  anchor, the user's notes (workout notes, sticky exercise notes), and the
  memory block (2d: last 8 cards with status and talk summaries). Output: one forced tool call, one of
  `hold`, `request_behaviour`, `propose_targets` (exists in
  `supabase/functions/ai-coach/prompt.ts`), `propose_program_dates` (new),
  `open_talk`. Every card carries `evidence`: 2-4 numbers copied from the
  facts, and a one-line rationale in coach voice.
- **The validator is the last word.** Pure TS, tested. Kind allowed for the
  tier. Topic not on cooldown. Calories clamped (`clampDiet` in
  `lib/programData.ts`) and moved <= 10%. Dates moved <= 4 weeks. Every
  evidence number must equal a fact (tolerance for rounding). Any miss stores
  a hold with the rejected card attached for audit. No retry loop.
- **Unsure means talk, not act.** The prompt says so, and the eval checks it:
  an ugly week must come out as talk or hold, never act.
- **Talk cards.** The card subtext comes from the model's `open_talk` call.
  The chat opener comes from the normal chat mode with a seed block (topic +
  facts) so Drona asks in its own voice and can call the propose tools during
  the conversation.
- **Request cards.** For Pro users the model may pick them; for free users
  the rules-only table picks them. Templates carry the copy either way.
- Every prompt claim must be true of the code. Do not tell the user "I will
  re-check in 7 days" unless the pipeline really re-checks in 7 days.

Model calls per Pro user: one per week, plus chats the user opens. Not
deterministic: the same week can hold once and card once. The one-card-a-week
cap and the hold default bound the blast radius; a card missed one week shows
the next.

---

## 4. Storage

`drona_cards` (new migration):
- id, user_id (clerk), kind (act|request|talk), topic text, title, body,
  evidence jsonb (the 2-4 numbers the card shows), payload jsonb (act: the
  validated tool input; request: deep link + behaviour; talk: the seed),
  signals text[], facts jsonb (snapshot), status
  (pending|applied|dismissed|opened|done|expired), week_start date,
  created_at, decided_at, expires_at.
- Partial unique index: one pending card per user.
- RLS: owner select + update of status only. Insert by service role (cron)
  and by the app-open fallback path through the edge function.
- `delete_user_data()` must include it (the function has dropped tables before).

Why a table and not a chat message: coach chat is local-first (AsyncStorage),
a server-written row would never show. Same reason the weekly report used
`seen_at` on its own table.

---

## 5. Schedule and delivery

- Weekly, driven by pg_cron every 15 min like `daily-suggestion`, but in its
  OWN worker function (11.4: that function already takes ~16 s a run). The
  cron marks users whose local Monday began; the worker drains a few per call.
  One row per user per week_start, so reruns are idempotent.
- App-open fallback: if no card row exists for this week and the user opens the
  app, the app POSTs `{mode:'app'}` style like the TODAY pick does. Needed
  because HealthKit weight only syncs when the app opens, so a Monday 00:00
  run can see stale weight for a user who was away. The fallback runs after
  the foreground health sync.
- Daily cards (readiness today, "you skipped yesterday's log") are v2. They
  need a phone-side trigger because readiness is computed on the phone.
- Push notification: none exists (see project_today_suggestion). Later.

---

## 6. Client

- `components/coach/DronaCard.tsx` on the dashboard, one slot, between the
  TODAY card and FUEL. Hidden when no pending card. Three layouts:
  - act: kicker "DRONA PROPOSES", title, body, evidence chips (e.g. "0.0 kg/wk
    over 14 d", "11 of 14 days logged"), Apply + Not now + Why.
  - request: kicker "DRONA ASKS", title, body, Do it (deep link to log weight,
    log food, or the due session) + Got it. Notices: only Got it.
  - talk: title "We need to talk", subtext names the topic, Open.
- Apply for targets: `applyPhaseTargets` AND update the current
  `coach_program_phases` row, so the foreground reconcile cannot snap the
  profile back to the phase's old numbers. VERIFY the snap-back first.
- Apply for dates: shift `coach_programs.start_date` or the phase's
  `duration_weeks`; the TODAY pick re-bases on the new basis automatically.
- Talk opens `AICoachModal` with `source: 'drona_card'`, the seed block, and the
  propose tools on. Free users hit the paywall the modal already owns.
- Analytics: `drona_card_shown / applied / dismissed / opened / done` with
  kind + topic. Event names live in `lib/analytics.ts` only.
- Copy in coach voice. No em dashes. Numbers on chips, not in sentences.

---

## 7. Free vs Pro

- Facts, signals, decision: free and ungated.
- Request cards and notices: free. They cost nothing and they drive logging.
- Act and talk: Pro. Free users see the card locked: "Drona has a change for
  your plan" -> upgrade. The card is the conversion hook.

---

## 8. Guardrails (the trust rules)

1. Hold is the default. No signal, no card.
2. Coverage gates on every signal. Thin data cannot fire an act.
3. One pending card at a time. One new card per week.
4. Cooldowns: same kind+topic 14 days; a dismissed topic 28 days.
5. Bounded moves: calories <= 10% per card, floor from `clampDiet`;
   dates <= 4 weeks per card.
6. New-user grace: first 14 days, notices and requests only, never act.
7. Every card shows its evidence numbers. The user can check them.
8. Every card stores the facts snapshot. A wrong card can be traced.
9. The model chooses only inside the gates, and the validator rejects any
   card whose evidence does not match the facts or whose move is out of
   bounds. A rejected card becomes a hold, never a retry.
10. A card that would contradict a change < 14 days old is suppressed.

---

## 9. Phases (start small)

**P0-pre. Make the data true (blocker from 11.5).**
- Manual weight on Profile and Analytics writes `daily_metrics`
  (`bodyweight_kg`, `source: 'manual'`, LOCAL day) through the sync queue.
- One-time upload of each device's existing AsyncStorage weight log.
- Analytics weight chart reads the server series.
- A test that fails first: an entry at 00:30 local in UTC+5:30 lands on the
  local day.

**P0. Facts + signals + rules + request cards. No model.**
- Migration: `drona_cards` table + `get_drona_facts(user, as_of)` RPC grown
  from 0090's facts (add weight slope, sessions vs planned, off-plan, tenure,
  days since last change, last cards).
- `supabase/functions/_shared/dronaSignals.ts` + `dronaDecide.ts`, pure, tested
  first (a test must fail first).
- Its own worker function, not inside `daily-suggestion` (11.4). The cron
  marks users whose local Monday began; the worker drains them a few at a
  time. App-open fallback for a user with no card this week.
- Facts RPC with `p_user_id`, service_role only (11.2).
- Client `DronaCard` with the request + notice layouts. Deep links.
- Ships value on day one: weigh-in, log-food, due-session nudges, new-user notice.

**P1. The model reader, act cards for targets, and the ugly-week eval.**
- ai-coach mode `drona_card` with the forced tool set (hold, request,
  propose_targets, open_talk; dates in P2). Validator before store.
- Act layout + Apply path (profile + phase row) + Why -> chat.
- Eval FIRST, before trusting the reader: 15 held-out facts packs, at least
  half of them ugly (vacation week, one spike weigh-in, breakfast-only
  logging, a sick week, a scale that synced twice, a clean stall). Expected:
  kind + topic + bounded numbers. Run rules-only and the model on the same
  packs and compare. The model earns the job only if ugly weeks come out as
  talk or hold and clean stalls come out as act. Run with `EVAL_VIA_CLI=1`.
  Never put eval inputs or observed failure numbers in the prompt.

**P2. Talk.**
- Topics plan_drift, plan_fit, logging_vs_eating. Seed block into chat.
- `propose_program_dates` tool, usable from the chat and from act.
- Memory v1: `close_talk(summary)` non-terminal chat tool writes a one-line
  summary on the card row and sets status `done`, so next week's decision
  sees "user said: ate off-log" and does not ask again. The reader's memory
  block is the last 8 cards.

**P3. Wider acts.**
- Extend/restart phase as an act (dates).
- Future-phase target edits (needs a program-edit tool, not only today's numbers).
- Lift stalled -> routine tweak (server-side stall detection first).
- Readiness-low today -> lighter session (phone-side trigger, daily).

**P4. Learn.**
- Accept/dismiss rates per topic -> threshold tuning.
- Body measurements request (check what `bodyStats.ts` still stores first).
- Push notification for a new card (needs push infra).

---

## 10. Future aspects the v1 design must not block

- Daily cadence for some topics: keep `week_start` nullable or add `cadence`.
- Multi-signal correlation beyond pairs: the decision layer takes the whole
  signal set, not a fixed pair. Keep it a table, not nested ifs.
- General coach memory (`remember_fact`, per-fact rows) is not built. When it
  lands, the reader gets it as a second memory block; card summaries can be
  promoted into it. The `summary` column on the card row stays either way.
- Program-wide edits: the payload is jsonb; a future `propose_program_edit`
  tool fits without a schema change.
- Notifications: the card row is the source of truth; push just points at it.

---

## 11. Pre-P0 checks (DONE 2026-09-14)

Live project `rjmmslierxhvwdjgjilb`, read-only queries, aggregates only.

**11.1 Target snap-back.** `reconcileActiveProgram` (`lib/programData.ts`)
rewrites the profile targets ONLY when the current phase differs from
`applied_phase_seq`. A profile-only change survives until the next phase
starts, then the phase's stored numbers overwrite it, and meanwhile the Goal
screen and the coach context still show the phase's old numbers.
-> Apply on a targets card must write BOTH `user_profiles` and the current
`coach_program_phases` row. Future phases: untouched in v1 (P3 decides).

**11.2 Lift stalls.** `get_weekly_report_facts` (0090) computes PRs only, no
stalls. Its `lift_candidates` CTE already builds per-set e1RM with the
unilateral and metric-type rules, so a stall CTE can reuse it.
Also: 0090 resolves the user from the JWT (`current_clerk_user_id()`), so the
cron cannot call it. The facts RPC needs a `p_user_id` variant, execute
granted to `service_role` only (REVOKE from public, anon, authenticated and
verify; new functions and tables start fully granted).

**11.3 Readiness.** `readiness_score` is written only by the phone: on
foreground health sync (`lib/useHealthSync.ts`) and after a manual sleep log.
Today only, never backfilled, and only when a sleep value exists. A user who
does not open the app for 3 days has 3 days with no readiness.
-> Readiness signals must count days WITH a score, never treat a missing day
as low. Live: 7 of 39 users have any readiness row in 28 days.

**11.4 Cron budget.** pg_cron's own call is 0.06 s (it only queues HTTP).
The `daily-suggestion` edge function itself averages about 16 s and peaks
near 39 s per run for 39 users (function_edge_logs, last 24 h).
-> Do not put model calls inside that run. The card pipeline gets its own
function (or a per-user fan-out): the cron marks due users, a worker takes a
few at a time. Why the current run takes 16 s for almost no work is worth its
own look (retry backoff on PostgREST 504s is the first suspect).

**11.5 Body measurements and weight. BLOCKER.** `lib/bodyStats.ts` keeps the
weight log, body-fat log and measurements in AsyncStorage ONLY. The manual
weight entry on Profile (`scheduleWeightLog`) and on Analytics (`addWeight`)
calls `saveWeightLog`, which never writes to the server. The server sees
weight only from HealthKit or Health Connect.
Live: 2 of 39 users have any `bodyweight_kg` row in 28 days.
-> Without a fix the pipeline would send "weigh in more" to a user who weighs
in by hand every day. That is the exact trust failure this plan exists to
avoid. Both entry points also key the day with `toISOString().slice(0,10)`,
which is the UTC day, not the local day.
-> New P0 prerequisite (see 9): manual weight writes to `daily_metrics`
(`source: 'manual'`, local day), a one-time upload of the existing device
log, and the Analytics chart reads the server series. Measurements and body
fat stay device-only for now; the pipeline cannot use them until they move.

**11.5 update (2026-09-15): weight FIXED in the worktree, not committed.**
`lib/bodyweightLog.ts` (pure rules + sync core, 15 Deno tests, each rule
proven to fail without its fix) and `lib/bodyweightSync.ts` (AsyncStorage +
Supabase binding). Signed-in weigh-ins on Profile and Analytics save on the
phone at once, then upsert `daily_metrics` in kg on the LOCAL day. The old
device log uploads once (never over a day the server already has) and is
cleared. The app-open sync in `lib/useHealthSync.ts` flushes before the hub
sync. Guests keep the device log. Verified against the live database with a
signed token for a made-up user id: 11 of 11 checks, rows cleaned up.
Also found: the kg/lbs switch was a bare label, so a lbs user's 165 was stored
as 165 kg. The server series now converts; `user_profiles.weight_kg` on the
Profile field still stores the raw typed number (separate task).

**Other body data, where it lives (2026-09-15):**
| Data | History | Latest value |
|---|---|---|
| Weight (signed in) | server `daily_metrics` (after this fix) | `user_profiles.weight_kg`, raw typed unit |
| Body fat % | phone only | `user_profiles.body_fat_percent` |
| 13 tape measurements | phone only | none |
| Goal weight | - | `user_profiles.goal_weight_kg` + phone |
| Sleep (manual) | server `daily_metrics` | - |
| Steps, HRV, RHR, energy | server, from HealthKit / Health Connect | - |
PostHog only went live 2026-09-13, so event counts cannot yet say how many
people log body fat or measurements (0 events so far, 2 weight logs).

**11.6 Free text the decision layer can see.** Last 28 days, whole user base:
| Source | Rows with text | Avg chars |
|---|---|---|
| `workouts.notes` | 0 | - |
| `workout_exercise_notes` | 0 | - |
| `user_exercise_notes` (sticky, all time) | 24 | 38 |
| `routine_exercises.note` (cues, all time) | 220 | 54 |
| `user_profiles.injury_notes` | 3 | 51 |
Coach memory: no memory table exists live either (nor
`coach_conversations`). -> Notes are tiny, include them whole. Section 2d
memory (card rows + talk summaries) is the only memory v1 has.

**11.7 Data density (extra, and the most important).** Live, 39 users:
| Measure (last 28 days) | Users |
|---|---|
| Finished any workout | 3 |
| 8+ workouts | 2 |
| Any weigh-in on the server | 2 |
| 12+ weigh-ins | 1 |
| Any food logged | 5 |
| 18+ food days | 0 |
| Active program | 4 |
| Active program + enough weight AND food for a stall act | 0 |
| Pro (annual or monthly, not expired) | 5 |
| Open coach trials | 16 |
-> Today an act card would fire for nobody. Request cards and the
new-user notice are the whole visible product at this size, which is what
P0 already ships. Part of the thin weight number is 11.5, not the users.
-> The P1 eval cannot come from live data. Its fixtures are synthetic facts
packs.

---

## 12. Decisions (LOCKED 2026-09-14)

1. Reader: the model is the decision layer for every eligible Pro week. Rules
   gate before it and validate after it.
2. Cadence: weekly only in v1. Daily topics are v2.
3. Free tier: rules-only request cards and notices are free. The model
   decision, act cards and talk cards are Pro.
4. Grace period: 14 days with no act cards.
