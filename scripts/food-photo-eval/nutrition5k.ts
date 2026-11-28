// Build a weighed test set for scripts/food-photo-eval/run.ts from Nutrition5k
// (Google Research, CC BY 4.0: https://github.com/google-research-datasets/Nutrition5k).
// Every dish there was weighed ingredient by ingredient, so its total mass,
// calories and macros are known.
//
//   deno run -A scripts/food-photo-eval/nutrition5k.ts            # 40 dishes
//   N=80 deno run -A scripts/food-photo-eval/nutrition5k.ts       # more
//   CASES=~/.config/overload/food-photos/nutrition5k/cases.json deno run -A scripts/food-photo-eval/run.ts
//
// It downloads into ~/.config/overload/food-photos/nutrition5k/ (OUTSIDE the
// repo): the dish metadata (2.2 MB), the official test-split id list, and one
// overhead photo per chosen dish (about 0.3 MB each). Nothing is committed.
//
// The pick is fixed, not random: the first N dishes of the official depth
// test split that are a real meal (150 g or more, 150 kcal or more, 3 or more
// ingredients). The same command gives the same set.
//
// Limits to keep in mind when reading results: US cafeteria food, shot from
// straight above by a fixed camera, on one kind of plate. No Indian food, no
// labels, no restaurant plating, no hand-held angles.

const DIR = `${Deno.env.get("HOME")}/.config/overload/food-photos/nutrition5k`;
const BASE = "https://storage.googleapis.com/nutrition5k_dataset/nutrition5k_dataset";
const N = Math.max(1, Number(Deno.env.get("N") ?? 40) || 40);

/** The rig, from the Nutrition5k paper (section 3.2): the camera sits 35.9 cm
 *  above the plate, and one pixel covers 5.957e-3 cm2 there. Checked against
 *  the dataset's own depth maps (see the PR). This stands in for a phone's
 *  LiDAR reading when the eval is run with SCALE=1. */
const CAMERA_CM = 35.9;
const CM_PER_PX = Math.sqrt(5.957e-3);

await Deno.mkdir(`${DIR}/dishes`, { recursive: true });

async function fetchTo(url: string, path: string): Promise<void> {
  try {
    if ((await Deno.stat(path)).size > 0) return;
  } catch { /* not there yet */ }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await Deno.writeFile(path, new Uint8Array(await res.arrayBuffer()));
}

await fetchTo(`${BASE}/metadata/dish_metadata_cafe1.csv`, `${DIR}/dish_metadata_cafe1.csv`);
await fetchTo(`${BASE}/dish_ids/splits/depth_test_ids.txt`, `${DIR}/depth_test_ids.txt`);

interface Dish {
  id: string;
  kcal: number;
  mass_g: number;
  fat_g: number;
  carb_g: number;
  protein_g: number;
  ingredients: { name: string; grams: number }[];
}

// dish_id, kcal, mass, fat, carb, protein, then 7 fields per ingredient:
// id, name, grams, kcal, fat, carb, protein.
const dishes = new Map<string, Dish>();
for (const line of (await Deno.readTextFile(`${DIR}/dish_metadata_cafe1.csv`)).split("\n")) {
  const f = line.trim().split(",");
  if (f.length < 13) continue;
  const ingredients: Dish["ingredients"] = [];
  for (let i = 6; i + 6 < f.length; i += 7) ingredients.push({ name: f[i + 1], grams: Number(f[i + 2]) });
  dishes.set(f[0], {
    id: f[0], kcal: Number(f[1]), mass_g: Number(f[2]), fat_g: Number(f[3]), carb_g: Number(f[4]), protein_g: Number(f[5]),
    ingredients,
  });
}

const picked: Dish[] = [];
for (const id of (await Deno.readTextFile(`${DIR}/depth_test_ids.txt`)).split("\n").map((s) => s.trim()).filter(Boolean)) {
  const d = dishes.get(id);
  if (!d || !(d.mass_g >= 150) || !(d.kcal >= 150) || d.ingredients.length < 3) continue;
  const path = `${DIR}/dishes/${id}.png`;
  try {
    await fetchTo(`${BASE}/imagery/realsense_overhead/${id}/rgb.png`, path);
  } catch {
    continue; // a few dishes have no overhead photo
  }
  picked.push(d);
  if (picked.length >= N) break;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const cases = picked.map((d) => ({
  id: d.id,
  images: [`dishes/${d.id}.png`],
  kind: "plate",
  truth: { mass_g: r1(d.mass_g), kcal: r1(d.kcal), fat_g: r1(d.fat_g), carb_g: r1(d.carb_g), protein_g: r1(d.protein_g) },
  // For reading a result by eye; not graded (names differ from a read's).
  ingredients: d.ingredients.filter((i) => i.grams >= 5).sort((a, b) => b.grams - a.grams).map((i) => `${i.name} ${Math.round(i.grams)} g`),
  // The rig's geometry, per pixel: the eval turns it into the frame's size.
  rig: { distance_cm: CAMERA_CM, cm_per_px: CM_PER_PX },
}));
await Deno.writeTextFile(`${DIR}/cases.json`, JSON.stringify(cases, null, 2));
console.log(`${cases.length} dishes -> ${DIR}/cases.json`);
