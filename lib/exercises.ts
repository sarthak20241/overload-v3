/**
 * Shared exercise library used by both routine creation and active workout.
 * Matches the Figma reference exercise set.
 */

export interface ExerciseDef {
  name: string;
  muscle_group: string;
  category: string;
}

export const MUSCLE_GROUPS = [
  'Chest', 'Back', 'Shoulders', 'Quads', 'Hamstrings',
  'Glutes', 'Biceps', 'Triceps', 'Calves', 'Core',
] as const;

export const CATEGORIES = [
  'Barbell', 'Dumbbell', 'Cable', 'Machine', 'Bodyweight', 'Other',
] as const;

export const EXERCISE_LIBRARY: ExerciseDef[] = [
  // Chest
  { name: 'Bench Press', muscle_group: 'Chest', category: 'Barbell' },
  { name: 'Incline Dumbbell Press', muscle_group: 'Chest', category: 'Dumbbell' },
  { name: 'Cable Fly', muscle_group: 'Chest', category: 'Cable' },
  { name: 'Dumbbell Fly', muscle_group: 'Chest', category: 'Dumbbell' },
  { name: 'Incline Barbell Press', muscle_group: 'Chest', category: 'Barbell' },
  { name: 'Push-up', muscle_group: 'Chest', category: 'Bodyweight' },
  { name: 'Chest Dip', muscle_group: 'Chest', category: 'Bodyweight' },
  // Back
  { name: 'Deadlift', muscle_group: 'Back', category: 'Barbell' },
  { name: 'Barbell Row', muscle_group: 'Back', category: 'Barbell' },
  { name: 'Pull-up', muscle_group: 'Back', category: 'Bodyweight' },
  { name: 'Lat Pulldown', muscle_group: 'Back', category: 'Cable' },
  { name: 'Seated Cable Row', muscle_group: 'Back', category: 'Cable' },
  { name: 'T-Bar Row', muscle_group: 'Back', category: 'Barbell' },
  { name: 'Dumbbell Row', muscle_group: 'Back', category: 'Dumbbell' },
  // Shoulders
  { name: 'Overhead Press', muscle_group: 'Shoulders', category: 'Barbell' },
  { name: 'Lateral Raise', muscle_group: 'Shoulders', category: 'Dumbbell' },
  { name: 'Face Pull', muscle_group: 'Shoulders', category: 'Cable' },
  { name: 'Arnold Press', muscle_group: 'Shoulders', category: 'Dumbbell' },
  { name: 'Rear Delt Fly', muscle_group: 'Shoulders', category: 'Dumbbell' },
  { name: 'Front Raise', muscle_group: 'Shoulders', category: 'Dumbbell' },
  // Quads
  { name: 'Squat', muscle_group: 'Quads', category: 'Barbell' },
  { name: 'Leg Press', muscle_group: 'Quads', category: 'Machine' },
  { name: 'Leg Extension', muscle_group: 'Quads', category: 'Machine' },
  { name: 'Bulgarian Split Squat', muscle_group: 'Quads', category: 'Dumbbell' },
  { name: 'Hack Squat', muscle_group: 'Quads', category: 'Machine' },
  // Hamstrings
  { name: 'Romanian Deadlift', muscle_group: 'Hamstrings', category: 'Barbell' },
  { name: 'Leg Curl', muscle_group: 'Hamstrings', category: 'Machine' },
  { name: 'Good Morning', muscle_group: 'Hamstrings', category: 'Barbell' },
  // Glutes
  { name: 'Hip Thrust', muscle_group: 'Glutes', category: 'Barbell' },
  { name: 'Glute Bridge', muscle_group: 'Glutes', category: 'Bodyweight' },
  { name: 'Cable Kickback', muscle_group: 'Glutes', category: 'Cable' },
  // Biceps
  { name: 'Barbell Curl', muscle_group: 'Biceps', category: 'Barbell' },
  { name: 'Dumbbell Curl', muscle_group: 'Biceps', category: 'Dumbbell' },
  { name: 'Hammer Curl', muscle_group: 'Biceps', category: 'Dumbbell' },
  { name: 'Preacher Curl', muscle_group: 'Biceps', category: 'Machine' },
  // Triceps
  { name: 'Tricep Pushdown', muscle_group: 'Triceps', category: 'Cable' },
  { name: 'Skull Crusher', muscle_group: 'Triceps', category: 'Barbell' },
  { name: 'Overhead Tricep Extension', muscle_group: 'Triceps', category: 'Dumbbell' },
  { name: 'Close-grip Bench Press', muscle_group: 'Triceps', category: 'Barbell' },
  // Calves
  { name: 'Calf Raise', muscle_group: 'Calves', category: 'Machine' },
  { name: 'Seated Calf Raise', muscle_group: 'Calves', category: 'Machine' },
  // Core
  { name: 'Plank', muscle_group: 'Core', category: 'Bodyweight' },
  { name: 'Ab Crunch', muscle_group: 'Core', category: 'Bodyweight' },
  { name: 'Russian Twist', muscle_group: 'Core', category: 'Bodyweight' },
  { name: 'Cable Crunch', muscle_group: 'Core', category: 'Cable' },
  { name: 'Hanging Leg Raise', muscle_group: 'Core', category: 'Bodyweight' },
];

/** Search exercises by name or muscle group */
export function searchExercises(query: string, library = EXERCISE_LIBRARY): ExerciseDef[] {
  const q = query.toLowerCase().trim();
  if (!q) return library;
  return library.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.muscle_group.toLowerCase().includes(q) ||
      e.category.toLowerCase().includes(q),
  );
}

/** Get exercises grouped by muscle group */
export function exercisesByMuscle(library = EXERCISE_LIBRARY) {
  const grouped: Record<string, ExerciseDef[]> = {};
  for (const ex of library) {
    if (!grouped[ex.muscle_group]) grouped[ex.muscle_group] = [];
    grouped[ex.muscle_group].push(ex);
  }
  return grouped;
}
