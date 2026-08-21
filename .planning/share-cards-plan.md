# Share Cards — Body Distribution + Workout Recap

Status: PLAN, 2026-08-18. Not built.
Owner: implementation to be done by a separate session/model. This doc is
the brief. Follow it; deviate only where the code proves it wrong, and say so.

## Goal

Let a user turn (1) the Body Distribution card and (2) a finished workout into
a story-sized image and share it (Instagram Stories, WhatsApp, Save Image)
through the system share sheet. One render pipe, two card templates.

## Locked decisions

- **Two cards first**: `body` (Body Distribution) and `recap` (Workout Recap).
  Weekly Wrap / PR / Streak later, same pipe.
- **System share sheet**, not save-to-Photos. `expo-sharing` gives Instagram,
  WhatsApp and Save Image in one tap. No Photos permission prompt.
- **Story size only** for v1: 1080x1920 (9:16). Instagram also accepts this
  as a post (it crops). Square 1080x1080 is a follow-up.
- **Off-screen render** with `react-native-view-shot` `captureRef`. The
  template renders once, invisibly, at story dimensions; we never resize the
  on-screen card.
- **Always dark**. Share cards ignore the app theme. Dark bg + lime reads on
  every feed and looks like Overload. Light theme users still get the dark
  card.
- **Native build required.** `react-native-view-shot` and `expo-sharing` are
  native modules. Ship in the next store binary; do NOT OTA onto old binaries
  ([[project_eas_ota_hotfix_playbook]]). Guard the button so an old binary
  never crashes: if the module fails to import, hide the share button.

## Design (base)

Design pillars carry over: mature, calm, bold, restrained lime, one hue,
coach voice, no em dashes ([[feedback_design_aesthetic]],
[[feedback_ui_copy_coach_voice]], [[feedback_no_em_dashes]]).

### Canvas

- 1080 x 1920 px. Everything below in px at that size.
- Background `#0a0a0a` (`Colors.dark.background`). Optional very soft radial
  lime glow behind the hero (`rgba(200,255,0,0.06)`, radius ~700, centred on
  the hero). Skip if it looks muddy.
- Safe zones for Stories: keep content out of the top 250 px and bottom
  300 px (IG overlays profile pill + reply bar there). Layout below respects
  this.
- Font: Space Grotesk (already loaded via `useFonts` in `app/_layout.tsx`;
  `SpaceGrotesk_700Bold` for numbers, `SpaceGrotesk_500Medium` for labels).
- Colours: foreground `#ffffff`, muted `#8a8a93`, lime `#c8ff00`, ramp
  `RAMP_DARK` from `components/ui/BodyHeatmap.tsx`, untrained `#2c2c31`,
  outline `rgba(255,255,255,0.16)`.
- Corners: 0. It is a full-bleed story, not a card inside a card.

### Common layout (both templates)

```
y  250  ┌──────────────────────────────┐  eyebrow: "BODY DISTRIBUTION" or
        │ EYEBROW (muted, 34px, +2.5)  │  "WORKOUT RECAP", letterspaced caps
y  310  │ Headline (white, 72px bold)  │  coach line, max 2 lines
        │                              │
y  520  │ ┌──────────────────────────┐ │
        │ │         HERO             │ │  body silhouettes / recap stats
        │ │   (≈1080 x 900)          │ │
        │ └──────────────────────────┘ │
y 1440  │ stat row: 3 tiles           │  big number 96px bold, label 30px muted
        │                              │
y 1620  │ [ optional user line ]       │  "@handle" or first name, muted 30px
y 1560  │ ─────────────────────────── │  hairline rgba(255,255,255,0.10)
y 1600  │ Overload wordmark  · date   │  bottom-left wordmark 32px, right date
        └──────────────────────────────┘
```

Wordmark: text "Overload" in Space Grotesk 700, white, with a 12px lime dot
after it. No app icon PNG for v1 (keeps it self-contained). Right-aligned on
the same baseline: window label ("This week", "12 Aug") in muted.

Max 3 numbers on the card. Anything more is noise on a phone feed.

### Template A: `body` (Body Distribution)

Data: `counts: Record<string, number>` (sets per muscle group, same input as
`BodyHeatmap`), `gender`, `windowLabel` ("This week" / "Last 30 days"),
optional `name`.

- Eyebrow: `BODY DISTRIBUTION`
- Headline (coach voice, pick by data):
  - one dominant group (>40% of sets): `"{Group} did the work."`
    (e.g. "Chest did the work.")
  - balanced (top group <30%): `"Nothing skipped."`
  - default: `"Where the sets went."`
