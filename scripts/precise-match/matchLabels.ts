// Labels for Jev question 2 ("which of our rows is this food"), keyed by
// queries.ts id. `ok` lists the candidate ids (from candidates.json) that are
// exactly this food; an empty list means NONE of the candidates is, and the
// right answer is no match (the web lookup then runs).
//
// Written by hand from candidates.json (2026-09-27 snapshot). A row counts as
// exactly this food when it is the same food in the same state (plain), the
// same brand + product + variant (packaged / restaurant), or the same dish,
// AND its per-100 kcal is within ~10% of what the food really is. Branded
// packs are left out of plain-food labels: the gate never serves them there.
// Regenerate candidates.json and these ids go stale; relabel, do not remap.

import type { FoodKind } from "../../supabase/functions/ai-coach/preciseMatch.ts";

export const MATCH_LABELS: Record<string, { kind: FoodKind; ok: string[] }> = {
  // t-banana: Banana, Banana, raw
  "t-banana": { kind: "plain", ok: ["00bc2f28-2366-402a-b762-efc8e1a09b23", "9ccc7c1a-2ada-417b-ba1b-ba3096b2cf71"] },
  // t-cashews: Cashews, NFS, Cashews, salted, Cashews, unsalted, Cashews, unroasted, Cashews, lightly salted. honey roasted is a flavoured version
  "t-cashews": { kind: "plain", ok: ["cb72d2bd-06da-4306-af73-1bec6b9794c3", "83554d99-1df8-42ae-917a-1e31b6452a8e", "23444f8f-664e-4390-b8b2-4876607bc696", "2a32e01f-3ee5-447a-a05a-37def81cd86c", "e4352c8c-835f-4dcd-96b0-fe5595c96454"] },
  // t-cucumber: Cucumber, raw, Cucumber, with peel, raw, Cucumber, raw, flesh and skin, Cucumber, for use on a sandwich. peeled raw is 10 kcal vs 15, cooked is another state
  "t-cucumber": { kind: "plain", ok: ["72c7e489-5533-4c81-a9ef-6a15e9002df7", "002e863a-fadf-4fa5-b1bd-1ebaca6f1a63", "b3829b14-01e4-4c0b-84c5-8162ebbf0382", "c495426e-84ac-4d76-adde-7bccc77eff28"] },
  // t-oats: none. search returned only branded packs: no generic row to serve (retrieval gap)
  "t-oats": { kind: "plain", ok: [] },
  // t-paneer: Paneer. Amul Paneer is a pack, low fat is a variant, the rest are dishes
  "t-paneer": { kind: "plain", ok: ["790b68bd-298f-40de-97de-fc13132b5bfd"] },
  // t-curd: Curd / Dahi. c1 'Curd' is an unbranded OFF row, not a reference row; soybean curd is tofu
  "t-curd": { kind: "plain", ok: ["480855a1-cb7f-41da-ae07-1c480c2a027a"] },
  // t-sweet-potato: Sweet potato, boiled, no added fat, Sweet potato, cooked, boiled, without skin, Sweet potato, cooked, boiled, without skin, with salt, Sweet potato, cooked, as ingredient. fat added is another state; CoFID 58 is 25% off
  "t-sweet-potato": { kind: "plain", ok: ["5e5127b0-d8b1-4b58-a703-ba314d8be3c5", "1dfbdc8b-abcc-47f3-a85b-29331a296cc1", "f0ef24d1-b49a-484c-a654-d1bcc44da322", "cc99298e-371a-469f-b81f-2eb46c0e1528"] },
  // t-brown-rice: Rice, brown, cooked, no added fat, Rice, brown, cooked, NS as to fat, Rice, brown, cooked, as ingredient. fat added rows run 11-15% higher
  "t-brown-rice": { kind: "plain", ok: ["18f53974-455f-449a-a6a5-d1140518e0fb", "20867960-373a-472b-a8c5-b3447e6ae765", "58853621-f145-4d4a-8710-76682b0986f3"] },
  // t-raw-chicken: raw chicken breast, Chicken, breast, boneless, skinless, raw. meat and skin is 17% higher; the rest are cooked
  "t-raw-chicken": { kind: "plain", ok: ["7ae88e5e-cd79-4592-9a1d-f8f6351f34f4", "5fae36dc-912a-4ecf-b42d-1793ae0286a1"] },
  // t-peanut-butter: Peanut butter, Peanut butter, creamy, Peanut butter, smooth. lower sugar / reduced fat are variants
  "t-peanut-butter": { kind: "plain", ok: ["7a50ae55-3879-42c1-8163-57e04229507f", "8a231516-01b1-482b-9101-563a0fba75c5", "4f72d934-59f7-46ab-a3c5-579e8956a001"] },
  // t-parle-g: Parle G Gluco Biscuits Milk wheat, Parle-G Original Gluco Biscuits, Parle-G. Oats & berries, Monaco, Hide&Seek are other products
  "t-parle-g": { kind: "packaged", ok: ["7eadc236-af54-4616-b4d9-1d6d098cbf2c", "f23124a5-ce4d-4a55-bd19-aad580066208", "c1d1f556-d7b0-4bf8-b327-a131dc914c0a"] },
  // t-amul-cheese: Amul Cheese Slice A, Amul Cheese slices. chiplet / cube / pure milk cheese are other products
  "t-amul-cheese": { kind: "packaged", ok: ["1dc84e50-f29c-43f3-849f-4e3a02bba7c4", "cf53cf05-d0a9-49cb-b877-d27652d4508d"] },
  // t-maggi: Nestle Maggi Masala Noodles, Nestle Maggi noodles masala, Nestle Maggi Masala 2 Minute 2 Noodles - 280 GM. oats / atta noodles are other products; Yippee is another brand
  "t-maggi": { kind: "packaged", ok: ["b195ebca-28eb-43ad-99e5-f787e53aeddc", "e764535a-3f73-44c1-b480-c204be1fa812", "14bc7f1b-28e3-4149-9950-db30d85cbe14"] },
  // t-lays: Lay's Lays salted Chips 30, Lay's Salt Chips, Lay's Lays Classics Salted 20rs. c1 has the right name but 100 kcal: a per-serving row, wrong per 100 g; European 'nature' chips are another product
  "t-lays": { kind: "packaged", ok: ["cdc7cfc1-f051-44df-9724-34477ba4c44a", "8a6b259e-a4af-433c-8173-fac09dbf1dbd", "e344fada-659f-4743-a629-d52efd70859d"] },
  // t-bhujia: Haldiram's Aloo bhujia, Haldiram's Haldiram aloo bhujia 220g, Haldirams Aloo Bhujia, Haldiram's Haldirams Alu Bhujia. plain bhujia and bhujia sev are other products
  "t-bhujia": { kind: "packaged", ok: ["eeef6691-bf06-42ee-adce-0be77d8eff47", "470f159f-eaac-49ae-9059-85a73f8ae153", "4892f8ee-c71e-48b8-8e7a-500a6c629124", "b20483ae-f0e4-4b6c-aac3-a33537881c78"] },
  // t-low-fat-paneer: none. Amul High Protein Paneer is not low fat paneer
  "t-low-fat-paneer": { kind: "packaged", ok: [] },
  // t-mcaloo: none. no McAloo Tikki row
  "t-mcaloo": { kind: "restaurant", ok: [] },
  // t-dominos: none. only US cheese / pepperoni pizzas
  "t-dominos": { kind: "restaurant", ok: [] },
  // t-chole-bhature: none. search returned unrelated rows (retrieval gap)
  "t-chole-bhature": { kind: "dish", ok: [] },
  // t-rajma-chawal: Rajma Chawal. the Daawat cup is a pack; rajma masala is another dish
  "t-rajma-chawal": { kind: "dish", ok: ["a1705abf-7c43-40b1-915c-7dc129e68f60"] },
  // t-masala-dosa: Masala Dosa
  "t-masala-dosa": { kind: "dish", ok: ["96b37e18-953d-45ee-b77b-1f11b9309913"] },
  // t-pbm: Paneer Butter Masala
  "t-pbm": { kind: "dish", ok: ["5356b2f4-6ee9-4200-80db-39416bbb9117"] },
  // t-egg-bhurji: Egg Bhurji
  "t-egg-bhurji": { kind: "dish", ok: ["d52868e8-1c34-4302-872f-6a296d5a12e5"] },
  // f-pear: pear, Pear, raw. Asian pear is another fruit
  "f-pear": { kind: "plain", ok: ["9d7b04cd-f59e-4630-9ce2-a320e34fccc4", "a8e7eb4d-7f6b-4841-950e-18712187727e"] },
  // f-walnuts: Walnuts, kernel only, Nuts, walnuts, english. 730 kcal row is 12% high; honey roasted / glazed / in-shell are other forms
  "f-walnuts": { kind: "plain", ok: ["4cb2fcad-b749-4fc2-bb54-2a739220daaa", "75f265a8-cbdc-48da-a896-8924dc14e4f6"] },
  // f-broccoli: Broccoli, green, steamed, Broccoli, cooked, as ingredient, Broccoli, fresh, cooked, no added fat. cooked with fat is another state
  "f-broccoli": { kind: "plain", ok: ["155eb662-d840-45fb-b411-a7285808c8f4", "e8ea2ac1-f0ef-4bf7-8301-2311d4d28e92", "643cf816-92bc-4e0e-892e-5aa002a784a5"] },
  // f-tofu: Tofu nature, préemballé. Plain firm tofu (148 kcal). The CoFID steamed row is 73 kcal: a softer tofu, half the energy, so one query cannot accept both (relabelled on PR review; tofu was a miss in every run, so no count moved).
  "f-tofu": { kind: "plain", ok: ["68602e9f-2454-4019-9fbf-e5373ca65749"] },
  // f-quinoa: Quinoa, cooked. uncooked is another state
  "f-quinoa": { kind: "plain", ok: ["51d83ce2-04a8-4850-b213-0b3ea524cba0"] },
  // f-roasted-peanuts: Peanuts, roasted, salted, Peanuts, roasted, unsalted. branded packs; honey roasted is flavoured
  "f-roasted-peanuts": { kind: "plain", ok: ["8bafef67-576b-4e34-b780-13ce7d28fb39", "756c953b-20ee-49b0-a5b3-08835d1d6e4c"] },
  // f-skimmed-milk: Skimmed Milk. semi-skimmed is another milk; powder another form
  "f-skimmed-milk": { kind: "plain", ok: ["0f229dc7-4100-4ba7-9e41-93263ffdbd32"] },
  // f-fried-egg: Egg, whole, fried with oil, Egg, whole, fried with butter. fried rice / eggplant / noodles are other foods
  "f-fried-egg": { kind: "plain", ok: ["3f610fda-4c85-41c3-8e35-a56cbf876b0e", "293a714a-41bd-4fb1-ba38-c308f9a12bb2"] },
  // f-dark-fantasy: Sunfeast Dark Fantasy Choco Fills, Sunfeast Dark Fantasy Big Choco Fills, Dark Fantasy Choco Fills. choco chunks / nut dipped / Bounce are other products
  "f-dark-fantasy": { kind: "packaged", ok: ["8f2f3846-f804-4688-b655-86727d4e3402", "01354a8a-ffba-4a08-92fe-990283a5bd00", "bddc4d13-e604-40a7-9f10-c66a8bbbe9d4"] },
  // f-md-toned: Mother Dairy Toned Milk. generic toned milk and other dairies are not Mother Dairy
  "f-md-toned": { kind: "packaged", ok: ["5c13d08f-4b76-4d3e-a48c-8fc0c09afb8e"] },
  // f-bournvita: cadbury Bournvita. Bournvita biscuits and Bournville chocolate are other products
  "f-bournvita": { kind: "packaged", ok: ["ef73f69f-810d-43c5-a0fb-eb0f0ee6c449"] },
  // f-kurkure: Kurkure Masala Munch 20rs, Masala munch. c3 is the same product with no brand field
  "f-kurkure": { kind: "packaged", ok: ["074a05cb-403e-4c5b-b4bc-f2b9b9f194b8", "bd8d339f-d290-4ea0-a1c1-f0c2ae3e740f"] },
  // f-bk-whopper: Burger King Whopper, Whopper (Burger King), BURGER KING, WHOPPER, no cheese. with cheese / Jr / Double are other items
  "f-bk-whopper": { kind: "restaurant", ok: ["e22bef6e-596e-4ccf-bdb4-27f83819f348", "e8a49fbe-30b2-4359-8332-5f2ff052b327", "712951e6-aed3-4690-b035-437864ff5f3f"] },
  // f-aloo-gobi: Aloo Gobi
  "f-aloo-gobi": { kind: "dish", ok: ["6761cfd3-a10b-4301-a4b1-bcade24fe62d"] },
  // f-kadhi: Kadhi. CoFID 'Khadhi' is half the kcal: another recipe
  "f-kadhi": { kind: "dish", ok: ["a8f099bf-e9bb-4e9b-8a2e-960ccc25534f"] },
  // f-chicken-tikka: none. tikka masala is a curry, not tikka
  "f-chicken-tikka": { kind: "dish", ok: [] },
  // f-besan-chilla: none. chickpea flour is an ingredient, not the dish
  "f-besan-chilla": { kind: "dish", ok: [] },
  // f-dal-makhani: Dal Makhani. the Kohinoor pack and other dals are not it
  "f-dal-makhani": { kind: "dish", ok: ["c7ce5907-fe6f-4494-b14a-0ba8ce48d103"] },
};
