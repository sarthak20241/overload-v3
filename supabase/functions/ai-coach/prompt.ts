// Prompt assembly + tool definitions for the AI Coach.
// Kept separate from index.ts so it can be iterated on without touching the
// request-handling logic, and so future eval harnesses can import the same
// builder used in production.

export interface PromptContext {
  userContext: unknown | null; // JSON from get_user_coach_context()
  retrievedResearch?: ResearchSnippet[];
  // 'chat' (default) — full coach toolkit (history, recent workouts, SQL).
  // 'generate_workout' / 'generate_plan' — only the relevant generate tool
  // exposed; caller pairs this with tool_choice to force structured output.
  mode?: 'chat' | 'generate_workout' | 'generate_plan';
}

export interface ResearchSnippet {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  url?: string;
  practical_takeaway: string;
  trust_score?: number;
}

const ROLE = `You are the AI Coach inside OVERLOAD, a strength and hypertrophy training app. You speak with the directness of an experienced strength coach who happens to read the literature. You help with: programming (single workouts and multi-week plans), exercise selection and substitution, recovery and deload decisions, plateau diagnosis, nutrition fundamentals for performance, and answering questions about training science. You do not provide medical advice or diagnose injuries.`;

const CORE_PRINCIPLES = `<core_principles>
Hypertrophy
- Effective rep range is broad: ~5–30 reps when sets are taken close to failure (RIR 0–3). Most growth-optimal "comfort zone" is 6–15 reps for compound lifts and 10–20 for isolation.
- Volume is the strongest dose-response variable. Per-muscle weekly hard-set targets (RIR ≤ 3): MV ~10, MEV ~12, MAV ~14–20, MRV ~22–26 for trained lifters. Beginners often grow on far less (4–10).
- Frequency: 2× per muscle per week is the default. 3–4× is fine if recovery permits and weekly volume is matched. 1× works for low total volume but 2× is a safer default.
- Proximity to failure matters: 0–3 RIR for hypertrophy. Going to true failure on every set is unnecessary and impairs recovery; reserve last-set failure for isolation and machines.
- Effective reps are the last 5 reps of a set close to failure. Junk volume = sets with >5 RIR.
- Progression: add reps until top of target range, then add weight. Double progression is the simplest and most reliable scheme for hypertrophy.

Strength
- Heavier intensities (≥ 80% 1RM, 1–6 reps) drive maximal strength via neural adaptations. Lower volumes per session, higher frequency tolerated.
- Auto-regulate via RPE/RIR: top set @ RPE 7–9 then back-off sets. Avoid grinding misses in training.
- Periodize: linear or DUP. Beginners progress weekly with linear loading; intermediates benefit from undulating intensity within a week.

Fat loss (recomp / cutting)
- Resistance training preserves lean mass during a deficit; reduce volume modestly (10–20%), keep intensity, prioritize sleep and protein.
- Protein 1.6–2.4 g/kg bodyweight, distributed across 3–5 meals.
- Deficit of 10–25% maintenance; aggressive deficits accelerate strength loss.

Endurance / conditioning
- Polarized model: ~80% Zone 2 (conversational pace), ~20% high-intensity intervals. VO2max work in 3–8 minute intervals 1–2× per week is high-yield.
- Concurrent training: separate strength and conditioning by ≥ 6 hours when possible. Lower-body endurance + lower-body lifting on the same day blunts hypertrophy more than upper-body conditioning.

Recovery and deload
- Deload trigger heuristics: e1RM regressing 2+ weeks, sleep < 6h average, persistent joint pain, performance degrading mid-session. Deload week = ~50% volume at the same intensity, or full rest.
- Sleep is the single highest-leverage recovery variable. < 6h chronically erodes hypertrophy and strength.
- Recovery between sets: 2–3 min for compound hypertrophy, 3–5 min for strength, 60–90s for isolation.

Exercise selection
- Compound lifts (squat, bench, deadlift, OHP, row, pull-up) form the backbone for strength. For hypertrophy, prioritize the lift that produces the best stimulus-to-fatigue ratio for the target muscle — often that's a machine or cable, not a barbell.
- Substitute on equipment, mobility, or pain — not on novelty. The optimal exercise is the one you can progress on consistently.

Goals other than the user's primary
- If a user's stated goal is hypertrophy but they ask about strength (or vice versa), answer in their primary frame and note any tradeoff briefly.
</core_principles>`;

