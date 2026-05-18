/**
 * Pre-distillation relevance filter. The plan says "low bar — is this
 * exercise science?" — we're not trying to be picky here, just to keep
 * outright off-topic papers (e.g. cardiology RCTs, plant biology) from
 * burning Haiku tokens.
 *
 * Match logic: any keyword hit in title OR abstract → relevant.
 * False positives cost a Haiku call (~$0.002 each); false negatives drop
 * potentially useful papers. We bias toward false positives.
 */

// Curated keyword set, lowercase. Singular/plural variants intentionally
// included where one doesn't subsume the other (e.g. "strength" vs "strong").
const KEYWORDS = [
  // core domain
  'resistance training', 'resistance exercise', 'strength training',
  'weight training', 'weight-lifting', 'weightlifting',
  // outcomes
  'hypertrophy', 'muscle growth', 'muscle mass', 'lean mass',
  'muscle size', 'cross-sectional area', 'csa',
  '1rm', 'one-repetition maximum', 'maximal strength', 'isometric strength',
  'power output', 'rate of force development',
  // variables
  'training volume', 'training frequency', 'training intensity',
  'rep range', 'repetition range', 'rir', 'rpe',
  'proximity to failure', 'training to failure', 'momentary failure',
  'periodization', 'periodisation', 'deload',
  'progressive overload', 'concurrent training',
  // recovery / programming
  'muscle protein synthesis', 'mps ', 'protein intake', 'protein supplementation',
  'recovery', 'overreaching', 'overtraining',
  'sleep deprivation', 'sleep quality',
  // exercises / movements (broad)
  'bench press', 'squat ', 'deadlift', 'barbell', 'dumbbell',
  // populations
  'trained men', 'trained women', 'trained adults', 'resistance-trained',
  'untrained', 'novice lifters',
  // conditioning
  'aerobic training', 'endurance training', 'vo2max', 'vo2 max',
  'hiit', 'high-intensity interval', 'zone 2',
  // fat loss / body comp
  'fat loss', 'body composition', 'caloric deficit', 'energy deficit',
  'cutting phase', 'fat mass',
];

export function isRelevant(title: string, abstract: string): boolean {
  const haystack = `${title}\n${abstract}`.toLowerCase();
  for (const k of KEYWORDS) {
    if (haystack.includes(k)) return true;
  }
  return false;
}

/**
 * Returns the first matching keyword (for logging / debug). null if none.
 */
export function relevanceMatch(title: string, abstract: string): string | null {
  const haystack = `${title}\n${abstract}`.toLowerCase();
  for (const k of KEYWORDS) {
    if (haystack.includes(k)) return k;
  }
  return null;
}
