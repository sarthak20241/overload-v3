import { assertEquals } from "jsr:@std/assert@1";
import { decideCard, type DronaFacts } from "./dronaCards.ts";
import {
  ASKS, askedLately, type BehaviourRow, decidePick, hushed, mutedTopics, painFirst, PICK_ASKS, type PickFacts, WORDS,
} from "./dronaPick.ts";

const WEEK = "2026-10-19";
const facts = (cards: DronaFacts["cards"] = []): DronaFacts => ({ week_start: WEEK, cards });
const pf = (...behaviours: BehaviourRow[]): PickFacts => ({ week_start: "2026-10-12", behaviours });
const row = (behaviour: string, priority: number, card_kind: string, detail: Record<string, unknown> = {},
  over: Partial<BehaviourRow> = {}): BehaviourRow => ({ behaviour, priority, card_kind, mutes: [], detail, ...over });

// Details shaped like the live rows (2026-10-18).
const goals = row("goals_unclear", 20, "talk", {
  program: "9-Week Six-Pack Cut", profile_goal: "hypertrophy", program_goal: "fat_loss",
  profile_goal_kg: 72.5, program_target_kg: 69, profile_direction: "hold", program_direction: "loss",
});
const stall = (cause: string) => row("lift_stall", 23, "talk", {
  cause, lifts: [{ exercise: "Rear delt machine", from_kg: 50.4, now_kg: 49.2, change_pct: -2.4 },
                 { exercise: "Dragon Fly", from_kg: 1.2, now_kg: 1.2, change_pct: 0 }],
});
const onTrack = row("on_track", 90, "notice", { sessions: 6, planned: 6 });
const finding = row("finding_maintenance", 14, "request", { missing: ["weigh_ins"] });
const notLanding = row("topic_not_landing", 13, "talk",
  { topics: [{ topic: "weigh_in", cards: 2, not_followed: 2 }] }, { mutes: ["topic:weigh_in"] });
const scale = row("scale_untrusted", 10, "request", { readings: 2, typical_swing_kg: 15 },
  { mutes: ["weight_wrong_way"] });
// The word behaviours, as _shared/dronaWords.ts writes their rows.
const WORD_ROWS: BehaviourRow[] = [
  row("hurting", 5, "talk", { area: "knee", day: "2026-10-14" }),
  row("asked_for_a_change", 15, "talk", { change: "training_days", day: "2026-10-13" }),
  row("life_got_in_the_way", 18, "talk", { reason: "travel", sessions: 1, planned: 4 }),
  row("trains_not_logging", 19, "notice", { day: "2026-10-14" }),
];

Deno.test("nothing judged: no card", () => {
  assertEquals(decidePick(null, facts()), null);
  assertEquals(decidePick(pf(), facts()), null);
});

Deno.test("the best priority wins", () => {
  assertEquals(decidePick(pf(onTrack, goals), facts())?.topic, "goals_unclear");
});

Deno.test("the check-in's own behaviours are skipped: it has its own card", () => {
  assertEquals(decidePick(pf(finding, goals), facts())?.topic, "goals_unclear");
  assertEquals(decidePick(pf(finding), facts()), null);
  // Even if it had words of its own, the weekly card still leaves it to the check-in.
  WORDS.finding_maintenance = () => ({ kind: "request", title: "t", body: "b", evidence: [], payload: {} });
  try {
    assertEquals(decidePick(pf(finding, goals), facts())?.topic, "goals_unclear");
  } finally {
    delete WORDS.finding_maintenance;
  }
});

Deno.test("steer rows are never a card", () => {
  const steer = row("topic_not_landing", 13, "steer", notLanding.detail!, { mutes: ["topic:weigh_in"] });
  assertEquals(decidePick(pf(steer, goals), facts())?.topic, "goals_unclear");
});

