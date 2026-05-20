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
//
// Bias: prefer false positives (we'd rather spend a $0.002 Haiku call on a
// borderline paper than reject something useful). The plan calls this a
// "low bar — is this exercise science?" gate. Phase 4 broadening adds more
// outcomes, more populations, and more lifter-vocabulary terms — the
// nightly cron was returning 0 adds because the previous list was tight
// enough to reject everything that wasn't a meta-analysis with
// "resistance training" verbatim in the abstract.
const KEYWORDS = [
  // core domain
  'resistance training', 'resistance exercise', 'strength training',
  'weight training', 'weight-lifting', 'weightlifting',
  'powerlifting', 'bodybuilding', 'olympic lifting', 'olympic weightlifting',
  'free weights',
  // outcomes
  'hypertrophy', 'muscle growth', 'muscle mass', 'lean mass',
  'muscle size', 'muscle thickness', 'cross-sectional area', 'csa',
  'fiber hypertrophy', 'myofibrillar', 'sarcoplasmic',
  '1rm', 'one-repetition maximum', '1-rm', 'one-rep max',
  'maximal strength', 'isometric strength', 'maximum voluntary contraction',
  'mvc', 'force production',
  'power output', 'rate of force development', 'rfd',
  'jump performance', 'sprint performance',
  // variables
  'training volume', 'training frequency', 'training intensity',
  'set volume', 'weekly volume', 'sets per week', 'volume load',
  'rep range', 'repetition range', 'rep ranges', 'low reps', 'high reps',
  'rir', 'rpe', 'rating of perceived exertion',
  'proximity to failure', 'training to failure', 'momentary failure',
  'failure training', 'leaving reps in reserve',
  'periodization', 'periodisation', 'deload', 'tapering',
  'progressive overload', 'concurrent training', 'block periodization',
  'dup', 'undulating periodization',
  // recovery / programming
  'muscle protein synthesis', 'mps ', 'protein intake', 'protein supplementation',
  'leucine', 'essential amino acids', 'creatine', 'creatine monohydrate',
  'recovery', 'overreaching', 'overtraining', 'fatigue management',
  'sleep deprivation', 'sleep quality', 'muscle damage', 'doms',
  'delayed onset muscle soreness',
  // exercises / movements (broad)
  'bench press', 'squat ', 'back squat', 'front squat', 'deadlift',
  'romanian deadlift', 'overhead press', 'pull-up', 'pull up', 'chin-up',
  'barbell', 'dumbbell', 'kettlebell', 'machine training',
  'compound exercise', 'compound lift', 'isolation exercise',
  // populations
  'trained men', 'trained women', 'trained adults', 'resistance-trained',
  'untrained', 'novice lifters', 'recreational lifters', 'recreational athletes',
  'experienced lifters', 'powerlifters', 'bodybuilders', 'weightlifters',
  'collegiate athletes', 'strength athletes',
  // conditioning
  'aerobic training', 'endurance training', 'aerobic exercise',
  'cardiorespiratory fitness', 'vo2max', 'vo2 max', 'vo2peak',
  'hiit', 'high-intensity interval', 'sprint interval', 'zone 2',
  'lactate threshold', 'maximal aerobic',
  // fat loss / body comp
  'fat loss', 'fat mass', 'body composition', 'body fat',
  'caloric deficit', 'energy deficit', 'energy restriction',
  'cutting phase', 'weight loss', 'visceral fat',
  'lean body mass', 'fat-free mass',
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
