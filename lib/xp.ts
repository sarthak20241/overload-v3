/**
 * Cumulative XP needed to REACH each level: index 0 is level 1, so the last
 * index is the cap. XP itself comes from getXpForWorkout below.
 *
 * Levels 1-11 are FROZEN at their original values. Changing any of them would
 * silently move every existing user's level up or down, so new levels may only
 * ever be appended. lib/xp.test.ts pins the prefix against a hardcoded copy: if
 * that test fails, revert the table rather than updating the test.
 *
 * The table used to stop at 11, which made six of the eight TITLE_TIERS
 * unreachable: Dedicated starts at 15 and Legend at 50, so "Regular" was the
 * highest title anyone could ever hold, and a maxed-out user sat on a 100%
 * bar with nothing left to earn. It now runs to 50 so every title is real.
 *
 * The curve continues the original shape: each level costs 250 XP more than
 * the one before (the last frozen step was 2000, so the next is 2250), which
 * keeps increments strictly increasing across the whole table.
 *
 * Pacing, at ONE consistent assumption throughout — ~90 XP a workout, four
 * workouts a week, so ~18,700 XP a year:
 *
 *   Regular    L10    7,000     ~5 months
 *   Dedicated  L15   19,500     ~1 year
 *   Athlete    L20   38,250     ~2 years
 *   Warrior    L30   94,500     ~5 years
 *   Elite      L40  175,750     ~9 years
 *   Legend     L50  282,000     ~15 years
 *
 * A heavier lifter earns far more per session (25 sets at 10,000 kg is 150 XP,
 * and five sessions a week is ~39,000 a year), which roughly halves all of the
 * above: Legend lands nearer 7 years. Quote one assumption or the other, never
 * a mix — an earlier draft of this comment paced Legend at 7 years next to
 * Elite at 10, which is impossible when Legend costs more than Elite.
 */
export const XP_PER_LEVEL = [
  0, 283, 600, 1000, 1500, 2200, 3100, 4200, 5500, 7000,
  9000, 11250, 13750, 16500, 19500, 22750, 26250, 30000, 34000, 38250,
  42750, 47500, 52500, 57750, 63250, 69000, 75000, 81250, 87750, 94500,
  101500, 108750, 116250, 124000, 132000, 140250, 148750, 157500, 166500, 175750,
  185250, 195000, 205000, 215250, 225750, 236500, 247500, 258750, 270250, 282000,
];

export interface TitleTier {
  minLevel: number;
  maxLevel: number;
  title: string;
  color: string;
  icon: string;
}

export const TITLE_TIERS: readonly TitleTier[] = [
  { minLevel: 1, maxLevel: 4, title: 'Beginner', color: '#6b7280', icon: '🌱' },
  { minLevel: 5, maxLevel: 9, title: 'Rookie', color: '#06b6d4', icon: '⚡' },
  { minLevel: 10, maxLevel: 14, title: 'Regular', color: '#10b981', icon: '💪' },
  { minLevel: 15, maxLevel: 19, title: 'Dedicated', color: '#f59e0b', icon: '🔥' },
  { minLevel: 20, maxLevel: 29, title: 'Athlete', color: '#a855f7', icon: '🏆' },
  { minLevel: 30, maxLevel: 39, title: 'Warrior', color: '#ef4444', icon: '⚔️' },
  { minLevel: 40, maxLevel: 49, title: 'Elite', color: '#ec4899', icon: '👑' },
  { minLevel: 50, maxLevel: 999, title: 'Legend', color: '#c8ff00', icon: '🌟' },
];

export function getTierForLevel(level: number): TitleTier {
  return TITLE_TIERS.find((t) => level >= t.minLevel && level <= t.maxLevel) || TITLE_TIERS[0];
}

export function getLevelInfo(totalXp: number): { level: number; xpInLevel: number; xpNeeded: number } {
  let level = 1;
  let accumulated = 0;
  for (let i = 0; i < XP_PER_LEVEL.length - 1; i++) {
    const needed = XP_PER_LEVEL[i + 1] - XP_PER_LEVEL[i];
    if (totalXp >= accumulated + needed) {
      accumulated += needed;
      level = i + 2;
    } else {
      return {
        level: i + 1,
        xpInLevel: totalXp - accumulated,
        xpNeeded: needed,
      };
    }
  }
  // Max level reached — clamp display so the progress bar reads 100% instead of rendering against a 9999-xp ghost threshold.
  const maxLevel = XP_PER_LEVEL.length;
  return { level: maxLevel, xpInLevel: 1, xpNeeded: 1 };
}

/**
 * True once `level` is the last entry in XP_PER_LEVEL. Past the cap
 * getLevelInfo clamps to xpInLevel/xpNeeded = 1/1 so the bar reads full, and
 * every caller that prints those numbers has to suppress them — printing them
 * raw shows "1 / 1 XP to <cap + 1>", naming a level that does not exist.
 * Exported so the dashboard bar and the profile card cannot drift apart.
 */
export function isMaxLevel(level: number): boolean {
  return level >= XP_PER_LEVEL.length;
}

export function getXpForWorkout(sets: number, volume: number): number {
  return Math.floor(sets * 2 + volume / 100);
}