Deno.test("cooldown: shown last week, skip to the next; dismissed 3 weeks ago, still skipped", () => {
  assertEquals(decidePick(pf(goals, onTrack), facts([{ week_start: "2026-10-12", topic: "goals_unclear", status: "pending" }]))?.topic,
    "on_track");
  assertEquals(decidePick(pf(goals), facts([{ week_start: "2026-09-28", topic: "goals_unclear", status: "dismissed" }])), null);
  assertEquals(decidePick(pf(goals), facts([{ week_start: "2026-10-05", topic: "goals_unclear", status: "applied" }]))?.topic,
    "goals_unclear");
});

Deno.test("a 'topic:' mute skips a card that asks for that topic", () => {
  // topic_not_landing mutes weigh-ins; the scale card asks for one.
  assertEquals([...mutedTopics(pf(notLanding, scale))], ["weigh_in"]);
  const steer = row("topic_not_landing", 13, "steer", notLanding.detail!, { mutes: ["topic:weigh_in"] });
  assertEquals(decidePick(pf(scale, steer, onTrack), facts())?.topic, "on_track");
  // A signal mute is not a topic mute.
  assertEquals(decidePick(pf(scale), facts())?.topic, "scale_untrusted");
});

Deno.test("one cooldown across old and new cards: an ask waits after the same ask in either", () => {
  // An old P0 weigh-in card last week: the scale card waits.
  assertEquals(decidePick(pf(scale, onTrack), facts([{ week_start: "2026-10-12", topic: "weigh_in", status: "pending" }]))?.topic,
    "on_track");
  // A pick food ask last week: the P0 food ask waits (the worker adds this to its skip list).
  assertEquals([...askedLately(facts([{ week_start: "2026-10-12", topic: "logs_partial_days", status: "applied" }]))], ["log_food"]);
  assertEquals([...askedLately(facts([{ week_start: "2026-09-21", topic: "logs_partial_days", status: "applied" }]))], []);
});

Deno.test("the old P0 cards still use the topics ASKS maps their actions to", () => {
  // Mutes and the shared cooldown match these strings exactly.
  const settled = { week_start: WEEK, cards: [], tenure: { days_since_first_session: 200, sessions_total: 60 },
    goal: { goal: "fat_loss", goal_weight_kg: 70 }, recovery: {} } as DronaFacts;
  const cases: DronaFacts[] = [
    { ...settled, training: { sessions_14d: 0, planned_14d: 8, days_since_last_session: 11 },
      nutrition: { days_logged_14d: 12, target_kcal: 2000 }, weight: { weigh_ins_14d: 10, weigh_ins_28d: 20 } },
    { ...settled, training: { sessions_14d: 8, planned_14d: 8, days_since_last_session: 1 },
      nutrition: { days_logged_14d: 12, target_kcal: 2000 }, weight: { weigh_ins_14d: 0, weigh_ins_28d: 0 } },
    { ...settled, training: { sessions_14d: 8, planned_14d: 8, days_since_last_session: 1 },
      nutrition: { days_logged_14d: 0, target_kcal: 2000 }, weight: { weigh_ins_14d: 10, weigh_ins_28d: 20 } },
  ];
  const seen = cases.map((f) => decideCard(f)).map((c) => [c.payload.action, c.topic]);
  assertEquals(seen, [["start_session", "due_session"], ["log_weight", "weigh_in"], ["log_food", "log_food"]]);
  for (const [action, topic] of seen) assertEquals(ASKS[action!], topic);
});

Deno.test("every pick card that always asks is in PICK_ASKS, with the topic ASKS gives its action", () => {
  // One sample row per behaviour with words; lift_stall varies by cause and is checked apart.
  const samples: BehaviourRow[] = [goals, onTrack, notLanding, scale,
    row("logs_partial_days", 11, "request", { avg_kcal: 416.7, target_kcal: 1800, days_logged: 3 }),
    row("drifting_away", 21, "talk", { sessions: 0, planned: 5, last_week_sessions: 0, last_week_planned: 5 }),
    row("own_way", 22, "talk", { muscles_left_out: [] }),
    row("plan_too_big", 24, "talk", { planned: 6, avg_sessions: 4 }),
    row("exercise_skipped", 25, "talk", { exercises: [{ exercise: "Shrugs", why: "routine_skip", planned: 6, skipped: 5 }] }),
    ...WORD_ROWS];
  assertEquals(samples.map((r) => r.behaviour).sort(), Object.keys(WORDS).filter((b) => b !== "lift_stall").sort());
  for (const r of samples) {
    const action = decidePick(pf(r), facts())!.payload.action;
    const asks = action ? ASKS[action] : undefined;
    assertEquals(PICK_ASKS[r.behaviour], asks, r.behaviour);
  }
  // lift_stall asks only when it cannot tell why: not a standing ask.
  assertEquals(PICK_ASKS.lift_stall, undefined);
});

