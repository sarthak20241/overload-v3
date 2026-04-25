export const XP_PER_LEVEL = [
  0, 283, 600, 1000, 1500, 2200, 3100, 4200, 5500, 7000, 9000,
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

export function getXpForWorkout(sets: number, volume: number): number {
  return Math.floor(sets * 2 + volume / 100);
}
