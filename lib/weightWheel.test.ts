// Run with: deno test --allow-all lib/weightWheel.test.ts
//
// The onboarding weight wheels: whole + one decimal, the top of the scale, and
// the kg / lbs switch.

import { assertEquals } from "jsr:@std/assert@1";
import { displayFromKg, joinWeight, kgFromDisplay, splitWeight, tenthsMax, WEIGHT_WHEEL } from "./weightWheel.ts";

Deno.test("a value splits into its whole number and one decimal", () => {
  assertEquals(splitWeight(72.5), { whole: 72, tenth: 5 });
  assertEquals(splitWeight(72), { whole: 72, tenth: 0 });
  // The tenth never rolls over into a 10: 72.96 reads as 72 and 9.
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
  assertEquals(displayFromKg(72.5, "lbs"), 159.8);
  assertEquals(displayFromKg(kgFromDisplay(159.8, "lbs"), "kg"), 72.5);
  // Ends of the scale land inside the other unit's wheel.
  assertEquals(displayFromKg(30, "lbs"), 66.1);
  assertEquals(displayFromKg(200, "lbs"), 440.9);
  assertEquals(displayFromKg(kgFromDisplay(66, "lbs"), "kg"), 30);
  // A stop on the lbs wheel, read back in kg, moves by 0.1 at most.
  for (const kg of [30, 45.5, 72.5, 88.3, 120, 199.9, 200]) {
    const back = displayFromKg(kgFromDisplay(displayFromKg(kg, "lbs"), "lbs"), "kg");
    if (Math.abs(back - kg) > 0.1 + 1e-9) throw new Error(`${kg} kg came back as ${back}`);
  }
});

Deno.test("flipping units many times never drifts: the wheels read the kept kg", () => {
  // What the weight screen does: a wheel stop sets the kept kg, and every unit
  // switch shows displayFromKg(kept kg, the new unit).
  for (const [stop, unit] of [[72.3, "kg"], [159.4, "lbs"], [88.8, "kg"], [441, "lbs"], [30, "kg"]] as const) {
    const kept = kgFromDisplay(stop, unit);
    const other = unit === "kg" ? "lbs" : "kg";
    const first = { [unit]: stop, [other]: displayFromKg(kept, other) } as Record<"kg" | "lbs", number>;
    let shown: number = stop;
    for (let i = 0; i < 10; i++) {
      shown = displayFromKg(kept, other);
      assertEquals(shown, first[other]);
      shown = displayFromKg(kept, unit);
      assertEquals(shown, stop);
    }
  }
});
