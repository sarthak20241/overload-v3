// Labels for Jev question 1 ("what kind of food"). `ok` lists every kind that
// is an acceptable answer, first = the best one. A second acceptable kind is
// there only when the line honestly reads both ways AND both lead to a safe
// outcome downstream (plain peanut butter may match a USDA row; packaged with
// no brand can match nothing and goes to the web - neither serves a wrong row).
//
// TUNE may shape the policy text; FRESH never does. None of these lines may
// appear in preciseMatch.ts (feedback: no eval-overfit prompts).

import type { FoodKind } from "../../supabase/functions/ai-coach/preciseMatch.ts";

export interface KindCase {
  name: string;
  brand: string | null;
  ok: FoodKind[];
  group: "tune" | "fresh";
}

export const KIND_CASES: KindCase[] = [
  // ── TUNE ──
  { name: "banana", brand: null, ok: ["plain"], group: "tune" },
  { name: "cashews", brand: null, ok: ["plain"], group: "tune" },
  { name: "cucumber", brand: null, ok: ["plain"], group: "tune" },
  { name: "rolled oats", brand: null, ok: ["plain"], group: "tune" },
  { name: "paneer", brand: null, ok: ["plain"], group: "tune" },
  { name: "curd", brand: null, ok: ["plain"], group: "tune" },
  { name: "boiled sweet potato", brand: null, ok: ["plain"], group: "tune" },
  { name: "cooked brown rice", brand: null, ok: ["plain"], group: "tune" },
  { name: "raw chicken breast", brand: null, ok: ["plain"], group: "tune" },
  { name: "peanut butter", brand: null, ok: ["plain", "packaged"], group: "tune" },
  { name: "boiled chana", brand: null, ok: ["plain"], group: "tune" },
  { name: "green tea", brand: null, ok: ["plain"], group: "tune" },
  { name: "Parle-G biscuits", brand: "Parle", ok: ["packaged"], group: "tune" },
  { name: "cheese slice", brand: "Amul", ok: ["packaged"], group: "tune" },
  { name: "Maggi masala noodles", brand: "Maggi", ok: ["packaged"], group: "tune" },
  { name: "Lay's classic salted chips", brand: "Lay's", ok: ["packaged"], group: "tune" },
  { name: "aloo bhujia", brand: "Haldiram's", ok: ["packaged"], group: "tune" },
  { name: "low fat paneer", brand: "Amul", ok: ["packaged"], group: "tune" },
  { name: "KitKat", brand: "Nestle", ok: ["packaged"], group: "tune" },
  { name: "frozen french fries", brand: "McCain", ok: ["packaged"], group: "tune" },
  { name: "McAloo Tikki burger", brand: "McDonald's", ok: ["restaurant"], group: "tune" },
  { name: "farmhouse pizza", brand: "Domino's", ok: ["restaurant"], group: "tune" },
  { name: "masala chai", brand: "Chaayos", ok: ["restaurant"], group: "tune" },
  { name: "Saravana Bhavan masala dosa", brand: null, ok: ["restaurant"], group: "tune" },
  { name: "chole bhature", brand: null, ok: ["dish"], group: "tune" },
  { name: "rajma chawal", brand: null, ok: ["dish"], group: "tune" },
  { name: "masala dosa", brand: null, ok: ["dish"], group: "tune" },
  { name: "paneer butter masala", brand: null, ok: ["dish"], group: "tune" },
  { name: "egg bhurji", brand: null, ok: ["dish"], group: "tune" },
  { name: "vada pav", brand: null, ok: ["dish"], group: "tune" },
  { name: "homemade pizza", brand: null, ok: ["dish"], group: "tune" },
  { name: "curd rice", brand: null, ok: ["dish"], group: "tune" },

  // ── FRESH ──
  { name: "pear", brand: null, ok: ["plain"], group: "fresh" },
  { name: "walnuts", brand: null, ok: ["plain"], group: "fresh" },
  { name: "steamed broccoli", brand: null, ok: ["plain"], group: "fresh" },
  { name: "tofu", brand: null, ok: ["plain"], group: "fresh" },
  { name: "cooked quinoa", brand: null, ok: ["plain"], group: "fresh" },
  { name: "roasted peanuts", brand: null, ok: ["plain"], group: "fresh" },
  { name: "skimmed milk", brand: null, ok: ["plain"], group: "fresh" },
  { name: "fried egg", brand: null, ok: ["plain", "dish"], group: "fresh" },
  { name: "black coffee", brand: null, ok: ["plain"], group: "fresh" },
  { name: "coconut water", brand: null, ok: ["plain"], group: "fresh" },
  { name: "Dark Fantasy choco fills", brand: "Sunfeast", ok: ["packaged"], group: "fresh" },
  { name: "toned milk", brand: "Mother Dairy", ok: ["packaged"], group: "fresh" },
  { name: "Bournvita", brand: "Cadbury", ok: ["packaged"], group: "fresh" },
  { name: "Kurkure masala munch", brand: "Kurkure", ok: ["packaged"], group: "fresh" },
  { name: "rasgulla tin", brand: "Haldiram's", ok: ["packaged"], group: "fresh" },
  { name: "aamras", brand: "Paper Boat", ok: ["packaged"], group: "fresh" },
  { name: "Whopper", brand: "Burger King", ok: ["restaurant"], group: "fresh" },
  { name: "steamed chicken momos", brand: "Wow Momo", ok: ["restaurant"], group: "fresh" },
  { name: "cappuccino", brand: "Cafe Coffee Day", ok: ["restaurant"], group: "fresh" },
  { name: "Barbeque Nation paneer tikka", brand: null, ok: ["restaurant"], group: "fresh" },
  { name: "aloo gobi", brand: null, ok: ["dish"], group: "fresh" },
  { name: "kadhi", brand: null, ok: ["dish"], group: "fresh" },
  { name: "chicken tikka", brand: null, ok: ["dish"], group: "fresh" },
  { name: "besan chilla", brand: null, ok: ["dish"], group: "fresh" },
  { name: "dal makhani", brand: null, ok: ["dish"], group: "fresh" },
  { name: "pani puri", brand: null, ok: ["dish"], group: "fresh" },
  { name: "sprouts salad", brand: null, ok: ["dish"], group: "fresh" },
];