Deno.test("not hearing Drona: the pick is said as a notice, no ask", () => {
  const meta = row("not_hearing_drona", 12, "notice", {}, { meta: true });
  const card = decidePick(pf(meta, goals), facts())!;
  assertEquals([card.topic, card.kind, card.payload], ["goals_unclear", "notice", {}]);
  // Only what Drona saw: a notice has no button, so it asks nothing.
  assertEquals(card.body,
    "Your profile says: build muscle, hold at 72.5 kg. Your program, 9-Week Six-Pack Cut, says: lose fat, down to 69 kg.");
});

Deno.test("not hearing Drona with no pick: the fallback card is hushed too", () => {
  const meta = row("not_hearing_drona", 12, "notice", {}, { meta: true });
  assertEquals(decidePick(pf(meta), facts()), null);
  // A P0 ask has no quiet body: a hushed week says nothing rather than ask.
  const ask = { kind: "request", topic: "due_session", body: "Start with what is due.", payload: { action: "start_session" },
    signals: ["no_training"] };
  const quiet = hushed(ask, pf(meta));
  assertEquals([quiet.kind, quiet.payload, quiet.signals.at(-1)], ["hold", {}, "behaviour:not_hearing_drona"]);
  assertEquals(hushed(ask, pf(onTrack)), ask);
  const hold = { kind: "hold", topic: "hold", body: "", payload: {}, signals: [] };
  assertEquals(hushed(hold, pf(meta)), hold);
});

Deno.test("goals_unclear: both sides in words, and the opening line carries them", () => {
  const card = decidePick(pf(goals), facts())!;
  assertEquals(card.kind, "talk");
  assertEquals(card.body,
    "Your profile says: build muscle, hold at 72.5 kg. Your program, 9-Week Six-Pack Cut, says: lose fat, down to 69 kg. Tell me which one is right.");
  assertEquals(card.payload.action, "talk");
  assertEquals(card.evidence.map((e) => e.value), ["72.5 kg", "69 kg"]);
  assertEquals(card.payload.prompt?.includes("lose fat, down to 69 kg"), true);
});

Deno.test("lift_stall: the cause picks the words and the kind", () => {
  const plateau = decidePick(pf(stall("real_plateau")), facts())!;
  assertEquals([plateau.kind, plateau.title], ["talk", "Rear delt machine has stopped moving"]);
  assertEquals(plateau.evidence, [{ label: "Best max, 3 weeks ago", value: "50.4 kg" }, { label: "Best max now", value: "49.2 kg" }]);
  const cut = decidePick(pf(stall("expected_on_cut")), facts())!;
  assertEquals([cut.kind, cut.payload], ["notice", {}]);
  const blind = decidePick(pf(stall("cant_tell")), facts())!;
  assertEquals([blind.kind, blind.payload.action], ["request", "log_food"]);
  assertEquals(decidePick(pf(stall("no_such_cause")), facts()), null);
});

Deno.test("drifting_away: zero sessions says so; some sessions say how many", () => {
  const zero = row("drifting_away", 21, "talk", { sessions: 0, planned: 5, last_week_sessions: 0, last_week_planned: 5 });
  assertEquals(decidePick(pf(zero), facts())!.body.startsWith("No sessions for two weeks."), true);
  const some = row("drifting_away", 21, "talk", { sessions: 1, planned: 4, last_week_sessions: 1, last_week_planned: 4 });
  assertEquals(decidePick(pf(some), facts())!.body.startsWith("2 of 8 planned sessions in two weeks."), true);
});

