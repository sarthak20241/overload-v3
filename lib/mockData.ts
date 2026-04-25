/**
 * Mock data for guest mode UI visualization.
 * Used when Supabase is not configured or returns empty data.
 */

// --- Exercises ---
const exercises = {
  benchPress:   { id: 'ex-1',  name: 'Bench Press',       muscle_group: 'Chest',      category: 'Barbell' },
  squat:        { id: 'ex-2',  name: 'Barbell Squat',     muscle_group: 'Quads',      category: 'Barbell' },
  deadlift:     { id: 'ex-3',  name: 'Deadlift',          muscle_group: 'Back',       category: 'Barbell' },
  ohp:          { id: 'ex-4',  name: 'Overhead Press',    muscle_group: 'Shoulders',  category: 'Barbell' },
  pullUp:       { id: 'ex-5',  name: 'Pull-ups',          muscle_group: 'Back',       category: 'Bodyweight' },
  barbellRow:   { id: 'ex-6',  name: 'Barbell Row',       muscle_group: 'Back',       category: 'Barbell' },
  latPulldown:  { id: 'ex-7',  name: 'Lat Pulldown',      muscle_group: 'Back',       category: 'Cable' },
  legPress:     { id: 'ex-8',  name: 'Leg Press',         muscle_group: 'Quads',      category: 'Machine' },
  dbCurl:       { id: 'ex-9',  name: 'Dumbbell Curl',     muscle_group: 'Biceps',     category: 'Dumbbell' },
  tricepPush:   { id: 'ex-10', name: 'Tricep Pushdown',   muscle_group: 'Triceps',    category: 'Cable' },
  lateralRaise: { id: 'ex-11', name: 'Lateral Raise',     muscle_group: 'Shoulders',  category: 'Dumbbell' },
  legCurl:      { id: 'ex-12', name: 'Leg Curl',          muscle_group: 'Hamstrings', category: 'Machine' },
  calfRaise:    { id: 'ex-13', name: 'Calf Raise',        muscle_group: 'Calves',     category: 'Machine' },
  cableFlye:    { id: 'ex-14', name: 'Cable Fly',         muscle_group: 'Chest',      category: 'Cable' },
  plank:        { id: 'ex-15', name: 'Plank',             muscle_group: 'Core',       category: 'Bodyweight' },
};

// --- Helper to create dates relative to today ---
function daysAgo(n: number, hour = 10, min = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
}

function makeSets(
  items: { exercise: typeof exercises.benchPress; weight: number; reps: number; sets: number }[],
) {
  let order = 0;
  return items.flatMap(({ exercise, weight, reps, sets }) =>
    Array.from({ length: sets }, (_, i) => ({
      id: `set-${exercise.id}-${order + i}`,
      exercise_id: exercise.id,
      exercises: exercise,
      weight_kg: weight + (i === sets - 1 ? -5 : 0), // slight drop on last set
      reps: reps - (i === sets - 1 ? 1 : 0),
      completed: true,
      order: order++,
    })),
  );
}

function volumeFromSets(sets: ReturnType<typeof makeSets>) {
  return sets.reduce((s, set) => s + set.weight_kg * set.reps, 0);
}

