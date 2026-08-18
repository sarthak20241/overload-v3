# Body Distribution (Hevy-style muscle heatmap) — Plan

Status: BUILT 2026-08-17, verified on the iOS sim. Not committed.
Branch: `claude/analytics-body-distribution-chart-756357`

## What shipped

- `components/ui/BodyHeatmap.tsx` — front + back bodies, lime ramp, scale
  caption, legend.
- `app/(app)/analytics.tsx` — card retitled "Body Distribution", donut gone,
  `muscleCounts` now returns raw counts, `profileGender` added.
- `react-native-body-highlighter@3.2.0` added to package.json.

Verified on iPhone 17 Pro sim: dark + light themes, male + female silhouettes,
all four ramp steps, legend dots matching body fills, and the real one-set
account (only Chest lit, everything else neutral).

### Finding that changed the design

`defaultFill` is a dead prop for our purposes. The library ships a hard-coded
`color` on every asset part (`#3f3f3f` muscles, `#bebebe` head) and
`getColorToFill` returns that before it ever falls back to `defaultFill`. Left
alone, untrained muscles render dark charcoal and the head light grey — fine on
dark, wrong on the light theme. Fix: pass **every** slug in `data` with an
explicit `styles.fill`, which is the only key that outranks the asset colour.
That is why `ALL_SLUGS` exists and why `intensity`/`colors` are unused.

### Follow-up flagged, not done

`components/ui/MiniDonutChart.tsx` and `Colors.muscle` now have zero callers.
Spawned as a separate cleanup task rather than bundled here.

## Goal

Replace the Muscle Split donut on the Analytics page with a front + back
body silhouette. Each muscle is shaded by how many sets trained it. Same
data, better picture. This is what Hevy calls "Muscle distribution".

## Decision (locked)

- 2D SVG, not 3D. 3D needs three.js + expo-gl + a GPL body model. Too heavy,
  wrong license, days of work.
- Library: `react-native-body-highlighter@3.2.0` (MIT, SVG only, Expo OK,
  last release 2026-04, uses `react-native-svg` which we already ship).
- Keep the legend list next to the body. Keep the same card slot.

## Library facts (verified from the package)

- Component: `<Body data colors side gender scale border defaultFill defaultStroke hiddenParts />`
- `data`: `{ slug, intensity, side?: 'left'|'right' }[]`. `intensity` is a
  1-based index into `colors`.
- `side`: `'front' | 'back'`. `gender`: `'male' | 'female'`.
- Slugs (23): abs, adductors, ankles, biceps, calves, chest, deltoids, feet,
  forearm, gluteal, hair, hamstring, hands, head, knees, lower-back, neck,
  obliques, quadriceps, tibialis, trapezius, triceps, upper-back.
- `dist/` is ~200 KB. No native code. No new pod install.

## Muscle group → slug map

| Our `muscle_group` | Slugs |
|---|---|
| Chest | chest |
| Back | upper-back, lower-back, trapezius |
| Shoulders | deltoids |
| Quads | quadriceps |
| Hamstrings | hamstring |
| Biceps | biceps |
| Triceps | triceps |
| Calves | calves |
| Core | abs, obliques |
| Glutes | gluteal |
| Full Body | spread: 1 set → every mapped slug above gets +0.5 |

Non-muscle slugs (head, hair, neck, hands, feet, knees, ankles, tibialis,
forearm, adductors) stay at `defaultFill`.

## Colour scale

Sets per group → intensity 1..4 (relative to the busiest group in range):

- 0 sets → `defaultFill` (light grey `C.borderSubtle`-ish)
- >0 to 25% of max → lime at 25% opacity
- 25–50% → 50%
- 50–75% → 75%
- 75–100% → full `Colors.primary` (#c8ff00)

Use lime tints on a grey body. One hue, calm. Fits [[feedback_design_aesthetic]].
Body outline: `defaultStroke = C.card` (or none), `border = 'none'`.

## Steps

1. Install: `npx expo install react-native-body-highlighter` (from the main
   checkout, then re-symlink node_modules into the worktree per
   project_worktree_node_modules).
2. New file `components/ui/BodyHeatmap.tsx`:
   - Props: `counts: Record<string, number>` (muscle_group → sets),
     `gender?: 'M'|'F'|'O'|null`, `height?: number`.
   - Builds `data[]` via the map above. Renders two `<Body>` side by side
     (front, back), same scale, `gender` = 'female' if 'F' else 'male'.
   - Memoised. Pure. No hooks besides `useMemo`.
3. `app/(app)/analytics.tsx`:
   - Change `muscleData` memo to also return the raw `counts` object
     (drop the `.slice(0, 6)` for the body; keep top-6 for the legend).
   - Replace `<MiniDonutChart .../>` at the Muscle Split card with
     `<BodyHeatmap counts={counts} gender={profile?.gender} />`.
   - Rename title "Muscle Split" → "Body Distribution".
   - Legend dots: keep the per-muscle `Colors.muscle[...]` colour so the
     legend still tells muscles apart. Body uses lime scale only.
   - Read gender from the loaded profile if analytics already has it; else
     default male. Do not add a new fetch for this.
4. Remove `MiniDonutChart` import if nothing else uses it in that file
   (`components/ui/MiniDonutChart.tsx` stays; other screens may use it).
5. Verify on the iOS sim: light theme, empty state (no sets → card hidden as
   today), one-group state (only chest lit), full state. Screenshot for PR.
6. Commit with `[skip eas]`. Open PR against `main`.

## Out of scope

- Tapping a muscle to filter exercises (nice later; `onBodyPartPress` exists).
- Time-range picker for the body (analytics has none today).
- Per-side (left/right) shading. Our data has no side info.
- 3D model.

## Risks

- Package uses `react-native-svg` internally; we have 15.12.1. Verify it does
  not pin its own copy (peer deps list only react + react-native, so it
  should resolve to ours). If a duplicate `react-native-svg` appears in the
  lockfile, add a `resolutions`/`overrides` entry.
- Female body path set is a separate SVG. Check both render at the same
  scale in a 2-up row on a 375 pt wide screen (target ~120 pt each).
