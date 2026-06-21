# Overload — Design Polish Plan (Final)

Status: FINAL, ready to execute. Feature work (exercise/set types) is PAUSED; Phase 0 (preferences
foundation) already shipped and is verified on device. This plan is the active workstream.

Grounded in: a 7-surface code critique, a live iOS-simulator tour (guest mode, dark), ~10 retina
screenshots covering every main screen (both light and dark), and a senior UI/UX critique. All
surfaces have now been confirmed visually, light mode included.

The bar for every decision: the app should look like a professional studio designed it. In practice
that means consistency and restraint over more design, color that means something, one coach with one
face and one voice, feedback that is felt and not just seen, and both themes fully resolved.

---

## 1. North star: one story, one narrator, one path

The story: you bring a goal, and Coach Drona navigates the whole journey for you, planning the path,
constantly analyzing, and adjusting as the data changes, so your only job is to show up and follow.
The user is the trainee hero; Drona is the navigator (not just a commentator who notices things after
the fact). Every screen and every word should ladder into that one story, and the rough edges that
break the spell get removed.

The emotional job of the design is therefore "tell me what to do, and show me you are on top of it,"
not "show me my numbers." That reframes the coach from a feature into the protagonist, and justifies
making it the most prominent thing on the dashboard.

## 2. Who we are designing for (the use context)

A committed, goal-driven optimizer. They track lifts, yes, but more than that they have a goal and
want to optimize every part of the journey. They want a system that takes care of everything and
navigates the path so they can just follow it. So they are at once a data geek who wants every detail
AND someone who wants to outsource the thinking. The app is constantly analyzing in the background.