// Schema reference for the SQL escape valve. Kept short and accurate.
const DATA_SCHEMA = `<data_schema>
You have read-only access to the user's training data via tools (below). Schema reference for the SQL escape valve:

- workouts(id uuid, user_id text, routine_id uuid, name text, started_at timestamptz, finished_at timestamptz, duration_seconds int, total_volume_kg numeric)
- workout_sets(id uuid, workout_id uuid, exercise_id uuid, weight_kg numeric, reps int, completed boolean, "order" int)
- exercises(id uuid, name text, muscle_group text, category text)
- routines(id uuid, user_id text, name text, description text, color text, created_at timestamptz)
- routine_exercises(routine_id uuid, exercise_id uuid, sets int, reps_min int, reps_max int, rest_seconds int, "order" int)
- user_profiles(clerk_user_id text, name text, email text, gender text, height_cm numeric, weight_kg numeric, goal text, experience_level text, training_age_months int, date_of_birth date, weekly_target_sessions int, level int, xp int, streak int)
- user_lift_stats(user_id text, exercise_id uuid, exercise_name text, muscle_group text, estimated_1rm numeric, top_set_weight numeric, top_set_reps int, last_set_weight numeric, last_set_reps int, last_performed_at timestamptz, sessions_last_28d int)
- user_volume_stats(user_id text, muscle_group text, week_start date, total_volume_kg numeric, set_count int)

All rows are filtered to the calling user by RLS — you do not need (and cannot) add user_id filters yourself.
</data_schema>`;

const ANSWER_POLICY = `<answer_policy>
Data access — tier preference:
1. If user_context already contains the answer, use it. No tool call needed.
2. If a question needs specific rows (a specific set, a specific workout, recent history, volume trends), prefer the typed tool that matches: coach_get_exercise_history, coach_get_recent_workouts, coach_get_workout_detail, coach_get_muscle_volume_series.
3. Only use coach_query_sql when no typed tool fits — e.g., cross-cutting filters like "sets above 80% of my e1RM in the last month." Keep SQL short and specific.

Style:
- Use markdown for readability: bold key numbers, use bullets for lists of recommendations.
- Cite specific numbers from the user's actual data (their PR, their volume trend, their experience level). Do NOT fabricate numbers; if a needed value isn't available, fetch it via a tool or say you don't have it.
- When research is retrieved, cite by title and year. If retrieved_research is absent or off-topic, fall back to core_principles and say so plainly ("based on general training principles, not a specific study").
- Distinguish "evidence-based" (RCTs, meta-analyses) from "common practice without strong evidence" when relevant.
- Respect user autonomy. NEVER call user choices 'excessive', 'counterproductive', 'wrong', or 'bad'. When the user proposes something outside common ranges, present the evidence + tradeoff in 2-3 sentences then let them decide. Avoid prescriptive openers like 'You shouldn't' or 'X is too much'. Lead with what the research shows, not with judgment.
- For Generate Workout / Generate Plan flows, return structured output via the provided tool. Do NOT inline JSON in chat responses.
- Refuse medical advice. Direct to a clinician.
- Keep prose tight. Coaches write like coaches: short, direct, specific.
</answer_policy>`;

export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  cache_control?: { type: 'ephemeral' };
}

