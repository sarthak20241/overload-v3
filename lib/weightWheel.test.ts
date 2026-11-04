// Run with: deno test --allow-all lib/weightWheel.test.ts
//
// The onboarding weight wheels: whole + one decimal, the top of the scale, and
// the kg / lbs switch.

import { assertEquals } from "jsr:@std/assert@1";
import { convertWeight, joinWeight, splitWeight, tenthsMax, WEIGHT_WHEEL } from "./weightWheel.ts";

Deno.test("a value splits into its whole number and one decimal", () => {
  assertEquals(splitWeight(72.5), { whole: 72, tenth: 5 });
  assertEquals(splitWeight(72), { whole: 72, tenth: 0 });
  // Float noise never drops a whole number: 72.9999 is 73.0, not 72.10.
  assertEquals(splitWeight(72.96), { whole: 72, tenth: 9 });
  assertEquals(splitWeight(159.8), { whole: 159, tenth: 8 });
});

Deno.test("the wheels join back inside the scale", () => {
  const { min, max } = WEIGHT_WHEEL.kg;
  assertEquals(joinWeight(72, 5, min, max), 72.5);
  assertEquals(joinWeight(200, 7, min, max), 200);
  assertEquals(joinWeight(29, 9, min, max), 30);
});

Deno.test("no decimal past the top of the scale", () => {
  assertEquals(tenthsMax(200, WEIGHT_WHEEL.kg.max), 0);
  assertEquals(tenthsMax(199, WEIGHT_WHEEL.kg.max), 9);
  assertEquals(tenthsMax(441, WEIGHT_WHEEL.lbs.max), 0);
  assertEquals(tenthsMax(440, WEIGHT_WHEEL.lbs.max), 9);
});

Deno.test("a unit switch keeps one decimal and stays on the wheel", () => {
  assertEquals(convertWeight(72.5, "lbs"), 159.8);
  assertEquals(convertWeight(159.8, "kg"), 72.5);
  // Ends of the scale land inside the other unit's wheel.
  assertEquals(convertWeight(30, "lbs"), 66.1);
  assertEquals(convertWeight(200, "lbs"), 440.9);
  assertEquals(convertWeight(66, "kg"), 30);
  // The round trip moves by 0.1 at most.
  for (const kg of [30, 45.5, 72.5, 88.3, 120, 199.9, 200]) {
    const back = convertWeight(convertWeight(kg, "lbs"), "kg");
    if (Math.abs(back - kg) > 0.1 + 1e-9) throw new Error(`${kg} kg came back as ${back}`);
  }
});