// --- Workouts (last ~3 weeks) ---
function buildWorkouts() {
  const workoutDefs = [
    {
      name: 'Push Day',
      daysAgoVal: 0, hour: 9,
      duration: 3840, // 64 min
      items: [
        { exercise: exercises.benchPress,   weight: 85, reps: 8,  sets: 4 },
        { exercise: exercises.ohp,          weight: 50, reps: 8,  sets: 3 },
        { exercise: exercises.cableFlye,    weight: 15, reps: 12, sets: 3 },
        { exercise: exercises.lateralRaise, weight: 12, reps: 12, sets: 3 },
        { exercise: exercises.tricepPush,   weight: 30, reps: 12, sets: 3 },
      ],
    },
    {
      name: 'Pull Day',
      daysAgoVal: 1, hour: 17,
      duration: 3600,
      items: [
        { exercise: exercises.deadlift,    weight: 120, reps: 5,  sets: 4 },
        { exercise: exercises.barbellRow,  weight: 70,  reps: 8,  sets: 4 },
        { exercise: exercises.latPulldown, weight: 60,  reps: 10, sets: 3 },
        { exercise: exercises.dbCurl,      weight: 14,  reps: 12, sets: 3 },
        { exercise: exercises.pullUp,      weight: 0,   reps: 8,  sets: 3 },
      ],
    },
    {
      name: 'Leg Day',
      daysAgoVal: 3, hour: 10,
      duration: 4200,
      items: [
        { exercise: exercises.squat,    weight: 100, reps: 6,  sets: 4 },
        { exercise: exercises.legPress, weight: 160, reps: 10, sets: 4 },
        { exercise: exercises.legCurl,  weight: 45,  reps: 12, sets: 3 },
        { exercise: exercises.calfRaise,weight: 60,  reps: 15, sets: 3 },
        { exercise: exercises.plank,    weight: 0,   reps: 60, sets: 3 },
      ],
    },
    {
      name: 'Push Day',
      daysAgoVal: 5, hour: 8,
      duration: 3480,
      items: [
        { exercise: exercises.benchPress,   weight: 82.5, reps: 8,  sets: 4 },
        { exercise: exercises.ohp,          weight: 47.5, reps: 8,  sets: 3 },
        { exercise: exercises.cableFlye,    weight: 15,   reps: 12, sets: 3 },
        { exercise: exercises.lateralRaise, weight: 10,   reps: 12, sets: 3 },
        { exercise: exercises.tricepPush,   weight: 27.5, reps: 12, sets: 3 },
      ],
    },
    {
      name: 'Pull Day',
      daysAgoVal: 6, hour: 18,
      duration: 3300,
      items: [
        { exercise: exercises.deadlift,    weight: 115, reps: 5,  sets: 4 },
        { exercise: exercises.barbellRow,  weight: 67.5,reps: 8,  sets: 4 },
        { exercise: exercises.latPulldown, weight: 57.5,reps: 10, sets: 3 },
        { exercise: exercises.dbCurl,      weight: 12,  reps: 12, sets: 3 },
      ],
    },
    {
      name: 'Leg Day',
      daysAgoVal: 8, hour: 10,
      duration: 3900,
      items: [
        { exercise: exercises.squat,    weight: 95,  reps: 6,  sets: 4 },
        { exercise: exercises.legPress, weight: 150, reps: 10, sets: 4 },
        { exercise: exercises.legCurl,  weight: 42.5,reps: 12, sets: 3 },
        { exercise: exercises.calfRaise,weight: 55,  reps: 15, sets: 3 },
      ],
    },
    {
      name: 'Push Day',
      daysAgoVal: 10, hour: 9,
      duration: 3600,
      items: [
        { exercise: exercises.benchPress,   weight: 80,  reps: 8,  sets: 4 },
        { exercise: exercises.ohp,          weight: 45,  reps: 8,  sets: 3 },
        { exercise: exercises.cableFlye,    weight: 12.5,reps: 12, sets: 3 },
        { exercise: exercises.tricepPush,   weight: 25,  reps: 12, sets: 3 },
      ],
    },
    {
      name: 'Pull Day',
      daysAgoVal: 12, hour: 17,
      duration: 3420,
      items: [
        { exercise: exercises.deadlift,    weight: 110, reps: 5,  sets: 4 },
        { exercise: exercises.barbellRow,  weight: 65,  reps: 8,  sets: 4 },
        { exercise: exercises.latPulldown, weight: 55,  reps: 10, sets: 3 },
        { exercise: exercises.dbCurl,      weight: 12,  reps: 12, sets: 3 },
      ],
    },
    {
      name: 'Leg Day',
      daysAgoVal: 14, hour: 11,
      duration: 4080,
      items: [
        { exercise: exercises.squat,    weight: 90,  reps: 6,  sets: 4 },
        { exercise: exercises.legPress, weight: 140, reps: 10, sets: 4 },
        { exercise: exercises.legCurl,  weight: 40,  reps: 12, sets: 3 },
        { exercise: exercises.calfRaise,weight: 50,  reps: 15, sets: 3 },
      ],
    },
    {
      name: 'Push Day',
      daysAgoVal: 17, hour: 10,
      duration: 3300,
      items: [
        { exercise: exercises.benchPress, weight: 77.5, reps: 8, sets: 4 },
        { exercise: exercises.ohp,        weight: 42.5, reps: 8, sets: 3 },
        { exercise: exercises.cableFlye,  weight: 12.5, reps: 12,sets: 3 },
        { exercise: exercises.tricepPush, weight: 25,   reps: 12,sets: 3 },
      ],
    },
    {
      name: 'Pull Day',
      daysAgoVal: 19, hour: 16,
      duration: 3180,
      items: [
        { exercise: exercises.deadlift,    weight: 105, reps: 5,  sets: 4 },
        { exercise: exercises.barbellRow,  weight: 62.5,reps: 8,  sets: 4 },
        { exercise: exercises.latPulldown, weight: 52.5,reps: 10, sets: 3 },
      ],
    },
    {
      name: 'Leg Day',
      daysAgoVal: 21, hour: 10,
      duration: 3600,
      items: [
        { exercise: exercises.squat,    weight: 85, reps: 6,  sets: 4 },
        { exercise: exercises.legPress, weight: 130,reps: 10, sets: 4 },
        { exercise: exercises.legCurl,  weight: 37.5,reps: 12,sets: 3 },
      ],
    },
  ];

  return workoutDefs.map((def, i) => {
    const sets = makeSets(def.items);
    const startedAt = daysAgo(def.daysAgoVal, def.hour);
    const finishedAt = new Date(new Date(startedAt).getTime() + def.duration * 1000).toISOString();
    return {
      id: `mock-w-${i}`,
      user_id: 'guest',
      name: def.name,
      started_at: startedAt,
      finished_at: finishedAt,
      duration_seconds: def.duration,
      total_volume_kg: volumeFromSets(sets),
      workout_sets: sets,
      sets, // alias used by dashboard
    };
  });
}