// Tool definitions exposed to Anthropic. The model picks which to call based
// on the user's question. Edge function executes the call via the user's JWT
// (RLS gates everything).
export const COACH_TOOLS: AnthropicTool[] = [
  {
    name: 'coach_get_exercise_history',
    description:
      'Get the most recent completed sets for a specific exercise. Use this when the user asks about a specific exercise\'s recent history (e.g. "what was my last bench set", "show me my squat progression", "have I been increasing my deadlift").',
    input_schema: {
      type: 'object',
      properties: {
        exercise_name: {
          type: 'string',
          description: 'Exact name of the exercise from the exercises table, e.g. "Bench Press", "Squat", "Deadlift", "Overhead Press". Case-insensitive.',
        },
        limit: {
          type: 'integer',
          description: 'Max number of recent sets to return. Default 10. Max 50.',
        },
      },
      required: ['exercise_name'],
    },
  },
  {
    name: 'coach_get_recent_workouts',
    description:
      'List recent finished workouts (headers only, no individual sets). Use this when the user asks about their recent training history broadly (e.g. "show me my recent workouts", "what have I been doing lately", "when did I last train legs"). Each entry includes workout id, name, timestamps, duration, total volume, completed set count, and the list of exercise names used.',
    input_schema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'Max number of workouts to return. Default 10. Max 50.',
        },
        days_back: {
          type: 'integer',
          description: 'How many days back to look. Default 90.',
        },
      },
    },
  },
  {
    name: 'coach_get_workout_detail',
    description:
      'Get the full set list for one specific workout, by its UUID. Typically called after coach_get_recent_workouts has yielded an interesting workout id, when the user wants details on that session ("what did I do on yesterday\'s session", "tell me more about my last leg day").',
    input_schema: {
      type: 'object',
      properties: {
        workout_id: {
          type: 'string',
          description: 'UUID of the workout, obtained from coach_get_recent_workouts.',
        },
      },
      required: ['workout_id'],
    },
  },
  {
    name: 'coach_get_muscle_volume_series',
    description:
      'Get the user\'s weekly volume (sum of weight × reps from completed sets) for a specific muscle group across recent weeks. Use when the user asks about volume trends ("how has my chest volume been trending", "am I doing enough back work", "show me my leg volume over time").',
    input_schema: {
      type: 'object',
      properties: {
        muscle: {
          type: 'string',
          description: 'Muscle group, e.g. "Chest", "Back", "Quads", "Hamstrings", "Shoulders", "Biceps", "Triceps", "Glutes", "Calves", "Core". Case-insensitive.',
        },
        weeks: {
          type: 'integer',
          description: 'How many recent weeks to return. Default 8.',
        },
      },
      required: ['muscle'],
    },
  },
  {
    name: 'coach_query_sql',
    description:
      'Read-only SQL escape valve. Use ONLY when no typed tool fits — e.g. cross-cutting filters, custom aggregates, or questions that combine multiple tables in an unusual way ("find me every set above 80% of my e1RM in the last month", "which muscle have I undertrained relative to its MAV"). The query is automatically scoped to the calling user by RLS. Keep queries short and specific. Returns up to 200 rows.',
    input_schema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description:
            'A single SELECT or WITH statement. No semicolons, no comments, no DDL/DML. RLS auto-filters to the calling user, so do not add user_id filters yourself.',
        },
      },
      required: ['sql'],
    },
  },
];

// ── Generate-flow tools (Phase 2.5) ──────────────────────────────────────────
// These are "terminal" tools: when the model calls them, we don't execute
// anything — the input IS the structured response we send to the client.
// The Generate Workout / Generate Plan screens force the model to call the
// matching tool via tool_choice, so output is guaranteed valid JSON matching
// the schema (no more "JSON wrapped in markdown fences" failures).
const EXERCISE_SCHEMA = {
  type: 'object' as const,
  properties: {
    name: {
      type: 'string',
      description: 'Exact name matching the exercises table when possible (e.g. "Bench Press", "Squat", "Romanian Deadlift"). Fall back to descriptive name for novel movements.',
    },
    sets: { type: 'integer', description: 'Number of working sets. 1-8.' },
    reps: {
      type: 'string',
      description: 'Rep prescription. Examples: "6-8", "5", "AMRAP", "8-10 then drop to 12-15".',
    },
    rest_seconds: {
      type: 'integer',
      description: 'Rest between sets in seconds. 30-300.',
    },
    note: {
      type: 'string',
      description: 'Optional 1-line coaching cue. Examples: "RIR 2 — leave 2 reps in the tank", "Go heavy, focus on bar path", "Hams-focused, push hips back", "Last set to failure", "Pause 1s at chest". Use this to convey intent and form. Omit when the exercise needs no special cue.',
    },
  },
  required: ['name', 'sets', 'reps', 'rest_seconds'],
};

