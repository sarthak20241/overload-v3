// Gallery exhibition value calculator.
//
// Each artwork is encoded as a colon-delimited string:
//   type:name:baseValue:age:condition:specialAttribute
//
// Every artwork type has its own valuation formula, and every final value is
// scaled by a condition multiplier of condition/10. The total exhibition value
// is the sum of each artwork's final value.

export type ArtworkType = 'painting' | 'sculpture' | 'digital';

/**
 * Compute the final exhibition value for a single encoded artwork string.
 *
 * Valuation formulas (before the condition multiplier):
 *   painting:   base + age * 10  + specialAttribute * 100   (fame rating)
 *   sculpture:  base + age * 15  + specialAttribute * 500   (material grade)
 *   digital:    base + specialAttribute * 50 + base * 0.5   (tech innovation)
 *
 * The subtotal is then multiplied by condition/10 and truncated to an integer.
 *
 * All arithmetic is done in doubled integer units so digital's base*0.5 bonus
 * and the condition/10 multiplier stay exact — floor(subtotal * (condition/10))
 * in floats is off by one for conditions 3/6/7 (e.g. 90 * 0.7 === 62.999…993).
 */
export function valueForArtwork(artwork: string): number {
  const [type, , baseValueStr, ageStr, conditionStr, specialStr] = artwork.split(':');

  const baseValue = Number(baseValueStr);
  const age = Number(ageStr);
  const condition = Number(conditionStr);
  const special = Number(specialStr);

  // sub2 = 2 * subtotal, always an exact integer
  let sub2: number;
  switch (type as ArtworkType) {
    case 'painting':
      sub2 = 2 * (baseValue + age * 10 + special * 100);
      break;
    case 'sculpture':
      sub2 = 2 * (baseValue + age * 15 + special * 500);
      break;
    case 'digital':
      // 2 * (base + special*50 + base*0.5)
      sub2 = baseValue * 3 + special * 100;
      break;
    default:
      sub2 = 2 * baseValue;
      break;
  }

  return Math.floor((sub2 * condition) / 20);
}

/**
 * Calculate the total exhibition value across all supplied artworks.
 *
 * @param n        Number of artworks (length of `artworks`).
 * @param artworks Encoded artwork strings, one per artwork.
 * @returns The summed exhibition value as an integer.
 */
export function calculateExhibitionValue(n: number, artworks: string[]): number {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += valueForArtwork(artworks[i]);
  }
  return total;
}