// --- Routines ---
export const mockRoutines = [
  {
    id: 'mock-r-1',
    user_id: 'guest',
    name: 'Push Day',
    description: 'Chest, Shoulders & Triceps',
    color: '#c8ff00',
    created_at: daysAgo(30),
    routine_exercises: [
      { id: 're-1', order: 0, sets: 4, reps_min: 6, reps_max: 8, rest_seconds: 120, exercises: exercises.benchPress },
      { id: 're-2', order: 1, sets: 3, reps_min: 8, reps_max: 10, rest_seconds: 90, exercises: exercises.ohp },
      { id: 're-3', order: 2, sets: 3, reps_min: 10, reps_max: 12, rest_seconds: 60, exercises: exercises.cableFlye },
      { id: 're-4', order: 3, sets: 3, reps_min: 10, reps_max: 12, rest_seconds: 60, exercises: exercises.lateralRaise },
      { id: 're-5', order: 4, sets: 3, reps_min: 10, reps_max: 12, rest_seconds: 60, exercises: exercises.tricepPush },
    ],
  },
  {
    id: 'mock-r-2',
    user_id: 'guest',
    name: 'Pull Day',
    description: 'Back & Biceps',
    color: '#6366f1',
    created_at: daysAgo(30),
    routine_exercises: [
      { id: 're-6',  order: 0, sets: 4, reps_min: 4, reps_max: 6, rest_seconds: 180, exercises: exercises.deadlift },
      { id: 're-7',  order: 1, sets: 4, reps_min: 8, reps_max: 10, rest_seconds: 90, exercises: exercises.barbellRow },
      { id: 're-8',  order: 2, sets: 3, reps_min: 8, reps_max: 10, rest_seconds: 90, exercises: exercises.latPulldown },
      { id: 're-9',  order: 3, sets: 3, reps_min: 10, reps_max: 12, rest_seconds: 60, exercises: exercises.dbCurl },
      { id: 're-10', order: 4, sets: 3, reps_min: 6, reps_max: 8, rest_seconds: 90, exercises: exercises.pullUp },
    ],
  },
  {
    id: 'mock-r-3',
    user_id: 'guest',
    name: 'Leg Day',
    description: 'Quads, Hamstrings & Calves',
    color: '#f97316',
    created_at: daysAgo(30),
    routine_exercises: [
      { id: 're-11', order: 0, sets: 4, reps_min: 4, reps_max: 6, rest_seconds: 180, exercises: exercises.squat },
      { id: 're-12', order: 1, sets: 4, reps_min: 8, reps_max: 10, rest_seconds: 90, exercises: exercises.legPress },
      { id: 're-13', order: 2, sets: 3, reps_min: 10, reps_max: 12, rest_seconds: 60, exercises: exercises.legCurl },
      { id: 're-14', order: 3, sets: 3, reps_min: 12, reps_max: 15, rest_seconds: 60, exercises: exercises.calfRaise },
      { id: 're-15', order: 4, sets: 3, reps_min: 45, reps_max: 60, rest_seconds: 60, exercises: exercises.plank },
    ],
  },
];