- Hero: front + back silhouettes side by side, centred, `Body` from
  `react-native-body-highlighter`, `scale` ≈ 2.1 (200x400 base → ~420x840
  each; two + 60 gap = 900 wide, fits). Same fill logic as `BodyHeatmap`:
  every slug gets an explicit `styles.fill` (library ignores `defaultFill`,
  see the comment on `ALL_SLUGS`). Labels "Front" / "Back" under each, muted.
- Ramp legend under the hero, centred: `Less ▪▪▪▪ More`, swatches 44x16.
- Stat row: top 3 muscle groups. Tile = group name (label) + set count
  (number) + a 12px dot in that group's ramp colour. If fewer than 3 groups
  trained, show what exists; never pad with zeros.
- Footer: wordmark · windowLabel.

Do this by **exporting the pure pieces** from `BodyHeatmap.tsx` rather than
copying: `GROUP_SLUGS`, `ALL_SLUGS`, `RAMP_DARK`, `buildScale`. Add a small
`buildBodyData(counts, ramp, untrained): ExtendedBodyPart[]` helper there
and use it in both the on-screen card and the share template.

### Template B: `recap` (Workout Recap)

Data: `name` (workout title), `startedAt`, `durationSeconds`,
`totalVolumeKg`, `setCount`, `exerciseCount`, `prCount` (may be 0 or
unknown), `counts` (sets per muscle group for THIS workout), `gender`,
optional `userName`.

- Eyebrow: `WORKOUT RECAP`
- Headline: the workout name ("Push Day"). If empty, "Workout done."
- Sub-line under headline (muted 34px): `"{exerciseCount} exercises · {date}"`
- Hero: ONE body silhouette (front only, `scale` ≈ 2.0, centred) shaded by
  this workout's `counts`. If `counts` is empty (cardio-only, custom groups),
  hero becomes a big single stat instead: volume number at 200px.
- Stat row: `Volume` (`{n} kg`, use `roundVolume`), `Sets`, `Time` (`{m}m`).
  If `prCount > 0`, replace `Sets` with `PRs` and put a lime dot on it. PRs
  are the brag; sets are not.
- Coach line (one, muted, above footer, optional): pick by data
  - `prCount > 0`: `"{prCount} new PR{s}. Keep it moving."`
  - `durationSeconds < 30 min`: `"In and out. Still counts."`
  - default: `"Logged. Onward."`
- Footer: wordmark · date (`12 Aug`).

## Architecture

```
lib/share/
  captureAndShare.ts      captureRef(view, {format:'png', width:1080, height:1920,
                          quality:1}) → temp file → Sharing.shareAsync(uri,
                          {mimeType:'image/png', dialogTitle:'Share'}).
                          Guards: Sharing.isAvailableAsync(); try/catch → toast.
  shareCopy.ts            headline/coach-line pickers (pure, unit-testable).
components/share/
  ShareCanvas.tsx         1080x1920 dark canvas + eyebrow/headline slot/
                          stat row/footer. Children = hero.
  BodyShareCard.tsx       template A, uses ShareCanvas
  RecapShareCard.tsx      template B, uses ShareCanvas
  ShareSheet.tsx          the visible UI: bottom sheet (Portal, NOT <Modal>,
                          see project_bottom_sheets_portal + useSheetSlide)
                          showing a scaled-down PREVIEW of the card
                          (transform scale ≈ 0.28) + "Share" button.
                          Renders the full-size card OFF-SCREEN
                          (position:'absolute', left:-4000, opacity 0 is
                          NOT enough on Android; use collapsable={false} and
                          keep it fully painted) and captures that.
```

Preview and capture use the SAME component instance for the full-size card
so what the user sees is what they get; the preview is a scaled `View`
wrapper of a second instance is acceptable if perf hurts, but keep props
identical.

`captureRef` needs the target mounted and laid out. Await one
`requestAnimationFrame` (or `InteractionManager.runAfterInteractions`)
after the sheet opens before enabling the Share button, or capture lazily on
press with a short retry if the ref is null.

## Entry points

1. **Analytics → Body Distribution card**: add a small share icon
   (`Feather "share"`, 14px, muted, in the card header row next to the
   title, matches the compact icon scale in CLAUDE.md). Opens `ShareSheet`
   with `BodyShareCard` fed by `muscleCounts` + `profileGender` already in
   `app/(app)/analytics.tsx`. Window label: analytics has no range picker
   today; label it by the range the query uses (check `sinceIso` in the
   workouts fetch and pass the matching label; if it is "all history", say
   "All time").