The decisive fact is still the moment of use: standing at a rack, one hand, glancing for a second or
two between sets, sometimes sweaty. Rules that follow, and most decisions ladder back to them:
- Glanceability beats density (the number they need is the loudest thing).
- Touch beats sight (feedback should be felt; they are not looking closely).
- The coach is the navigator and present training partner, not a feature.
- Lead with the decision, not the data. The loudest thing is the next action ("Today: X, here is
  why"), not raw stats. Minimize decisions; the user follows the path.
- Make the constant analysis felt. Surface adjustments with reasoning so the user trusts the path is
  intelligent and current.
- Resolve the optimizer-vs-follower tension with progressive disclosure: lead with the calm directive
  next-step; tuck the full analysis one tap deeper. Same "hide complexity until sought" principle as
  the feature work, so the whole product has one philosophy: the app decides; the depth is there if
  you want it.

Scope note: making the app FEEL like a navigator (framing, hierarchy, voice, surfacing the path,
making analysis feel alive) is this plan's job. The actual adaptive-programming engine that truly
re-plans everything is a separate future FEATURE workstream; this plan leans on what already exists
(plan/workout generation, plateau detection, goal targeting).

---

## Pillar A — Lock the color system (do first; biggest "amateur tell" removed)

Today several color languages compete: brand lime, an analytics categorical palette, a muscle-donut
rainbow, a profile data-icon rainbow, the purple/teal coach gradient, and semantic colors. Worse,
the SAME metric (Volume) is blue on the dashboard (#3b82f6 hardcoded) and cyan on analytics
(Colors.stat.volume #06b6d4 token). Lock four roles and guard them:

1. Lime #c8ff00 = the single hero accent (action, achievement, coach). Nothing decorative gets lime.
2. Grayscale = structure (background, cards, elevated).
3. ONE data-viz palette (the analytics cyan/purple/teal/orange set) used identically everywhere.
4. Semantic red/amber = status only.

Concrete fixes:
- Volume = one color everywhere (kill dashboard #3b82f6 vs analytics #06b6d4).
- One progress-bar accent across XP / level / goal (today lime vs blue-cyan vs orange).
- Pull stray colors into theme.ts tokens: MUSCLE_COLORS, ROW_ICON_COLORS (profile, 12 hex), the
  calendar intensity (#84cc16 / #facc15 / #a3e635), AMBER (#fbbf24), inline #ef4444 -> Colors.danger.
- Tone the muscle-donut and profile data-icon rainbows toward the locked palette (or monochrome the
  profile data icons and let only active toggles carry lime).
- theme.ts additions: `colorWithAlpha(hex, a)` helper, an `IconSize` scale (xs 11 / sm 14 / md 16 /
  lg 20 / xl 24) to enforce the compact convention, optional `ZIndex` scale.
- Replace magic spacing numbers (gap:10, paddingTop:10) with the Spacing scale.

## Pillar B — The coach: one face, one voice (highest perception lever; low risk)

Drona currently has four visual identities: a purple/teal gradient hero on the dashboard, a lime pill
on routines, a flat star card on analytics, a lime FAB on the workout. And tapping the gradient card
opens a flat, lime coach menu, so the door does not match the room. The on-brand lime/flat identity
already exists everywhere the coach actually lives; the dashboard gradient is the lone exception.

- Navigator framing (from the expanded vision): the coach is the route-setter, so the dashboard leads
  with "what do I do today" — delivered by ELEMENT 2 (today's suggestion card). "Coach noticed" stays
  as the reactive observations strip (plateaus, PRs), demoted below it, as proof the analysis is live;
  its top insight can feed today's-suggestion reasoning (shown in the session preview). The bolt pulse
  signals a fresh adjustment, which earns trust that the path is current.
- Coach on the dashboard = TWO stacked, SEPARATE cards (FINAL = Prototype 2; supersedes every earlier
  layout idea — the single-adaptive-card, the two-feature-with-buttons, and the today-row-inside-the-
  coach-card / "Prototype 1"):
  ELEMENT 1 — Coach card (the coach: identity + value + capabilities + access). Flat/lime, gradient
  killed. Contents: lime bolt + "Coach Drona" (+ NEW for new users), tappable -> coach hub; the value
  tagline KEPT in its place ("Knows every rep, every PR", muted, under the name); a capability-pills
  footer (Chat / Quick Workout / Full Plan) that advertises the coach's RANGE and is the engaged user's
  door to chat / build routine / build workout / ask progress. For new/trial users the card can lead
  with "Build my plan" (value + trial-conversion surface). NO Start/action button lives in this card
  (only the capability pills).
  ELEMENT 2 — Today's suggestion card (a SEPARATE lean card directly BELOW Element 1). Lime-bordered,
  tappable, NO buttons in it: "TODAY · <session>" + a tiny meta ("9 exercises · 55 min") + a chevron.
  Three states: (a) planned routine workout; (b) REST DAY (calm, moon, "Rest day, recover" — the app
  optimizes recovery too, which builds trust); (c) a new coach-built workout ("built for you"). Tapping
  the card OPENS today's session preview.
  SESSION PREVIEW = the EXISTING routine-detail sheet (exercise list + Edit + Start Workout); ADD an
  "Ask Drona" action to it. That sheet is where every verb lives: SEE the full workout, UPDATE/edit it,
  DISCUSS it with Drona, or START it. So neither dashboard card carries action buttons (beyond the
  capability pills); see / update / discuss / start are all one tap deeper, on the session itself.
  Why Prototype 2 (separate) over Prototype 1 (today's row inside the coach card): the daily directive
  earns its own clear hero element and the coach card stays cleanly about the coach; total footprint is
  close and each element is lean.
  The coach MENU (screenshot-3 sheet) is the hub for all capabilities; strengthen it ("Your strength
  training coach" undersells).
- Coach ACCESS placement (FINAL, user decided): keep the coach hero (Feature 1) on the DASHBOARD only,
  NOT on every screen (the earlier every-screen idea was reverted). The dashboard is home base; Feature
  1 there is how the engaged user reaches the coach for anything. In-session, the workout screen's
  existing "⚡ Coach" FAB covers access. Restraint over spraying the coach across every header.
- Dashboard IA reflow (folds into P2): the dashboard currently duplicates the tabs (Recent Workouts +
  week ~ History, Volume/Muscles ~ Analytics). Principle: the dashboard is "what do I do today + a
  glance at where I am," delegating depth to the tabs. Order: (1) header/identity compact; (2) coach
  card (Element 1) then today's-suggestion card (Element 2); (3) "Coach noticed" kept but demoted
  (proof analysis is live; its top insight can feed today's-suggestion reasoning); (4) progress glance
  (week strip + compact Volume/Muscles); (5) Recent Workouts trimmed to one / moved to History.
- Identity: DECIDED. Define ONE coach signature (the lime bolt mark + one flat container). Kill the
  gradient and repaint the dashboard card into the lime/flat language of its own menu. Confirmed by
  light mode, where the gradient collapses into a washed pastel smudge and the action pills vanish,
  while every flat/lime coach surface stays crisp in both themes. Apply the signature consistently on
  the dashboard card, the coach modal, the workout FAB, the routines AI entry, and analytics insights.
  (Dashboard layout resolved above = Prototype 2: a separate coach card + a separate today's-suggestion
  card. The single-adaptive-card and the A/B prototypes are superseded.)
- Voice: Drona is warm, second-person, direct, no em dashes. The AI GENERATES em dashes today (every
  per-exercise routine note uses one), so the rule must live in the coach system prompt
  (supabase/functions/ai-coach/prompt.ts) to fix generated notes, plans, and chat at once.
- Personality micro-touch: the coach bolt pulses softly when "Coach noticed" has unread insights.
- Honesty: analytics "Insights from Coach Drona" (analytics.tsx:1284) is template tips from the user's
  own stats with a fake 1200ms delay. DECIDED: wire it to the REAL coach (the edge function), so the
  insights are genuine. Remove the fake delay; show a real loading state while the model responds.

## Pillar C — Copy and voice system

- One-page voice guide: who Drona is, 5 do/don't rules, before/after examples. The rest card
  ("Recovering before set 3") and workout notes placeholder ("How did that feel? Jot it down.") are
  the reference tone; match it everywhere.
- No em dashes anywhere, including model output (Pillar B prompt rule).
- Number/unit formatting system: define abbreviation thresholds, decimal rules, and unit display so
  the app stops mixing "168t", "3.4k", "53.3k", "5831.5kg", "1h 9m". Tabular figures for any number
  that changes live (already on the timer; extend it).
- Sweep clinical strings into coach voice: history empty ("No workouts logged yet"), workout
  "Previous: 60kg x 8 reps", the save-as-routine meta copy, analytics weight prompt, etc.

## Pillar D — Micro-interactions and motion (the crafted layer; requires expo-haptics)

This is the indie-to-professional jump, and the gym context makes tactile feedback a requirement, not
a nicety. APPROVED. Prerequisite: install `expo-haptics`. Motion uses `react-native-reanimated`
(already in). Rest-timer SOUND would need `expo-audio` (optional, defer).

- Haptics map: set complete = light; new PR = success; toggle/tab change = selection; weight stepper =
  one tick per press; rest done = success (plus sound later).
- Set commit: logging a set animates (subtle scale + check) instead of just appearing.
- PR celebration (live): lime pulse + success haptic + the PR badge animating in. No confetti
  (reads cheap); restraint plus one strong accent reads premium.
- Rest-timer card: transition color on "done" + gentle pulse as it nears zero + haptic, not the
  current instant snap.
- Number roll-ups: stat values (Volume, XP, totals) count up on appear (extend the XP-bar pattern).
- History card expand: smooth height change + chevron rotation.
- Press states: primary buttons scale(0.97) on press; stepper supports hold-to-repeat.
- Coach insights: bolt pulse on new; insight cards enter with a subtle stagger.
- Branded pull-to-refresh.
- Warm empty states: the empty routines screen is a lot of black; let Drona offer to build one
  ("No routines yet. Want me to build one?").

## Pillar E — Light/dark parity

Light mode is the weaker twin (dark-first, light ported). Fix:
- Inactive pill borders (borderLight rgba 0,0,0,0.06) nearly invisible on cream; ~0.12 or a muted fill.
- primarySubtle (0.05) too faint to read as a state (calendar "today", coach callout); strengthen or
  use primaryBorder / a left accent stripe.
- Light textSecondary (#78716c on #f7f6f1) borderline WCAG AA; audit and darken if it fails.
- Chart tooltip hardcoded dark (MiniAreaChart) -> theme-aware.
- CONFIRMED via light-mode screenshots (2026-06-18): light theme (cream bg + white cards) is overall
  solid. Casualties: (1) the coach gradient card collapses to a washed pastel smudge and its pills
  nearly vanish — the single strongest reason to kill the gradient (Pillar B). (2) The 5 lime Routines
  play circles are even louder as lime blobs on white (accent inflation worse in light; Pillar G).
  (3) Green "Coach noticed"/"Analyze" text is a touch low-contrast on cream. (4) Calendar "today" ring
  is faint. (5) Muscle donut goes pastel (softer, fine).

## Pillar F — Accessibility (usable mid-set, one-handed)

Not a checkbox; it is "can a tired person use this between sets."
- Touch targets to 44px: profile rows (~28-32), gender/experience pills (~20), history/routines 28px
  action buttons (borderline even with hitSlop).
- accessibilityLabel on icon-only buttons (dashboard start/avatar, profile chevrons + bug close, coach
  quick picks, routine actions).
- Contrast pass on delta/success/danger text in both themes; guest badge 8px -> >= 10.

## Pillar G — Visual rhythm and continuity

- Consistent card padding/density; one default activeOpacity (document exceptions).
- Shared screen transitions so navigation feels like turning pages (audit Stack animations + sheet
  easings for consistency).
- Routines: 5 stacked bright-lime Play circles inflate the accent; make per-card play quieter
  (smaller / lime-on-press) and let the card be the tap target.
- Clarify or remove the center-FAB red dot.
- Soften the coach "Upgrade, 48 days left" trial banner until near expiry.
- Long-session timer overflows ("588:34"); roll into hours.
- History: add a legend entry for the unexplained yellow calendar dots; spell out "168t".

---

## Verified / parked

- VERIFIED on device: the profile "Workout Settings" row and the workout "Workout settings" link both
  land well; the workout top bar is a clean cancel/timer/Finish triad with no gear.
- Bodyweight "0kg x 20 / best 0kg" in expanded history reads like a bug; this is concrete evidence for
  the PAUSED exercise-types feature. Remember when we resume it (not in this plan's scope).

## Execution order

1. **P1 — Color system lock + token hardening (Pillar A). DONE + verified on device 2026-06-21
   (type-clean, 0 new errors).** theme.ts gained `IconSize`, `colorWithAlpha`, and
   `Colors.muscle` / `Colors.rowIcon` / `Colors.calendar` / `Colors.paused`. Migrations: dashboard
   (two-blues Volume + Muscles now `Colors.stat.*`; `MUSCLE_COLORS` -> `Colors.muscle`), profile
   (`ROW_ICON_COLORS` -> `Colors.rowIcon`), history (calendar -> `Colors.calendar` via `colorWithAlpha`),
   workout + BottomNav (`AMBER` + amber tints -> `Colors.paused`), analytics (semantic diff/trend
   `#ef4444`/`#10b981` -> `Colors.danger`/`Colors.success`; goal label -> `Colors.warning`).
   Design calls applied + verified on the simulator: muscle donut TONED (cohesive pastels), all
   progress bars LIME (level + goal; tier colour stays on the tier badge), profile data icons
   MONOCHROME (muted; only active toggles lime). Coach-card gradient intentionally left for P2.
   DEFERRED (low value / by design): IconSize ADOPTION sweep — NOT done on purpose (snapping existing
   11/12/13/15/18px icons onto the 5-step scale would RESIZE them, i.e. a visual change, not a pure
   refactor; the scale is available for new code). Minor leftover tints (delete `#f87171`, workout
   diff-badge shades, the rgba danger/success badge backgrounds) + magic-spacing -> backlog.
2. **P2 — Coach identity + dashboard layout + voice (Pillars B + C voice rule).** Highest perception
   lever. STARTED 2026-06-21: coach card REPAINTED to the flat/lime signature + verified on device —
   gradient + glow orbs killed; solid lime bolt tile (dark bolt), lime-tint "NEW" badge, neutral pills
   with lime icons, subtle lime border (C.primaryBorder), flat C.card bg. Removed the unused
   LinearGradient import + isDark/mode + the dead orb styles + overridden purple style defaults. The
   card now matches its own (flat/lime) menu. type-clean.
   VOICE RULE DONE + DEPLOYED 2026-06-21 (LIVE): added a WRITING_STYLE no-em-dash rule to
   ai-coach/prompt.ts + wired it in; de-dashed the persona few-shots, the tool-field output examples
   (exercise note, focus summary, day name), and the behavior-block example outputs. Deployed via
   `supabase functions deploy ai-coach --project-ref rjmmslierxhvwdjgjilb` (CLI, not MCP — MCP would
   require inlining 85KB of source = corruption risk; CLI deploys exact files + reads verify_jwt=false
   from config.toml so Clerk auth is preserved). RUNTIME OUTPUT VERIFIED 2026-06-21 by the user (signed in):
   coach output now has no em dashes. Instruction-prose / JS-comment em dashes remain in prompt.ts (low
   priority; the rule + de-dashed examples are sufficient since the user confirmed clean output).
   COACH MENU strengthened 2026-06-21 (type-clean): AICoachModal menu subtitle "Your strength training
   coach" -> "Knows every rep and PR you've logged. Ask, plan, or build." (value-communicating).
   REMAINING P2:
   - Element 2 = today's-suggestion card [the big one; a real build]. Needs: (a) fetch the user's
     ROUTINES on the dashboard (index.tsx currently has workouts only, not the routine list) with guest
     support; (b) a "today's pick" heuristic [DECISION: simplest = most-recently-used / next routine,
     pure polish, no AI; real adaptive pick = the separate feature workstream]; (c) the lean
     lime-bordered TodaySuggestionCard (states planned/rest/new) below the coach card; (d) tapping ->
     the routine-detail sheet (reuse routines.tsx's sheet) + ADD "Ask Drona" to it.
     STATUS 2026-06-21: (a) routines fetch, (b) heuristic, (c) card, (d-placement) DONE + verified on
     sim. Card rebuilt LEAN (~2-line row). FINAL layout (2026-06-21): the today card LEADS ABOVE the
     coach card (it is the primary action -> lead with the directive), HIGHLIGHTED by a soft LIME TINT
     fill (C.primaryMuted) + faint lime edge (C.primaryBorder); NEUTRAL icon tile (C.muted) so it stays
     legible on the tint. Highlight-treatment history: solid-lime tile/chunky card = "too bright"
     (rejected) -> bright lime outline = "looks odd" (rejected) -> soft lime TINT fill = accepted. Stats
     stay ABOVE "Coach noticed" (user rejected raising insights above the stats).
     TASK #5 DONE + verified on sim 2026-06-21: extracted the routine-detail sheet to a shared component
     components/routines/RoutineDetailSheet.tsx (used by routines.tsx AND the dashboard). onEdit +
     onAskCoach are OPTIONAL props. Dashboard 'planned' tap opens the sheet (Ask Drona + Start Workout,
     NO Edit -> editing lives in Routines). Ask Drona opens the coach chat seeded with "Walk me through
     my <routine> session..."; verified the real coach streamed a context-aware reply. Start Workout ->
     router.push('/workout/<id>'). NOTE: coach OUTPUT still emits em dashes (e.g. "Bench — 3x8") despite
     the deployed WRITING_STYLE rule -> address in #7 (prompt strengthen or client/edge post-process).
   - Dashboard reflow (DONE + verified): final order = header -> week calendar -> TODAY card (Element 2,
     primary action, lime outline) -> coach card -> stats (Volume/Muscles) -> "Coach noticed" -> Recent
     Workouts (capped at 3). NOTE: "Coach noticed" stays BELOW the stats (raising it above the stats was
     tried and rejected by the user).
   - Wire analytics "Insights from Coach Drona" to the real coach edge fn (drop fake delay); verify
     signed-in.
   - Static copy sweep.
3. **P3 — Micro-interactions + haptics (Pillar D).** Install expo-haptics; the crafted feel.
   STATUS 2026-06-21 (v1 DONE + verified on sim): expo-haptics ~15.0.8 installed; lib/haptics.ts
   wrapper (lazy/defensive require so it no-ops on a dev client without the native module, no crash;
   map: tap/tick/selection/success/warning/error). Wired: BottomNav tab change (selection), workout
   set-complete (tap) + steppers (tick) + start (tap) + finish (success), WorkoutSettingsSheet toggle
   (selection). Primitives: components/ui/PressableScale.tsx (Reanimated 0.97 press-scale + haptic) and
   components/ui/AnimatedNumber.tsx (RAF count-up). Applied: dashboard Start button + TodaySuggestionCard
   (PressableScale), dashboard Volume (AnimatedNumber count-up). Verified on sim: app boots clean, count-
   up renders, press-scale cards open, tabs switch (haptics no-op on sim/this build, no crash).
   CAVEAT: expo-haptics is NATIVE -> to FEEL haptics the dev client must be REBUILT (npx expo run:ios or
   EAS dev build) and run on a physical device (sim has no Taptic Engine). v1 is UNCOMMITTED.
   P3 REMAINING (task #11): rest-done haptic + rest-card color/pulse; PR celebration (lime pulse + badge);
   set-commit anim (scale+check); analytics stat-grid roll-ups; history card expand; branded pull-to-
   refresh; warm empty states (Drona offers to build); coach bolt pulse on new insight.
4. **P4 — Number/unit formatting system (Pillar C).**
5. **P5 — Light-mode parity (Pillar E).** Light mode confirmed via screenshots.
6. **P6 — Accessibility pass (Pillar F).**
7. **P7 — Rhythm and continuity cleanups (Pillar G).**

P1 and P2 are the right opening: lowest risk, biggest gain in how professional the app reads.

## Decisions (locked 2026-06-18)

- Analytics insights: WIRE to the real coach. (done)
- Coach visuals: lime/flat signature, kill the gradient. (done)
- Coach dashboard layout: Prototype 2 — a separate coach card + a separate today's-suggestion card; the
  today card is a lean tappable strip that opens the session preview (see / edit / discuss / start live
  there). (done)
- Micro-interactions + haptics: APPROVED; add expo-haptics. (done)
- Light mode: screenshots received and analyzed; Pillar E confirmed. (done)

No open items. Ready to execute (start P1).
