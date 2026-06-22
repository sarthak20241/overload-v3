# Hyperframes Composition Brief: Overload

## Objective
Create a short, clean app-store-style launch brag video for **Overload**, a
gamified strength-training tracker. Recreate the app's real UI (dark theme,
lime-on-black) and make every beat a number climbing.

## Output
- Composition directory: `brag-output-2026-06-22-073037/composition/`
- Rendered video: `brag-output-2026-06-22-073037/brag.mp4`
- Format: vertical — 1080x1920
- Duration: 20s (scenes sum to 20: 3 + 5 + 4 + 4.5 + 3.5)

## Source Material
- Project root: `/home/user/overload-v3`
- Primary files read: `app/(app)/index.tsx` (dashboard), `constants/theme.ts`
  (design tokens), `lib/xp.ts` (XP/level tiers)
- Product name: **Overload**
- Tagline / strongest claim: "Your coach. Knows every rep, every PR." (in-app);
  brag tagline "Lift. Level up. Repeat."
- Key UI to recreate: the dashboard (XP/level bar, weekly calendar, VOLUME +
  MUSCLES stat cards), the Coach Drona hero card, the recent-workout PR row.
- Copy that must appear verbatim:
  - OVERLOAD
  - Good morning · Athlete
  - Coach Drona · NEW
  - Your coach. Knows every rep, every PR.
  - VOLUME · MUSCLES
  - Push Day · PR ×2 · +45kg
  - LEVEL UP · ATHLETE
  - Every rep counts. · Lift. Level up. Repeat.

## Creative Direction
- Tone preset: app-store
- Creative direction: "gym-app launch — lime-on-black, every rep levels you up"
- Interpretation: clean feature-card reveals, smooth slides/wipes, confident
  pacing; energetic but never messy. Numbers climbing carry the energy, not
  flashing text. Restraint on chrome; lime accent + real UI do the talking.
- Angle: The name *is* the pitch. Progressive overload — add a little every week
  — made visible: every set makes a number go up. Volume, PRs, streak, XP, your
  level (Beginner → Athlete → Legend). A lifting app that feels like a game in a
  sharp lime-on-black identity.
- Hook: Black screen; OVERLOAD slams in; a lime XP bar sweeps to full; LV 12 chip
  pops; "Every rep counts." settles.
- Outro / punchline: XP bar snaps full → LEVEL UP flash → ATHLETE 🏆 → resolve to
  OVERLOAD wordmark + "Lift. Level up. Repeat."
- Avoid:
  - Generic SaaS language ("streamline your fitness journey" — banned)
  - Abstract filler visuals / particle washes
  - Redesigning the app — match the real tokens below

## Visual Identity
- Background: `#0a0a0a`
- Card: `#1c1c1e`; muted surface `#242428`; border `rgba(255,255,255,0.14)`;
  subtle border `rgba(255,255,255,0.10)`
- Text: `#ffffff`; secondary `#a1a1aa`; dim `#6a6a72`; muted `#8a8a93`
- Accent: `#c8ff00` (lime); text-on-lime `#0a0a0a`; lime-muted
  `rgba(200,255,0,0.10)`; lime-border `rgba(200,255,0,0.20)`
- Coach card gradient: `#a855f7 → #3b82f6`; Volume chart `#3b82f6`; Muscles donut
  `#ec4899`; success/delta green `#10b981`; calendar/routine lime `#84cc16`
- Display font: heavy grotesk (Inter / SF-style, 800–900). Body: same family,
  400–600. Match the app's black-weight headings and level numbers. Use a
  bundled/Google webfont (e.g. Inter) — do not depend on a live network at render.
- Visual references: lime XP bar on near-black; pill-shaped lime LV chip; weekly
  calendar of filled lime dots; rounded dark stat cards with a soft colored glow
  in one corner; lime PR award pill; green "+kg ↑" delta with a trending-up icon.

## Storyboard
Use `brag-output-2026-06-22-073037/brag-plan.md` as the creative contract.

Scene summary:
1. Hook / wordmark + XP bar — 3s — OVERLOAD slams in; lime XP bar sweeps full;
   LV 12 chip; "Every rep counts."