// --- Guest routine store (in-memory, survives navigation but not app restart) ---
const _guestRoutines: typeof mockRoutines = [];

export function getGuestRoutines() {
  return _guestRoutines;
}

export function addGuestRoutine(routine: typeof mockRoutines[0]) {
  _guestRoutines.unshift(routine);
}

export function getAllRoutines() {
  return [..._guestRoutines, ...mockRoutines];
}

export function findMockRoutine(id: string) {
  return _guestRoutines.find(r => r.id === id) || mockRoutines.find(r => r.id === id) || null;
}

// --- Guest workout store (in-memory) ---
interface GuestWorkoutExercise {
  name: string;
  sets: { weight_kg: number; reps: number }[];
}

interface GuestWorkout {
  id: string;
  name: string;
  started_at: string;
  finished_at: string;
  duration_seconds: number;
  total_volume_kg: number;
  routine_id: string | null;
  workout_sets: { id: string }[];
  exercises?: GuestWorkoutExercise[];
}

const _guestWorkouts: GuestWorkout[] = [];

export function addGuestWorkout(w: GuestWorkout) {
  _guestWorkouts.unshift(w);
}

export function getGuestWorkouts() {
  return _guestWorkouts;
}

/** Get previous performance for a routine — returns a map of exercise name → sets */
export function getPreviousPerformance(routineId: string): Record<string, { weight_kg: number; reps: number }[]> {
  const prev = _guestWorkouts.find(w => w.routine_id === routineId && w.exercises);
  if (!prev?.exercises) return {};
  const map: Record<string, { weight_kg: number; reps: number }[]> = {};
  prev.exercises.forEach(ex => {
    map[ex.name] = ex.sets;
  });
  return map;
}

// --- Body stats (for analytics guest visualization) ---
function buildWeightLog() {
  // ~12 weeks of weekly weigh-ins, gentle downward trend from 82 → 78
  const points = [82.4, 82.1, 81.8, 81.3, 80.9, 80.5, 80.0, 79.6, 79.2, 78.9, 78.5, 78.1];
  return points.map((weight, i) => {
    const n = points.length - 1 - i;
    return { date: daysAgo(n * 7, 8, 30), weight };
  });
}

function buildBodyFatLog() {
  const points = [19.8, 19.2, 18.7, 18.3, 17.9, 17.4, 17.0, 16.6, 16.2];
  return points.map((bodyFat, i) => {
    const n = points.length - 1 - i;
    return { date: daysAgo(n * 10, 9, 0), bodyFat };
  });
}

