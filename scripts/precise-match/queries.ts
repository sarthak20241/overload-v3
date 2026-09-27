// The food lines the Precise match eval asks about, as the split step would
// extract them (name + brand, no quantity). Labels live in cases.ts, written
// by hand AFTER looking at what our search really returns for each line
// (candidates.json, built by build-candidates.mts).
//
// TUNE may be looked at while writing the Jev policy in preciseMatch.ts.
// FRESH never is: it exists to measure the policy on lines it was not shaped
// on. Add new FRESH lines after any change the old ones inspired.
//
// NOTHING IN THIS FILE MAY BE PUT IN A PROMPT (feedback: no eval-overfit).

export interface Query {
  id: string;
  name: string;
  brand: string | null;
  group: "tune" | "fresh";
}

export const QUERIES: Query[] = [
  // ── TUNE: plain ──
  { id: "t-banana", name: "banana", brand: null, group: "tune" },
  { id: "t-cashews", name: "cashews", brand: null, group: "tune" },
  { id: "t-cucumber", name: "cucumber", brand: null, group: "tune" },
  { id: "t-oats", name: "rolled oats", brand: null, group: "tune" },
  { id: "t-paneer", name: "paneer", brand: null, group: "tune" },
  { id: "t-curd", name: "curd", brand: null, group: "tune" },
  { id: "t-sweet-potato", name: "boiled sweet potato", brand: null, group: "tune" },
  { id: "t-brown-rice", name: "cooked brown rice", brand: null, group: "tune" },
  { id: "t-raw-chicken", name: "raw chicken breast", brand: null, group: "tune" },
  { id: "t-peanut-butter", name: "peanut butter", brand: null, group: "tune" },
  // ── TUNE: packaged ──
  { id: "t-parle-g", name: "Parle-G biscuits", brand: "Parle", group: "tune" },
  { id: "t-amul-cheese", name: "cheese slice", brand: "Amul", group: "tune" },
  { id: "t-maggi", name: "Maggi masala noodles", brand: "Maggi", group: "tune" },
  { id: "t-lays", name: "Lay's classic salted chips", brand: "Lay's", group: "tune" },
  { id: "t-bhujia", name: "aloo bhujia", brand: "Haldiram's", group: "tune" },
  { id: "t-low-fat-paneer", name: "low fat paneer", brand: "Amul", group: "tune" },
  // ── TUNE: restaurant ──
  { id: "t-mcaloo", name: "McAloo Tikki burger", brand: "McDonald's", group: "tune" },
  { id: "t-dominos", name: "farmhouse pizza", brand: "Domino's", group: "tune" },
  // ── TUNE: dish ──
  { id: "t-chole-bhature", name: "chole bhature", brand: null, group: "tune" },
  { id: "t-rajma-chawal", name: "rajma chawal", brand: null, group: "tune" },
  { id: "t-masala-dosa", name: "masala dosa", brand: null, group: "tune" },
  { id: "t-pbm", name: "paneer butter masala", brand: null, group: "tune" },
  { id: "t-egg-bhurji", name: "egg bhurji", brand: null, group: "tune" },

  // ── FRESH: plain ──
  { id: "f-pear", name: "pear", brand: null, group: "fresh" },
  { id: "f-walnuts", name: "walnuts", brand: null, group: "fresh" },
  { id: "f-broccoli", name: "steamed broccoli", brand: null, group: "fresh" },
  { id: "f-tofu", name: "tofu", brand: null, group: "fresh" },
  { id: "f-quinoa", name: "cooked quinoa", brand: null, group: "fresh" },
  { id: "f-roasted-peanuts", name: "roasted peanuts", brand: null, group: "fresh" },
  { id: "f-skimmed-milk", name: "skimmed milk", brand: null, group: "fresh" },
  { id: "f-fried-egg", name: "fried egg", brand: null, group: "fresh" },
  // ── FRESH: packaged ──
  { id: "f-dark-fantasy", name: "Dark Fantasy choco fills", brand: "Sunfeast", group: "fresh" },
  { id: "f-md-toned", name: "toned milk", brand: "Mother Dairy", group: "fresh" },
  { id: "f-bournvita", name: "Bournvita", brand: "Cadbury", group: "fresh" },
  { id: "f-kurkure", name: "Kurkure masala munch", brand: "Kurkure", group: "fresh" },
  // ── FRESH: restaurant ──
  { id: "f-bk-whopper", name: "Whopper", brand: "Burger King", group: "fresh" },
  // ── FRESH: dish ──
  { id: "f-aloo-gobi", name: "aloo gobi", brand: null, group: "fresh" },
  { id: "f-kadhi", name: "kadhi", brand: null, group: "fresh" },
  { id: "f-chicken-tikka", name: "chicken tikka", brand: null, group: "fresh" },
  { id: "f-besan-chilla", name: "besan chilla", brand: null, group: "fresh" },
  { id: "f-dal-makhani", name: "dal makhani", brand: null, group: "fresh" },
];