Deno.test("plan_too_big, exercise_skipped, topic_not_landing, own_way, partial days: the numbers land", () => {
  const big = decidePick(pf(row("plan_too_big", 24, "talk", { planned: 6, avg_sessions: 4.125, weeks_trained: 7 })), facts())!;
  assertEquals(big.title, "The plan asks for 6, you do about 4");
  assertEquals(big.body.includes("averaged 4.1 sessions"), true);

  const skipped = decidePick(pf(row("exercise_skipped", 25, "talk", { exercises: [
    { exercise: "Incline Dumbbell Press", why: "routine_skip", planned: 14, skipped: 7 },
    { exercise: "Chest Supported Kelso Shrugs", why: "routine_skip", planned: 6, skipped: 5 },
  ] })), facts())!;
  assertEquals(skipped.title, "You keep skipping Chest Supported Kelso Shrugs");
  assertEquals(skipped.body.includes("in 5 of 6 sessions"), true);

  const landing = decidePick(pf(notLanding), facts())!;
  assertEquals(landing.body.startsWith("I asked for weigh-ins twice, and none came."), true);

  const own = decidePick(pf(row("own_way", 22, "talk", { muscles_left_out: ["Calves", "Hamstrings"] })), facts())!;
  assertEquals(own.body.includes("Calves and Hamstrings got left out."), true);

  const partial = decidePick(pf(row("logs_partial_days", 11, "request",
    { avg_kcal: 416.7, target_kcal: 1800, days_logged: 3 })), facts())!;
  assertEquals(partial.body.startsWith("Your logged days average 417 kcal against a 1,800 target."), true);
});

Deno.test("a detail too thin for honest words is skipped, not said wrong", () => {
  // One side known is not a disagreement anyone can read.
  assertEquals(decidePick(pf(row("goals_unclear", 20, "talk", { profile_goal: "hypertrophy" }), onTrack), facts())?.topic,
    "on_track");
  assertEquals(decidePick(pf(row("unknown_behaviour", 1, "talk", {})), facts()), null);
});

Deno.test("chips stay short: big type is made for numbers", () => {
  const all = [goals, stall("real_plateau"), onTrack, notLanding, scale,
    row("own_way", 22, "talk", { muscles_left_out: ["Calves", "Hamstrings", "Forearms"] }),
    row("plan_too_big", 24, "talk", { planned: 6, avg_sessions: 4.125 }),
    row("exercise_skipped", 25, "talk", { exercises: [{ exercise: "Chest Supported Kelso Shrugs", why: "routine_skip", planned: 6, skipped: 5 }] }),
    row("logs_partial_days", 11, "request", { avg_kcal: 416.7, target_kcal: 1800, days_logged: 3 }), ...WORD_ROWS];
  for (const r of all) {
    for (const e of decidePick(pf(r), facts())?.evidence ?? []) assertEquals(e.value.length <= 10, true, `${r.behaviour}: ${e.value}`);
  }
});

Deno.test("every hushed card is a notice that asks nothing, or nothing at all", () => {
  const meta = row("not_hearing_drona", 12, "notice", {}, { meta: true });
  const all = [goals, stall("real_plateau"), stall("recovery"), stall("under_fuelled"), stall("cant_tell"),
    stall("inconsistent_training"), onTrack, notLanding, scale,
    row("logs_partial_days", 11, "request", { avg_kcal: 416.7, target_kcal: 1800, days_logged: 3 }),
    row("drifting_away", 21, "talk", { sessions: 0, planned: 5, last_week_sessions: 0, last_week_planned: 5 }),
    row("own_way", 22, "talk", { muscles_left_out: ["Calves"] }),
    row("plan_too_big", 24, "talk", { planned: 6, avg_sessions: 4 }),
    row("exercise_skipped", 25, "talk", { exercises: [{ exercise: "Shrugs", why: "never_done", phase_weeks: 4 }] }),
    ...WORD_ROWS, row("life_got_in_the_way", 18, "notice", { reason: "illness" })];
  for (const r of all) {
    const c = decidePick(pf(meta, r), facts());
    if (!c) continue;
    assertEquals(c.kind, "notice", r.behaviour);
    assertEquals(/\?|Tell me|Log |Weigh in|Time to|Consistency first|is the first/.test(c.body), false, `${r.behaviour}: ${c.body}`);
  }
});

