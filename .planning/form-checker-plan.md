# Form Checker (Drona Eyes) - Plan and build log

Status: **P0 to P2 + P4 BUILT, not yet run on a device** (2026-08-17). Branch
`claude/exercise-form-checker-a04282`.

Option A locked: pose runs ON THE PHONE, only per-rep angle summaries go to the
server, Drona writes the coach note from those numbers. No video, no frames and
no keypoints ever leave the device.

Design principle: one story, one narrator (Drona). The screen shows a skeleton
and at most one live cue; the payoff is a short note in coach voice, not a data
dump.

## Locked decisions

- **Pose on device, feedback from angles.** Per-rep angle summaries (~1 KB JSON)
  go to the `form-check` edge function. Haiku 4.5 turns them into a note. Well
  under $0.01 per check. Live mode never calls the server.
- **Rules are DATA, not code.** This is what makes the feature cover ~800 global
  exercises plus the open-ended tail Drona invents mid-workout. Every exercise
  carries a `movement_pattern`; the app ships a rule template per pattern; a
  per-exercise `form_rules` jsonb overrides it. Adding an exercise never needs an
  app build. See `lib/form/spec.ts` for the schema.
- **The score is deterministic, computed on device.** The model is handed the
  number and writes prose about it. Two identical sets must score identically.
- **Rep thresholds generous, cue thresholds strict.** A partial rep still counts
  and then gets flagged as shallow. If the rep threshold demanded depth, a sloppy
  set would show zero reps and read as the app being broken.
- **v1 model = MoveNet SinglePose (17 keypoints, TFLite).** Not BlazePose: every
  MediaPipe RN wrapper found (EndLess728, cdiddy77, thinksys, gymbros,
  expo-pose-landmarks) targets VisionCamera v4 + `react-native-worklets-core`,
  which collides with Reanimated 4's `react-native-worklets` on Android.
- **VisionCamera v5 (Nitro).** Uses `react-native-worklets`, so no worklets
  conflict. Verified after install: `react-native-worklets-core` is absent.
- **Model fetched at first use, not bundled.** Changed from the original plan.
  Keeps ~12 MB out of the app binary and out of git, and avoids a hard `require`
  of an uncommitted file breaking the Metro bundle for the whole app.
- **Metered for free users, not Pro-gated.** Form check is a retention hook. It
  branches before the paid Drona gate with its own daily bucket, like parse_meal.
  3/day free, 20/day paid.
- **Honest refusals.** Wrong camera angle, too much occlusion, or no complete rep
  produce a plain "I could not see that", never invented feedback. Spinal
  rounding is explicitly NOT detectable with 17 keypoints, so no rule claims to.
- **No em dashes.** All copy in Drona's voice.

## What exists now

### Pure logic, fully tested (54 cases, `npx tsx tools/form-eval/run.ts`)
| File | Job |
|---|---|
| `lib/form/keypoints.ts` | COCO-17 vocabulary, MoveNet decode (y first), mirroring |
| `lib/form/geometry.ts` | Angles, torso-relative gaps, side detection, EMA smoothing |
| `lib/form/spec.ts` | The FormRuleSpec schema + a validator that rejects untrusted specs |
| `lib/form/engine.ts` | Generic rule interpreter: rep phase machine, cue evaluation |
| `lib/form/patterns.ts` | 9 movement-pattern templates + name-based classification |
| `lib/form/summarize.ts` | The ~1 KB payload + the deterministic 0-100 score |
| `lib/form/resolve.ts` | The rule-resolution ladder |
| `lib/form/model.ts` | Derives input spec from model metadata; validates the model |
| `tools/form-eval/` | Synthetic skeleton generator + the suite |

### Native / UI (written, NOT yet run on a device)
| File | Job |
|---|---|
| `lib/form/modelFile.ts` | Downloads + verifies the model on first use |
| `components/form/useFormSession.ts` | Model, frame processor, engine, live state |
| `components/form/PoseOverlay.tsx` | Skia skeleton off a SharedValue |
| `app/form-check.tsx` | The screen: resolve, setup, record, analyse, result |
| `lib/form/videoFrames.ts` | Upload-path frame sampling (module only, no UI yet) |

