# Onboarding Redesign Plan (Cal AI-inspired, Drona-narrated)

Branch: `claude/onboarding-page-design-9a6550`
Status: PLANNED 2026-07-17. Phases execute in order; each phase ships and verifies on its own.

## North star

Onboarding is a first consultation with Coach Drona: collect only answers that change
the generated plan, make every input feel physical (pickers, sliders, haptics), show the
plan math reacting live, and end with a ceremony that turns "a list of routines" into
"my plan, built for me, starting today."

Reference: Cal AI onboarding (27 screens reviewed 2026-07-17, saved in session scratchpad).
We take its interaction toolkit, pacing, and ceremony. We do NOT take fabricated stats,
the notification pre-prompt, or the hard end-of-funnel paywall.

## Locked constraints (do not re-litigate)

- Data-collection intake, not a feature tour. Every question must change the output.
- No permission prompts in onboarding (notifications dependency doesn't exist; health connects contextually).
- Steps are REQUIRED, not skippable (user decision 2026-07-17, supersedes the v1
  "every step skippable" rule): the promise is a plan built for you, and defaults
  undermine it. Friction stays near zero because pickers/sliders always hold a
  sensible prefilled value, so Continue is always one tap; single-select steps
  auto-advance. Back always works; everything remains editable later in
  Profile/Nutrition. The skip affordance and skip fallbacks are removed from the UI;
  the engine keeps its defaults purely as a code-level safety net.
- Gate in `app/(app)/_layout.tsx` keeps using `useSupabaseClient` (anon fallback misreads legacy users).
- Starter routines created in REVERSE order (both write paths prepend).
- Copy in Drona's coach voice; no em dashes anywhere; restrained lime accent (tint, not borders);
  mature/calm/bold aesthetic. Dark + light parity.
- Polished gesture/animation UX uses libraries, not hand-rolled physics (feedback memory).
- No fabricated claims or fake social proof. Honest theater only (the build moment shows
  real generation steps).

## Premium bar (user direction 2026-07-17)

Every screen must read premium, Cal AI-grade: one question owns the screen, display-size
typography, generous whitespace, a single restrained accent, consistent motion. Premium
here means restraint + motion consistency, not decoration. Concretely:
- Onboarding type scale: display headline (~34-40), calm gray subline, nothing else
  competing above the fold.
- One shared transition grammar: content cross-fade/slide 250 ms on step change,
  progress bar animates width, Continue has a press-scale state (PressableScale).
- Haptics on every meaningful contact (selection, detent ticks, hold-complete, reveal).
- The welcome screen is a hero: real app demo looping inside a device frame + one
  tagline + Get started / Sign in (see Phase 4). No feature list.

## Psychology layer (from uxpeak "UX Psychology Behind Apps People Can't Stop Using", added 2026-07-18)

Six principles from the video, mapped to concrete flow decisions. Apply the honest ones
fully; loss-framing only where it states a true fact.

1. Smart defaults (70-90% never change a default; defaults read as recommendations):
   EVERY step arrives pre-selected with the most common answer, not just the pickers.
   Goal preselects Build muscle, experience preselects Just starting out, frequency
   preselects 3, body pickers sit on population medians, pace sits on Recommended.
   Continue is always one tap. Skip affordance stays removed; defaults do its job.
2. Goal gradient (never start at zero; head start doubles completion): the progress
   bar counts account creation + welcome as already done, so the first question shows
   ~15-20% progress, not 0. Owned by the Phase 0 scaffold. The build moment likewise
   never starts its counter at 0%.
3. Reciprocity (give value BEFORE asking): APPROVED by user 2026-07-18. Run the
   full intake + plan generation BEFORE account creation, as guest (guest mode and
   the per-identity done-flag already support this). The user sees their real plan
   revealed, then the ask is "Save your plan" (create account), Duolingo-style.
   Phase 5 reveal ends in Save-your-plan for guests; signed-in users (rare path)
   keep the current finish. Includes the anon device-rate-limited edge route
   (one onboarding plan per device) so guests get the real Drona plan.
4. IKEA / endowment effect (people value what they built and won't abandon it): the
   reveal's language is possessive and built ("Your training. Your fuel. Built from
   your answers."), the final CTA is "Start my plan" not "Finish", and the sign-up
   ask is framed as keeping something that already exists, never as a wall before
   value.
5. Loss aversion / status quo bias (loss is ~2x gain): use ONLY honest instances.
   Leaving onboarding after the plan was generated gets a confirm framed around the
   real loss ("Your plan is ready. Leave and it's gone."). NO fake countdowns, no
   manufactured stakes (conflicts with the no-fabrication rule).
6. Contrast / anchoring (numbers are judged relative to the first number seen): the
   pace slider anchors on Recommended between Slow and Fast so the chosen pace feels
   moderate; the reveal shows kcal beside its context (maintenance) so the target
   reads as a considered adjustment, not an absolute number.

## Target flow (end state)

welcome (hero demo + Drona intro)
-> goal
-> experience
-> frequency
-> equipment            [NEW - feeds plan engine]
-> body (sex, age wheel, height wheel, weight ruler)
-> target + pace        [goal-dependent; live plan math]
-> Drona interlude      [one screen, honest adaptive-coaching pitch]
-> commitment hold      [tap-and-hold ritual]
-> build moment         [2-3 s staged reveal of real generation]
-> plan reveal          [goal date + curve + training + fuel + navigator]
-> dashboard (Today card continues the story)

Current code: `app/onboarding.tsx` (1223 lines, 7 steps), `lib/onboarding.ts` (512 lines:
gate, Mifflin-St Jeor targets, 3 fixed template sets, local-first writers).

---

## Phase 0 - Step scaffold + shared onboarding UI kit

Goal: every later phase drops into a consistent frame instead of re-inventing layout.

- Extract from `app/onboarding.tsx` into `components/onboarding/`:
  - `StepScaffold` (progress bar, back, skip, big headline, "why we ask" subline,
    pinned Continue, keyboard-aware, Android back handling as today).
  - `OptionCard` (icon tile + title + sub + radio, selected state, accessibilityState,
    auto-advance timing 320 ms preserved).
  - Haptics wiring via existing `lib/haptics.ts` (selection tick on option tap,
    tap on Continue).
- Remove the skip affordance everywhere; ensure every step holds a valid prefilled
  value so Continue is never blocked-feeling (required-not-annoying).
- Establish the motion grammar here (step transition, progress bar animation,
  Continue press state) so later phases inherit it for free.
- Pure refactor of the existing 7 steps onto the kit otherwise. No per-screen redesign
  yet beyond spacing discipline (one question per screen, generous whitespace).
- Verify: tsc clean; walk all steps on sim via `overload://onboarding`; behavior parity
  (back, auto-advance, plan output unchanged); no skip remains reachable.

## Phase 1 - Physical inputs (body step)

Goal: the single biggest "feel" upgrade; body step stops being a form.

- Replace text inputs with:
  - Age: wheel picker (year wheel or age wheel; store ageYears as today).
  - Height: wheel picker with ft/in <-> cm toggle (keep existing conversion logic).
  - Weight: horizontal ruler slider with kg/lb toggle, large live readout.
- Library selection first (candidates: `@quidone/react-native-wheel-picker` or similar
  maintained wheel; ruler either from a maintained lib or a thin FlatList-snap ruler if
  no good lib exists - decide in-phase, device-test before committing).
- Haptic tick per detent (throttled), Reanimated for readout roll.
- Sex stays as three OptionCards on the same screen (top), pickers below; if it crowds,
  split sex onto its own auto-advance step (Cal AI pattern) - decide on device.
- Verify: on-device (sim + a physical Android build for haptic feel), both unit systems
  round-trip, prefilled defaults sensible (median height, typical weight), saved values
  identical shape to today.

## Phase 2 - Target + pace step with live plan math

Goal: the first moment the user feels the app computing. Replaces the static target step.

- Show only when it earns its place: fat_loss, hypertrophy, strength (weight-direction
  goals). general/endurance skip straight on (shorter perceived quiz).
- UI: target weight (ruler, prefilled sensibly) + pace slider
  (slow / recommended / fast personality marks, lime accent on the active state).
- Real math in `lib/onboarding.ts`:
  - `paceToTargets(answers, weeklyRateKg)`: daily kcal delta = weeklyRate * 7700 / 7,
    applied to TDEE (replaces the coarse `goalAdjustment` factor when a target exists;
    keep the factor as fallback for skips).
  - Safety clamps: loss 0.1-1.0 kg/wk and never below max(1200, BMR floor); gain
    0.1-0.5 kg/wk. Recommended default ~0.5% bodyweight/wk loss, 0.25% gain.
  - `projectGoalDate(weightKg, goalWeightKg, weeklyRateKg)` -> ISO date for the reveal.
- Outcome card updates live as the slider moves: "Goal by <Month DD>. Daily fuel:
  <kcal> kcal." Coach-voice sublines per pace band (honest, no hype).
- Persist chosen pace (new profile field or derive; decide: store `goal_weekly_rate_kg`
  in user_profiles for the coach to read later - needs migration, see Phase 3 notes).
- Verify: unit tests for clamps/dates (pure functions); slider live-updates on sim;
  goals that bypass this step (general/endurance) still get sane targets from the
  fallback factor.

## Phase 3 - Real plan engine (the core upgrade)

Goal: plans stop being 3 fixed templates; the plan is genuinely Drona-generated, with
a deterministic engine as validator + instant fallback.

REVISED 2026-07-18 (user decision): LLM generation is IN for v1. The product thesis is
"Drona builds your plan"; a template engine behind that copy is quiet dishonesty. Split:

### Phase 3a - Deterministic engine (fallback + validator)
Everything below (frequency-exact days, equipment filter, movement-pattern slotting).
Its three jobs: (1) instant offline/error/timeout fallback so the reveal NEVER breaks
or spins, (2) schema/catalog validator for LLM output - every exercise name must
resolve against the seeded catalog or gets pattern-matched substitution, (3) guest
path if the anon edge route is declined.

### Phase 3b - Drona generation (the real thing)
- Reuse the EXISTING ai-coach edge fn plan capability (GeneratedWorkout schema,
  sanitizers, save path already in AICoachModal) with a new `onboarding_plan` mode:
  input = intake answers, output = structured multi-day plan + one-line per-day
  rationale + overall rationale in coach voice (feeds the reveal's "why this works
  for you" with REAL text).
- Latency handling (REVISED 2026-07-18, user decision): the build screen is
  ELASTIC, not time-boxed. Fire the request when the last plan-relevant answer
  lands (pace step); interlude + commitment cover the head of the wait, and the
  build screen runs as long as generation takes (30-60 s is fine). Checklist
  ticks bind to REAL progress: the edge fn's server status events (same
  mechanism as chat thinkingPhase), and if streaming, each training day ticks
  as Drona finishes it. NO timeout bail to the deterministic plan for slowness -
  the user always gets the actual Drona plan.
- Deterministic fallback fires ONLY on hard failure (offline first-run, edge fn
  error/unreachable): ship the starter plan with honest copy and auto-regenerate
  with Drona when reachable (silent upgrade, surfaced as a coach note).
- Output validation through 3a before anything is written; catalog-resolution
  failures are substituted, never silently dropped (flusher invariant).
- Cost: one Sonnet call per new user (cents); doubles as the free first taste of
  the paid coach (reciprocity).
- Guests: needs an anonymous device-rate-limited edge route capped at ONE
  onboarding plan per device (security decision pending with guest-first);
  otherwise guests get 3a and Drona generation runs right after account creation.

- New question: equipment ("Full gym" / "Dumbbells + bench" / "Bodyweight only"),
  one OptionCard screen, auto-advance. It changes exercise selection, so it earns
  its place.
- `lib/planEngine.ts` (pure, unit-testable; `buildStarterRoutines` becomes a thin
  wrapper or is replaced):
  - Frequency-exact days: 2 -> FB A/B, 3 -> FB A/B/C (not 2 templates for 3 days),
    4 -> Upper/Lower x2 with A/B variation, 5 -> PPL + Upper/Lower, 6 -> PPL x2 A/B.
  - Exercise selection from `EXERCISE_LIBRARY` filtered by equipment, slotted by
    movement pattern (squat/hinge/push-h/push-v/pull-h/pull-v/core/arms/delts)
    so every day is balanced instead of hardcoded names. Names must resolve against
    the seeded catalog (sync queue resolves by name - keep that invariant; add a
    pattern/equipment map for the ~50 seeded exercises inside the engine, no schema
    change required for v1).
  - Volume: sets by experience as today, plus age damping (55+ slightly fewer hard
    sets, longer rests) and goal-based rep/rest prescriptions preserved.
  - Goal emphasis: fat_loss/endurance bias toward higher-rep compounds + shorter rest
    (as today) plus optional finisher slot; hypertrophy adds an isolation slot for
    a weak-point choice (future muscle-focus question can feed this without rework).
  - Deterministic: same answers -> same plan (testable, cache-friendly, offline-safe).
    No LLM in the generation path for v1 (instant, guest-safe, offline-safe); Drona
    LLM re-planning stays a coach feature later.
- Personalized naming/descriptions in coach voice ("Upper A - your bench day", short).
- Routine descriptions carry the plan rationale one line each (feeds the reveal).
- Verify: unit tests (every goal x experience x frequency x equipment combo produces
  frequency-many days, balanced patterns, all names resolve in EXERCISE_LIBRARY);
  create-and-start flow on sim for guest + signed-in; reverse-order invariant holds.

## Phase 4 - Welcome hero + ceremony (interlude, commitment, build)

Goal: the emotional screens; Overload-honest, Drona-voiced.

- Welcome hero (Cal AI pattern, our content): a looping muted demo of the REAL app
  inside a device frame (log a set, previous-performance prefill, Drona line), captured
  on the iOS sim via the ios-simulator MCP record_video, trimmed/compressed (H.265,
  a few MB), played with expo-video; poster frame fallback. Tagline underneath in
  coach voice (e.g. "Every rep counted. Every step planned."), Get started + Sign in.
  Re-capture is a repeatable script so the demo stays current as the app evolves.

- Drona interlude (one screen, after pace step): flat lime/dark Drona identity, 2-3
  lines on how the plan adapts ("I watch every rep. When you stall, I change the plan.").
  True product claims only. Skippable like everything else.
- Commitment: "Shake on it" tap-and-hold with a filling ring (Reanimated), success
  haptic on completion, then a dark celebration screen with restrained confetti
  (library, e.g. react-native-fast-confetti; lime + grayscale palette, not rainbow).
  Commitment text restates goal + date from Phase 2. Back/skip still available.
- Build moment: 2-3 s staged sequence driven by the REAL engine output (the engine
  runs instantly; we stage the reveal): "Choosing your split... Balancing pull and
  push... Setting fuel targets..." each line ticks when that artifact exists.
  No fake percentages beyond the stagger; keep it short and interruptible.
- Verify: on-device feel pass (haptics on physical device), reduced-motion fallback
  (skip confetti, instant build), Android back mid-ceremony.

## Phase 5 - Plan reveal redesign

Goal: the reveal reads as a contract with the coach, not a summary list.

- Structure (single scroll):
  1. Goal restated as a date headline ("Down 7 kg by Oct 23" / non-weight goals get
     a strength/consistency framing).
  2. Projected progress curve (simple SVG/Reanimated path, Now -> goal date; only
     for weight-direction goals).
  3. Your training: day cards from the engine (name, focus, N exercises; tap to
     preview via the existing RoutineDetailSheet pattern if cheap, else expand).
  4. Your fuel: kcal + macro chips, "edit anytime in Nutrition", one line about
     logging by typing (Drona Parse hook, one sentence, no demo).
  5. Your navigator: one Drona line ("I adjust this as we go") + Start button.
- "Create my plan" CTA writes routines + profile (existing paths), fires
  useSync().flushNow(), lands on dashboard where the Today card shows day 1.
- Verify: sim walk of all goal variants (weight-loss, gain, general/endurance
  no-curve variant), guest + signed-in, silent-failure toast path preserved.

## Phase 6 - Voice, a11y, analytics, polish

- Copy pass: every headline/subline in Drona's voice ("What are we training for?"),
  no em dashes, units formatted via the app's formatting helpers.
- A11y: labels/roles on pickers and sliders, 44 px targets, reduced-motion audit,
  contrast check both themes.
- Funnel analytics: PostHog events per step (view, answer, skip, back, complete)
  so drop-off per screen is measurable post-launch; completion event carries
  goal/frequency/equipment (no body stats in analytics).
- Perf: pickers virtualized, no jank on low-end Android; cold-start unaffected
  (onboarding route stays lazy).

---

## Animation & motion strategy (how each screen gets crafted)

Decided 2026-07-17 after tooling review. Order of preference:

1. **Code-first: Reanimated 3 + @shopify/react-native-skia** for everything interactive
   or data-driven. This is the bulk of the work and fully in-house (authorable and
   verifiable in this repo, on the sim): weight ruler, pace slider + live outcome card,
   projected-progress curve draw-in, commitment ring fill, build-moment sequence,
   number roll-ups, step transitions. Skia values accept Reanimated shared values
   directly and run on the UI thread (60-120 fps). NOTE: skia is a NATIVE dep ->
   dev-client rebuild needed (same drill as expo-haptics).
2. **Maintained libraries for solved problems** (feedback rule: don't hand-roll
   gesture physics): wheel picker (e.g. @quidone/react-native-wheel-picker),
   confetti (react-native-fast-confetti, Skia-based), expo-video for the hero demo.
3. **Lottie (lottie-react-native)** ONLY for decorative illustrative moments where
   drawing in Skia is poor value (e.g. the interlude's small flourish). Source from
   the LottieFiles marketplace (free tier first); recolor to token palette. No
   character mascots off the shelf - generic assets read cheap, which violates the
   premium bar; prefer none over stock-looking.
4. **Rive (rive-react-native)** - deliberately DEFERRED. Its state machines would be
   the right tool for an animated Drona character/identity, but authoring happens in
   the Rive editor (design work, not code). If we ever want it: commission a Rive
   artist (Rive community/marketplace) with our lime-bolt identity as the brief.
   Native module -> another dev-client rebuild. Not needed for this redesign.

Division of labor:
- I author and device-verify all of tier 1-2 and integrate tier 3.
- User intervention needed (ask before each): (a) approve adding native deps
  (skia now; lottie only if we use it) + the dev-client rebuilds on both platforms;
  (b) LottieFiles account/purchase if a paid asset wins; (c) physical-device passes
  to sign off haptic feel (sim has no Taptic Engine); (d) if we later go Rive,
  commissioning the artist.

## Explicitly out of scope

- Notification permission pre-prompt (locked out).
- Paywall/trial screen in onboarding (funnel stays: insights -> coach trial).
- Health/readiness teaser (connects contextually when readiness ships).
- Nutrition-preferences branch (diet style, meals/day): candidate for a separate
  first-open-of-Nutrition intake, not first-run.
- (REVERSED 2026-07-18: LLM plan generation is now IN scope, see Phase 3b. The
  deterministic engine remains as fallback + validator only.)
- Guest-side nutrition target store (unchanged from current behavior).

## Sequencing rationale

0 unlocks consistent iteration; 1 and 2 are the visible feel upgrades and are
independent; 3 is the substance the reveal depends on; 4 and 5 only land well once
3's real output exists; 6 hardens the whole. If time-boxed, the minimum coherent
ship is 0 + 2 + 3 + 5 (real customization + live math + honest reveal), with 1 and
4 as the next polish wave.

## Verification per phase (standing)

- tsc against the existing baseline after every phase.
- Sim walk via deep link `overload://onboarding` (gate skips existing accounts by
  design); drive with ui_describe_all, wait after taps (idb screenshot lag).
- Do NOT complete "Create my plan" on the real signed-in account (writes routines +
  overwrites profile targets in prod); finish flows as guest or a test account.
- Physical-device pass for haptic phases (1 and 4).