Deno.test("the word cards: what each says, and the professional line on every hurting card", () => {
  const [hurt, asked, life, trained] = WORD_ROWS.map((r) => decidePick(pf(r), facts())!);
  assertEquals([hurt.kind, hurt.title], ["talk", "Look after that knee"]);
  assertEquals(hurt.body.includes("get it checked by a professional"), true);
  assertEquals(hurt.payload.prompt, "I mentioned knee pain. Which exercises should I swap or ease off until it settles?");
  const unknownArea = decidePick(pf(row("hurting", 5, "talk", { area: "other" })), facts())!;
  assertEquals([unknownArea.title, unknownArea.body.startsWith("You mentioned pain.")], ["Look after that injury", true]);
  const meta = row("not_hearing_drona", 12, "notice", {}, { meta: true });
  assertEquals(decidePick(pf(meta, WORD_ROWS[0]), facts())!.body.includes("get it checked by a professional"), true);

  assertEquals(asked.body, "You asked to change your training days. Your plan has not changed yet. Want to sort it out now?");
  assertEquals(decidePick(pf(row("asked_for_a_change", 15, "talk", { change: "calories" })), facts())!.body.startsWith(
    "You asked to change your calories. Your targets have not changed yet."), true);

  assertEquals([life.kind, life.title, life.payload.action], ["talk", "Training on the road", "talk"]);
  const ill = decidePick(pf(row("life_got_in_the_way", 18, "notice", { reason: "illness" })), facts())!;
  assertEquals([ill.kind, ill.payload], ["notice", {}]);

  assertEquals(trained.body.startsWith("You said you trained on Wednesday, but no session is logged that day."), true);
  assertEquals(decidePick(pf(row("trains_not_logging", 19, "notice", { day: "bad" })), facts()), null);
});

Deno.test("painFirst: the hurting card alone, before everything; nothing when there is none or it waits", () => {
  // A new user with a few days of data still hears about pain (the worker runs this before the new-user notice).
  const card = painFirst(pf(goals, WORD_ROWS[0], onTrack), facts())!;
  assertEquals([card.topic, card.kind], ["hurting", "talk"]);
  assertEquals(painFirst(pf(goals, onTrack), facts()), null);
  assertEquals(painFirst(pf(WORD_ROWS[0]), facts([{ week_start: "2026-10-12", topic: "hurting", status: "pending" }])), null);
  // Hushed: still said, as a notice that keeps the professional line.
  const quiet = painFirst(pf(row("not_hearing_drona", 12, "notice", {}, { meta: true }), WORD_ROWS[0]), facts())!;
  assertEquals([quiet.kind, quiet.body.includes("professional")], ["notice", true]);
  // A hushed card with nothing quiet to say is a hold, and a hold is not a pain card.
  const real = WORDS.hurting;
  WORDS.hurting = () => ({ kind: "talk", title: "t", body: "b?", evidence: [], payload: { action: "talk" } });
  try {
    assertEquals(painFirst(pf(row("not_hearing_drona", 12, "notice", {}, { meta: true }), WORD_ROWS[0]), facts()), null);
  } finally {
    WORDS.hurting = real;
  }
});

Deno.test("no words use an em dash", () => {
  const all = [goals, stall("real_plateau"), stall("recovery"), stall("under_fuelled"), stall("inconsistent_training"),
    onTrack, notLanding, scale, ...WORD_ROWS];
  for (const r of all) {
    const c = decidePick(pf(r), facts());
    if (!c) continue;
    assertEquals(/—/.test(`${c.title} ${c.body} ${c.payload.prompt ?? ""} ${JSON.stringify(c.evidence)}`), false);
  }
});