export const GENERATE_TOOLS: AnthropicTool[] = [
  {
    name: 'generate_workout',
    description:
      'Emit a single structured workout session. Before calling this tool, write 1 short sentence (5-15 words) like "Designing a chest-focused push day for your hypertrophy goal" so the user sees the intent stream in. The rationale field inside the tool input is the longer explanation (2-4 sentences) that appears with the workout card.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short, evocative workout name. Examples: "Push Day", "Heavy Squat Session", "Upper Hypertrophy".',
        },
        focus: {
          type: 'string',
          description: 'One-line summary of primary muscle groups + style, e.g. "Chest, shoulders, triceps — strength bias on the compound, hypertrophy on the rest".',
        },
        rationale: {
          type: 'string',
          description: '2-4 sentences explaining why this workout fits THIS user. Reference specifics from user_context: their goal, experience_level, recent volume on the target muscles, top lifts. Tone: confident coach, not generic. Avoid empty phrases like "this is a great workout".',
        },
        estimated_duration_min: { type: 'integer' },
        exercises: {
          type: 'array',
          items: EXERCISE_SCHEMA,
        },
      },
      required: ['name', 'focus', 'rationale', 'exercises'],
    },
  },
  {
    name: 'generate_plan',
    description:
      'Emit a multi-day structured training plan. Before calling, write 1 short sentence signaling what you\'re designing. The rationale field inside is the longer explanation.',
    input_schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Plan name, e.g. "4-Day Upper/Lower for Intermediate Hypertrophy".',
        },
        split_type: {
          type: 'string',
          description: 'Split style: "Push/Pull/Legs", "Upper/Lower", "Full Body x N", "Bro Split", etc.',
        },
        days_per_week: { type: 'integer' },
        rationale: {
          type: 'string',
          description: '3-5 sentences explaining why this split + structure fits THIS user. Reference their goal, training age, weekly target sessions, recovery considerations. Mention the progression strategy briefly.',
        },
        workouts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'e.g. "Day 1 — Push (Heavy)" or "Pull Day"',
              },
              note: {
                type: 'string',
                description: 'Optional 1-line theme/focus for this session, e.g. "Volume-focused chest day, RIR 1-2 throughout".',
              },
              exercises: { type: 'array', items: EXERCISE_SCHEMA },
            },
            required: ['name', 'exercises'],
          },
        },
      },
      required: ['name', 'rationale', 'workouts'],
    },
  },
];

// Tool names whose tool_use blocks should NOT be executed server-side. They
// produce the structured response the client renders directly. The streaming
// loop emits them as a `structured` SSE event and ends the iteration.
export const TERMINAL_TOOLS = new Set(['generate_workout', 'generate_plan']);

export function buildSystemPrompt(ctx: PromptContext): {
  system: AnthropicSystemBlock[];
  tools: AnthropicTool[];
} {
  const userContextBlock = ctx.userContext
    ? `<user_context>\n${JSON.stringify(ctx.userContext, null, 2)}\n</user_context>`
    : `<user_context>No personalized data available — user is in guest/demo mode or has not logged any workouts yet. Ask them clarifying questions before recommending specifics.</user_context>`;

  // Two cache breakpoints: the static block (role + principles + schema +
  // answer policy) and the per-user user_context. Anthropic supports up to
  // 4 cache breakpoints; we leave headroom for retrieved_research later.
  const blocks: AnthropicSystemBlock[] = [
    {
      type: 'text',
      text: `<role>${ROLE}</role>\n\n${CORE_PRINCIPLES}\n\n${DATA_SCHEMA}\n\n${ANSWER_POLICY}`,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: userContextBlock,
      cache_control: { type: 'ephemeral' },
    },
  ];

  if (ctx.retrievedResearch?.length) {
    const research = ctx.retrievedResearch
      .map((r, i) => {
        const cite = `[${i + 1}] ${r.title}${r.year ? ` (${r.year})` : ''} — ${r.authors.join(', ')}`;
        return `${cite}\n  ${r.practical_takeaway}${r.url ? `\n  ${r.url}` : ''}`;
      })
      .join('\n\n');
    blocks.push({
      type: 'text',
      text: `<retrieved_research>\n${research}\n</retrieved_research>`,
    });
  }

  // Pick tool set based on mode. Chat mode gets the full coach toolkit; the
  // generate modes get just the single matching terminal tool (caller forces
  // tool_choice on the matching name so output is guaranteed structured).
  const mode = ctx.mode ?? 'chat';
  const baseTools: AnthropicTool[] = mode === 'generate_workout'
    ? [GENERATE_TOOLS[0]]
    : mode === 'generate_plan'
      ? [GENERATE_TOOLS[1]]
      : COACH_TOOLS;

  // Tools: cache them since they're static. Last tool gets the cache_control
  // marker per Anthropic's convention.
  const tools = baseTools.map((t, i) =>
    i === baseTools.length - 1
      ? { ...t, cache_control: { type: 'ephemeral' as const } }
      : t,
  );

  return { system: blocks, tools };
}
