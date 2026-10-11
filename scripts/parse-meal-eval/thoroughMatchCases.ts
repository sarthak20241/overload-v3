// Eval set: does Thorough log the food the user NAMED, or a catalog row that
// only shares a word with it?
//
// Run with CASE_SET=thorough-match (see run.ts). Each case is one plain, common
// food, the shape where a wrong row is easy to see: "toast" logged as Melba
// toast, "chicken" as chicken feet, a cup of rice as raw rice. The kcal band is
// what the named food, at the named amount, can honestly be. It is wide on
// purpose, so any reasonable row or estimate passes and only a different food
// (or a wrong state, raw vs cooked) fails. forbidNames lists the look-alike
// rows that share a word with the food and are not it.
//
// HELD OUT. Nothing here may be copied into a prompt or a Jev question (see
// feedback: no eval-overfit prompts). A fix that works only because it saw
// these words has measured nothing.

import type { EvalCase } from "./cases";

const one = (
  id: string,
  text: string,
  nameIncludes: string,
  kcal: [number, number],
  forbid: string[],
  nameIncludesAny: string[] = [],
): EvalCase => ({
  id: `tm-${id}`,
  text,
  hour: 13,
  expect: {
    minItems: 1,
    maxItems: 1,
    items: [{ nameIncludes, nameIncludesAny, kcalBetween: kcal }],
    forbidNames: forbid,
  },
});

export const THOROUGH_MATCH_CASES: EvalCase[] = [
  one("toast", "2 slices of toast", "toast", [120, 240], ["melba", "french toast"], ["bread"]),
  one("chicken", "150g chicken", "chicken", [180, 380], ["feet", "liver", "nugget", "gizzard", "skin only"]),
  one("butter", "1 tbsp butter", "butter", [85, 115], ["peanut", "chicken", "milk", "buttermilk", "cookie"]),
  one("curd", "a bowl of curd", "curd", [80, 240], ["shrikhand", "raita", "lassi"], ["dahi", "yogurt", "yoghurt"]),
  one("apple", "1 apple", "apple", [60, 130], ["juice", "pie", "sauce", "chips", "cider", "custard"]),
  one("oj", "200 ml orange juice", "orange", [70, 125], ["drink powder", "concentrate", "squash"]),
  one("milk", "a glass of milk", "milk", [90, 190], ["chocolate", "powder", "condensed", "shake", "coconut"]),
  one("rice", "1 cup of rice", "rice", [150, 320], ["flour", "bran", "cake", "crispies", "noodle"]),
  one("eggs", "2 boiled eggs", "egg", [120, 170], ["yolk", "white", "powder", "noodle", "fried"]),
  one("paneer", "100g paneer", "paneer", [240, 340], ["tikka", "masala", "bhurji", "pakora"]),
  one("banana", "a banana", "banana", [75, 135], ["chips", "bread", "shake", "cake", "dried"]),
  one("almonds", "30g almonds", "almond", [160, 190], ["milk", "butter", "oil", "flour"]),
  one("whey", "1 scoop whey protein", "whey", [95, 150], ["bar", "cookie", "chips"], ["protein"]),
  one("roti", "2 rotis", "roti", [150, 270], ["canai", "naan", "paratha"], ["chapati", "chapatti", "phulka"]),
  one("dal", "a bowl of dal", "dal", [130, 300], ["makhani", "halwa", "pakwan"], ["dhal", "lentil"]),
  one("oats", "100g oats", "oat", [360, 400], ["milk", "cookie", "bar", "cake"]),
  one("pb", "1 tbsp peanut butter", "peanut", [85, 110], ["cookie", "cup", "cracker"]),
  one("sweet-potato", "100g boiled sweet potato", "sweet potato", [70, 100], ["fries", "chips", "pie", "casserole"]),
  one("potato", "1 medium boiled potato", "potato", [90, 180], ["chips", "fries", "salad", "mashed"]),
  one("chicken-breast", "200g grilled chicken breast", "chicken", [280, 380], ["fried", "nugget", "breaded"]),
  one("green-tea", "a cup of green tea", "tea", [0, 10], ["milk", "latte", "iced"]),
  one("honey", "1 tbsp honey", "honey", [55, 70], ["chicken", "cake", "nut"]),
  one("peanuts", "a handful of peanuts", "peanut", [120, 230], ["butter", "oil", "chikki", "brittle"]),
  one("chickpeas", "1 cup cooked chickpeas", "chickpea", [200, 320], ["flour", "hummus", "roasted"], ["chana", "garbanzo"]),
  one("coconut-water", "200 ml coconut water", "coconut", [30, 60], ["milk", "oil", "cream"]),
  one("ghee", "1 tbsp ghee", "ghee", [105, 140], ["rice", "roti"]),
  one("olive-oil", "1 tbsp olive oil", "olive", [110, 130], ["olives,", "pickled"], ["oil"]),
  one("dark-choc", "50g dark chocolate", "chocolate", [250, 320], ["milk chocolate", "drink", "cake", "syrup"]),
  one("spinach", "100g boiled spinach", "spinach", [15, 40], ["paneer", "pie", "souffle"], ["palak"]),
  one("moong", "a bowl of moong dal", "moong", [130, 300], ["halwa", "namkeen", "chilla"], ["mung", "green gram"]),

  // Dishes and everyday phrases. A dish shares words with many rows (its
  // ingredients, other dishes, packaged mixes), which is where a row that is
  // "close by name" is most often a different food.
  one("tea", "a cup of tea", "tea", [25, 120], ["green", "herbal", "iced", "leaves", "dry"], ["chai"]),
  one("dosa", "1 masala dosa", "dosa", [180, 480], ["batter", "mix", "rava"]),
  one("idli", "3 idlis", "idli", [90, 260], ["rava", "mix", "batter", "fried"], ["idly"]),
  one("poha", "a plate of poha", "poha", [180, 420], ["raw", "flakes", "chivda", "namkeen", "dry"]),
  one("upma", "a bowl of upma", "upma", [150, 400], ["rava, raw", "semolina, raw", "mix"]),
  one("bhurji", "egg bhurji with 2 eggs", "egg", [140, 330], ["powder", "noodle", "yolk"], ["bhurji", "scrambled"]),
  one("chicken-curry", "a bowl of chicken curry", "chicken", [200, 520], ["feet", "liver", "nugget", "powder", "paste"]),
  one("rajma", "a bowl of rajma", "rajma", [150, 380], ["raw", "dry", "flour"], ["kidney bean"]),
  one("chole", "a bowl of chole", "chole", [180, 420], ["raw", "dry", "flour", "bhature"], ["chana", "chickpea"]),
  one("aloo-paratha", "1 aloo paratha", "paratha", [180, 380], ["frozen", "lachha"]),
  one("maggi", "a packet of maggi", "maggi", [280, 420], ["masala-e-magic", "cubes", "ketchup"], ["noodle"]),
  one("khichdi", "a bowl of khichdi", "khichdi", [180, 420], ["raw", "mix"], ["khichri"]),
  one("cold-coffee", "a glass of cold coffee", "coffee", [100, 330], ["beans", "powder", "instant", "black"]),
  one("veg-sandwich", "a veg sandwich", "sandwich", [180, 420], ["chicken", "egg", "bread, white"]),
  one("lassi", "a glass of sweet lassi", "lassi", [150, 400], ["salted", "mango"]),
];