### Server
| File | Job |
|---|---|
| `supabase/migrations/0101_form_check.sql` | Columns, backfill, `form_checks`, rate limit |
| `supabase/functions/form-check/index.ts` | `analyze` + `author_rules` modes |
| `supabase/config.toml` | `verify_jwt = false` for the new function |

## The rule-resolution ladder

How any exercise gets rules, cheapest first. Only step 5 costs money.

1. `exercises.form_rules` on the row (curated, or authored on a past check)
2. Same-named GLOBAL row's rules (catches AI copies of catalog lifts)
3. `exercises.movement_pattern` template
4. Name guess to pattern template (free, covers most of the catalog)
5. Ask Drona to author a spec, validated then cached to the row
6. Refuse honestly

Everything learned is written back, so an exercise is paid for at most once.
Specs are re-validated on every read, so a bad spec in the database can never be
acted on.

## Dependencies added

`react-native-vision-camera@5.2.2`, `-worklets`, `-resizer`,
`react-native-fast-tflite@3.0.1`, `react-native-nitro-image`,
`expo-image-picker`, `expo-video-thumbnails`. Plus `tflite` in
`metro.config.js`, camera permissions in `app.json` (CAMERA removed from
`blockedPermissions`; RECORD_AUDIO stays blocked, we never record sound).

## Remaining

1. **Apply migration 0101** via Supabase MCP, then mirror into `schema.sql`.
   Never `db push`. Verify the backfill: `select movement_pattern, count(*) from
   exercises group by 1`.
2. **Deploy the edge function.** Add a `model_pricing` row if Haiku 4.5 is absent.
3. **Native dev build.** Not OTA: four new native modules.
4. **P0 device spike.** Measure fps on iOS and a mid Android. If under 15,
   fall back to MoveNet Lightning (the code already adapts to the model's own
   input spec, so this is a URL change).
5. **Tune thresholds against real footage.** Every number in `patterns.ts` is
   reasoned, none is validated against real lifters yet. This pass MUST also
   fix the seven unreachable "top"-sampled cues (`noLockout` x5, `noStretch`,
   `shortRange`): `rep.top` currently gates rep completion more strictly than
   the cue meant to catch a short lockout, and `atTop` is captured at the
   threshold crossing rather than at the true peak, so the cue cannot fire and
   a lifter who does not lock out is told no rep was seen at all. The header
   comment in `patterns.ts` has the full diagnosis. Both halves have to change
   together: fixing the thresholds alone gives false positives, fixing the
   capture alone leaves the cues dead.
6. **Upload UI (P3).** `videoFrames.ts` exists; picker, trim, and progress do not.
7. **Coach context.** Feed the last few `form_checks` into ai-coach.
8. **Analytics + store copy.** PostHog events, privacy nutrition label.

## Known limitations, deliberate

- **Spinal rounding is undetectable** with 17 keypoints. No rule claims otherwise.
- **Side view only** in v1. Knee valgus needs a front view and is not implemented.
- **Name classification is regex.** "Jefferson Curl" would read as a biceps curl.
  Leg curl and leg extension are special-cased; the ladder lets a curated or
  authored spec override anything wrong.
- **Front-camera mirroring** is implemented but unverified on a device.

## Sources (checked 2026-08-17)
- VisionCamera v5: https://margelo.com/blog/whats-new-in-visioncamera-v5
- Releases (v5.2.2, 2026-08-05): https://github.com/mrousavy/react-native-vision-camera/releases
- fast-tflite: https://github.com/mrousavy/react-native-fast-tflite
- Pose demo: https://mrousavy.com/blog/VisionCamera-Pose-Detection-TFLite
- Reanimated 4 vs worklets-core: https://github.com/mrousavy/react-native-vision-camera/issues/3563
- MoveNet: https://www.tensorflow.org/hub/tutorials/movenet
- ffmpeg-kit retired: https://www.itpathsolutions.com/ffmpegkit-shutdown-what-to-do-next