2. **Workout finish**: after save, the app does `router.replace('/(app)/history')`
   (`app/workout/[id].tsx` ~2344/2350). There is no post-finish celebration
   screen. Two options; pick **(a)**:
   - (a) In `history.tsx`, on the expanded workout row, add a "Share" action
     (icon in the row header, or a button at the bottom of the expanded
     section). Works for every past workout too, not just the one just
     finished. Data is already there (`WorkoutRow` + `ExerciseDetail`).
     Gap: `ExerciseDetail` has no `muscle_group` today; the history select
     joins `exercises(name, metric_type)`. Add `muscle_group` to that embed
     (and to the guest/pending adapters so all three sources match, see the
     comment at `history.tsx:54-67`) so the recap can build `counts`.
   - (b) A post-finish "Done" screen with the card. Bigger UX change, out of
     scope for v1; note it as the future upgrade since it is where Strava
     gets its share rate.
   Also add the same share action to the finish sheet summary
   (`finishStatsRow` at `[id].tsx` ~3737) is tempting but the workout is not
   saved yet at that point; skip for v1.

PR count for the recap: there is no per-workout PR detection helper in
`lib/` today (analytics computes `personalRecords` inline at
`analytics.tsx:1313`). v1: `prCount` = 0 / hidden unless a cheap helper
already exists by the time you build. Do not build PR detection inside this
task.

## Dependencies

```
npx expo install react-native-view-shot expo-sharing
```
Run from the main checkout, then re-symlink `node_modules` into the worktree
([[project_worktree_node_modules]]). Both need `npx expo prebuild`/a dev
client rebuild; the existing sim dev client will NOT have them. Test on a
fresh dev build.

## Steps

1. Install deps, rebuild dev client, confirm `Sharing.isAvailableAsync()` on
   the sim (share sheet exists on sim; Instagram will not, "Save Image" will).
2. Refactor `BodyHeatmap.tsx`: export `GROUP_SLUGS`, `ALL_SLUGS`, `RAMP_DARK`,
   `buildScale`, add `buildBodyData`. No visual change. Verify analytics still
   renders the same.
3. `ShareCanvas` + `BodyShareCard`. Render it on-screen temporarily inside a
   `ScrollView` at 0.3 scale to iterate on layout. Screenshot at real size via
   `captureRef` to a file and open the PNG; check safe zones and text sizes.
4. `captureAndShare` + `ShareSheet` (Portal + `useSheetSlide`), wire to the
   analytics card icon. Test dark and light app themes (card must stay dark).
   Test M and F silhouettes. Test the one-set account (only Chest lit).
5. History: add `muscle_group` to the embed + adapters, `RecapShareCard`,
   share action on the expanded row. Test a cardio-only workout (empty
   counts → big-number hero) and a normal one.
6. Old-binary guard: wrap the native imports in try/require or feature-flag
   by `Constants.expoConfig.runtimeVersion`; button hidden if unavailable.
7. Commit `[skip eas]` (this needs a store build anyway). PR. Screenshots of
   both cards in the PR body.

## Copy bank (coach voice, no em dashes)

Body:
- "Chest did the work."  "Legs did the work."  "Back did the work."
- "Nothing skipped."
- "Where the sets went."

Recap:
- "Logged. Onward."
- "In and out. Still counts."
- "2 new PRs. Keep it moving."
- "Workout done." (fallback headline)

## Out of scope (v1)

- Square 1080x1080 variant.
- Weekly Wrap, PR, Streak cards (same pipe, later).
- Post-finish celebration screen.
- Instagram direct deep-link (`instagram-stories://share`); the system sheet
  covers it and avoids the FB app-id + pasteboard dance.
- Light-theme card variant.
- Custom photo backgrounds.

## Risks

- `captureRef` on Android needs the off-screen view actually rendered
  (`collapsable={false}`, non-zero size, not `display:none`). Opacity 0 views
  can be culled; use `left: -4000` positioning instead.
- Space Grotesk at 1080 px wide: check letter spacing on the eyebrow; it can
  look loose. Tune, do not switch fonts.
- Body silhouette at ~2x scale: SVG paths are fine, but check the stroke
  (`border`) does not become hairline-thin; bump the outline alpha to 0.22
  if needed at that size.
- `react-native-svg` inside `captureRef`: works on both platforms, but the
  capture must happen after the SVG has painted; the RAF wait in ShareSheet
  covers it.