function buildMeasurements() {
  // 5 entries roughly 3 weeks apart — captures progression for all fields
  const defs = [
    { n: 75, chest: 102, shoulders: 120, neck: 39, bicepL: 36, bicepR: 36.5, forearmL: 29, forearmR: 29, waist: 86, hips: 98, thighL: 58, thighR: 58, calfL: 37, calfR: 37 },
    { n: 56, chest: 103, shoulders: 121, neck: 39, bicepL: 36.5, bicepR: 37, forearmL: 29.5, forearmR: 29.5, waist: 85, hips: 98, thighL: 58.5, thighR: 58.5, calfL: 37.5, calfR: 37.5 },
    { n: 37, chest: 104.5, shoulders: 122, neck: 39.5, bicepL: 37, bicepR: 37.5, forearmL: 29.5, forearmR: 30, waist: 84, hips: 97.5, thighL: 59, thighR: 59, calfL: 37.5, calfR: 38 },
    { n: 18, chest: 105, shoulders: 123, neck: 39.5, bicepL: 37.5, bicepR: 38, forearmL: 30, forearmR: 30, waist: 83, hips: 97, thighL: 59.5, thighR: 59.5, calfL: 38, calfR: 38 },
    { n: 2,  chest: 106, shoulders: 124, neck: 40,   bicepL: 38,   bicepR: 38.5, forearmL: 30, forearmR: 30.5, waist: 82, hips: 97, thighL: 60,   thighR: 60,   calfL: 38, calfR: 38.5 },
  ];
  return {
    unit: 'cm' as const,
    entries: defs
      .map((d, i) => {
        const { n, ...fields } = d;
        return { id: `mock-meas-${i}`, date: daysAgo(n, 8, 0), ...fields };
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
  };
}

let _weightLog: ReturnType<typeof buildWeightLog> | null = null;
let _bodyFatLog: ReturnType<typeof buildBodyFatLog> | null = null;
let _measurements: ReturnType<typeof buildMeasurements> | null = null;

export function getMockWeightLog() {
  if (!_weightLog) _weightLog = buildWeightLog();
  return _weightLog;
}

export function getMockBodyFatLog() {
  if (!_bodyFatLog) _bodyFatLog = buildBodyFatLog();
  return _bodyFatLog;
}

export function getMockMeasurements() {
  if (!_measurements) _measurements = buildMeasurements();
  return _measurements;
}

export const mockBasicInfo = { goalWeight: 75, weightUnit: 'kg' };

// --- Profile ---
export const mockProfile = {
  id: 'mock-p-1',
  clerk_user_id: 'guest',
  gender: 'M' as const,
  height_cm: 178,
  weight_kg: 78,
  goal_weight_kg: 75,
  body_fat_percent: 16,
  xp: 1250,
  created_at: daysAgo(45),
};

// --- Exported getters (cached) ---
let _workouts: ReturnType<typeof buildWorkouts> | null = null;

export function getMockWorkouts() {
  if (!_workouts) _workouts = buildWorkouts();
  return _workouts;
}

/** History screen version — includes exercise detail for expanded view */
export function getMockWorkoutsForHistory() {
  const mock = getMockWorkouts().map(w => {
    // Group sets by exercise
    const exerciseMap: Record<string, { name: string; sets: { weight_kg: number; reps: number; completed: boolean }[] }> = {};
    w.workout_sets.forEach(s => {
      const exId = s.exercise_id;
      if (!exerciseMap[exId]) {
        exerciseMap[exId] = { name: (s as any).exercises?.name || 'Exercise', sets: [] };
      }
      exerciseMap[exId].sets.push({ weight_kg: s.weight_kg, reps: s.reps, completed: s.completed });
    });
    return {
      id: w.id,
      name: w.name,
      started_at: w.started_at,
      finished_at: w.finished_at,
      duration_seconds: w.duration_seconds,
      total_volume_kg: w.total_volume_kg,
      routine_id: undefined,
      workout_sets: w.workout_sets.map(s => ({ id: s.id })),
      exercises: Object.values(exerciseMap),
    };
  });
  return [..._guestWorkouts, ...mock];
}
