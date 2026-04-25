export const XP_PER_LEVEL = [
  0, 283, 600, 1000, 1500, 2200, 3100, 4200, 5500, 7000, 9000,
];

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
