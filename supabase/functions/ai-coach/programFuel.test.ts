import { assertEquals } from "jsr:@std/assert@1";
import { withPhaseFuelDays } from "./programFuel.ts";

// The shape get_user_coach_context() returns for an active program.
const program = {
  title: "Summer Cut",
  current_phase: { seq: 1, name: "Deload", weeks_total: 1 },
  phases: [
    { seq: 0, name: "Volume Cut", calories: 2500 },
    { seq: 1, name: "Deload", calories: 2700 },
    { seq: 2, name: "Final Push", calories: 2150 },
  ],
};

Deno.test("each phase gets its own planned fuel days, the current phase too", () => {
  const out = withPhaseFuelDays(program, [
    { seq: 0, diet_fuel_days: null },
    { seq: 1, diet_fuel_days: [{ dow: 6, kcal: 300, label: "Heavy legs" }, { dow: 0, kcal: 300 }] },
    { seq: 2, diet_fuel_days: [] },
  ]) as typeof program & { phases: Record<string, unknown>[]; current_phase: Record<string, unknown> };

  // null: the phase said nothing, so no key at all.
  assertEquals("fuel_days" in out.phases[0], false);
  // Named days, Monday first, as the model reads them.
  assertEquals(out.phases[1].fuel_days, [
    { day: "Saturday", extra_kcal: 300, label: "Heavy legs" },
    { day: "Sunday", extra_kcal: 300 },
  ]);
  // An empty list is an answer: this phase has none.
  assertEquals(out.phases[2].fuel_days, []);
  assertEquals(out.current_phase.fuel_days, out.phases[1].fuel_days);
  // Nothing else moves.
  assertEquals(out.phases[1].calories, 2700);
  assertEquals(out.title, "Summer Cut");
});

Deno.test("no program or no fuel data leaves the context as it was", () => {
  assertEquals(withPhaseFuelDays(null, [{ seq: 0, diet_fuel_days: [] }]), null);
  assertEquals(withPhaseFuelDays(program, [{ seq: 0, diet_fuel_days: null }]), program);
  assertEquals(withPhaseFuelDays(program, []), program);
});