2. The real dashboard — 5s — phone frame: "Good morning / Athlete" + XP bar,
   weekly calendar dots, then VOLUME (blue area chart) and MUSCLES (donut) cards
   arrive one by one.
3. Coach Drona — 4s — purple→blue AI hero card slides up: "Coach Drona" + NEW,
   "Your coach. Knows every rep, every PR.", chips Chat · Quick Workout · Full Plan.
4. Progressive overload payoff — 4.5s — "Push Day" row; lime PR ×2 badge pops;
   green +45kg ↑ delta; big lime volume number ticks up.
5. Level up + outro — 3.5s — XP bar snaps full; LEVEL UP flash; ATHLETE 🏆;
   resolve to OVERLOAD + "Lift. Level up. Repeat."

## Audio
- Audio role: warm rhythmic bed with clean, motion-matched accents (app-store polish)
- Audio arc: lifts off on the hook bar-fill → steady groove as the dashboard
  assembles → lifts into Coach Drona → peaks on the PR payoff → resolves on a
  clean LEVEL UP accent that rings over a gentle fade under the wordmark.
- Music: `assets/music/happy-beats-business-moves-vol-11-by-ende-dot-app.mp3`
- Music treatment: start at 0; confident level under UI; fade under the final
  wordmark so the closing lime accent rings out.
- Music cue guidance: bundled preset
  `assets/music/happy-beats-business-moves-vol-11-by-ende-dot-app.music-cues.json`
  (~114.84 BPM). Strong cues: 1.60, 3.70, 5.80, 8.96, 12.65, 17.91, 22.65s.
  Lock ~3: hook bar-fill ≈1.60s, Coach card ≈8.96s, PR payoff ≈12.65s (and
  LEVEL UP ≈17.91s if it helps). Beat grid ≈0.52s apart for one-by-one cards.
- Audio-reactive treatment: subtle — lime glow / XP-bar presence breathes with
  music energy. No waveform/equalizer/note graphics.
- Audio-coupled moments:
  - Scene 1 XP bar fill — rising tick; soft accent on LV chip (beat ≈1.60s)
  - Scene 2 stat cards — light card sound per arrival (beat-grid)
  - Scene 3 Coach card — soft slide whoosh; tick per chip (beat ≈8.96s)
  - Scene 4 PR badge — bright announcement cue; counter ticks on count-up (≈12.65s)
  - Scene 5 LEVEL UP — clean accent; final lime hit rings over fade (≈17.91s)
- SFX selection guidance: use the skill's bundled SFX at
  `~/.claude/skills/brag/assets/sfx/` (ui switch/click for ticks, a brighter cue
  for the PR/LEVEL UP payoffs). Match sound to motion; keep it sparse/moderate.
- SFX analysis guidance: if `~/.claude/skills/brag/assets/sfx/sfx-analysis.md`
  exists, prefer low high-frequency-risk files for repeated ticks.
- Exact SFX choice: Hyperframes chooses filenames/timestamps/density after the
  animation exists. Copy chosen SFX into `composition/assets/`.
- Audio files: music already copied to
  `composition/assets/music/`. Copy any selected SFX into `composition/assets/sfx/`.

## Hyperframes Instructions
Use the current `hyperframes` skill and CLI workflow (product-launch-video is the
matching domain skill). Prefer native Hyperframes conventions over anything in
`/brag`.

Requirements:
- Show real UI from Overload (Scenes 2 & 4 recreate actual app screens).
- Keep all text readable in the final render (hold the hook line, the Coach
  subline, and the PR/delta to their reading floors — see plan).
- Keep total duration 15–25s (target 20s).
- Include the music + SFX layer; fade music under the final wordmark.
- Treat audio notes as guidance; choose SFX after the animation exists.
- Lock 1–3 major tweens to strong cues (≈1.60 / 8.96 / 12.65 / 17.91s) within
  ±0.15s; snap one-by-one card reveals to consecutive beats (±0.10s); never snap
  readable text so fast it outruns reading.
- Wire at least one subtle audio-reactive element (lime glow / XP-bar presence);
  no waveform bars. If extraction is unavailable, document it and skip — don't block.
- Use local assets only; no live-network runtime deps.
- Run `npx hyperframes lint` (zero errors), then `validate` and `inspect`, fix
  contrast/overflow, then render to `../brag.mp4`.
