// The spelling hint sent with each clip: words the engine should get right.
//
// Food clips: the user's own foods first (the names they log, most recent
// first), then a short list of Indian dishes and measures that general
// speech models often mishear ("panir", "dal makini"). Chat clips: training
// words, then the same food list.
//
// Every term is one line with no < or >. The OpenAI docs say a keyword with
// either, or a line break, makes it reject the WHOLE request, so a single odd
// food name would otherwise break voice for that user.

import type { VoicePurpose } from "./stt.ts";

/** Hint size. Unpublished limit on the vendor side; 80 short terms is small. */
export const MAX_TERMS = 80;
const MAX_TERM_CHARS = 40;

export const INDIAN_FOODS: readonly string[] = [
  "roti", "chapati", "phulka", "paratha", "aloo paratha", "puri", "bhatura", "naan",
  "dal", "dal makhani", "dal tadka", "moong dal", "masoor dal", "toor dal", "rajma", "chole",
  "chana", "kadhi", "sambar", "rasam", "khichdi", "biryani", "pulao", "jeera rice", "curd rice",
  "paneer", "paneer tikka", "palak paneer", "paneer bhurji", "sabzi", "bhindi", "aloo gobi",
  "baingan bharta", "poha", "upma", "idli", "dosa", "masala dosa", "uttapam", "vada", "appam",
  "dhokla", "thepla", "besan chilla", "pav bhaji", "vada pav", "samosa", "pakora", "makhana",
  "sattu", "dahi", "raita", "lassi", "chaas", "ghee", "chai", "kheer", "halwa", "gulab jamun",
  "jalebi", "ladoo", "katori", "Maggi",
];

const TRAINING_TERMS: readonly string[] = [
  "Drona", "RDL", "RPE", "PR", "deload", "superset", "hypertrophy", "progressive overload",
  "creatine", "whey", "macros", "TDEE", "Overload",
];

/** One line, no angle brackets, single spaces, at most 40 characters. */
export function sanitizeTerm(raw: string): string {
  return raw
    .replace(/[<>]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TERM_CHARS)
    .trim();
}

/** User foods first, then the fixed lists. Deduped ignoring case, at most 80. */
export function buildVocabulary(userFoods: string[], purpose: VoicePurpose): string[] {
  const fixed = purpose === "chat" ? [...TRAINING_TERMS, ...INDIAN_FOODS] : [...INDIAN_FOODS];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(purpose === "food" ? userFoods : []), ...fixed]) {
    // A term with a line break inside was two terms run together, or junk.
    if (/[\r\n]/.test(raw)) continue;
    const term = sanitizeTerm(raw);
    if (term.length < 2 || !/\p{L}/u.test(term)) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/** What the speaker is doing, for the engine's prompt. The docs say the
 *  prompt should match the audio's language, and many users mix Hindi and
 *  English, so it asks for Hindi words in Latin letters, the way the app's
 *  food parser and Drona read them. */
export function contextFor(purpose: VoicePurpose): string {
  return purpose === "food"
    ? "Someone telling their food diary what they ate, often mixing Hindi and English. " +
      "Hindi words are written in Latin letters, as said: do roti aur ek katori dal, 200 gram paneer."
    : "Someone asking their strength coach about training, food or recovery, often mixing Hindi and English. " +
      "Hindi words are written in Latin letters, as said.";
}
