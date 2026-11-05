// Grades one food box outcome against its case. Pure: no model, no network.
//
// Every check is a fact about the outcome a user would see: is the line still
// on the card, is the number in range, did the reply claim a save that never
// happened. Nothing here asks how the pipeline decided, so a change of design
// (router + parser today, one agent later) is scored by the same rules.

import { claimsAction } from "../../supabase/functions/ai-coach/foodIntent.ts";
import { CARD_ACTIONS, type CheckResult, type FoodBoxCase, type Grade, type Line, type Outcome, type Range } from "./types.ts";

const re = (src: string) => new RegExp(src, "i");

export function inRange(v: number | null | undefined, r: Range): boolean {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  const [lo, hi] = r;
  return (lo === null || v >= lo) && (hi === null || v <= hi);
}

const showRange = (r: Range) => `${r[0] ?? "-inf"}..${r[1] ?? "inf"}`;

/** Lowercase, words only, simple plural folded: "Boiled Eggs" and "boiled egg" are one name.
 *  Bracketed text is dropped ("Rice (cooked)" is rice), unless the whole name
 *  is in brackets: then the bracket text IS the name, never an empty key. */
export function nameKey(name: string): string {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
      .join(" ");
  return words(name.replace(/\([^)]*\)/g, " ")) || words(name);
}

/** Which action a reply claims, by its verb: "saved" claims a save, "logged"
 *  or "added" claims a log. A claim passes only when THAT action happened, so
 *  "I've saved it" after a plain edit is still a false claim. */
function claimedActions(text: string): Set<"save" | "log"> {
  // Done or doing forms only ("saved", "adding"): a bare "add" or "store" is
  // an offer or plain talk ("I'll add that if you like", "store it cold").
  // Judged only when claimsAction already found a claim in the reply.
  const out = new Set<"save" | "log">();
  if (/\b(saved|saving|stored)\b/i.test(text)) out.add("save");
  if (/\b(logged|logging|added|adding|recorded|recording|updated|updating)\b/i.test(text)) out.add("log");
  return out;
}

function linesOf(o: Outcome): Line[] {
  return o.card ?? [];
}

function sameCard(a: Line[] | null, b: Line[] | null): boolean {
  const norm = (c: Line[] | null) =>
    (c ?? []).map((l) => `${nameKey(l.name)}|${Math.round(l.kcal)}|${l.grams ?? ""}|${l.quantity ?? ""}`).sort().join("\n");
  return norm(a) === norm(b);
}

export function grade(c: FoodBoxCase, o: Outcome): Grade {
  const checks: CheckResult[] = [];
  const add = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, ...(detail ? { detail } : {}) });
  const e = c.expect;
  const card = linesOf(o);

  for (const a of e.does ?? []) add(`does:${a}`, o.actions.includes(a), `actions=[${o.actions.join(",")}]`);
  for (const a of e.mustNot ?? []) add(`mustNot:${a}`, !o.actions.includes(a), `actions=[${o.actions.join(",")}]`);

  for (const k of e.keepLines ?? []) {
    add(`keep:${k}`, card.some((l) => re(k).test(l.name)), `card=[${card.map((l) => l.name).join(" | ")}]`);
  }
  for (const k of e.removeLines ?? []) {
    add(`remove:${k}`, !card.some((l) => re(k).test(l.name)));
  }

  for (const spec of e.lines ?? []) {
    const hits = card.filter((l) => re(spec.match).test(l.name));
    const label = `line:${spec.match}`;
    if (hits.length === 0) {
      add(label, false, `no line matches; card=[${card.map((l) => l.name).join(" | ")}]`);
      continue;
    }
    // EVERY matching line is judged, not only the first: a stray duplicate
    // with the wrong numbers must fail even when the case does not ask for
    // noDuplicates. Judging only the first once let "Latte Coffee" (135 kcal)
    // stand in for a 2 kcal hot coffee.
    const bad: string[] = [];
    for (const l of hits) {
      const tag = hits.length > 1 ? `"${l.name}": ` : "";
      if (spec.kcal && !inRange(l.kcal, spec.kcal)) bad.push(`${tag}kcal ${l.kcal} not in ${showRange(spec.kcal)}`);
      if (spec.grams && !inRange(l.grams ?? null, spec.grams)) bad.push(`${tag}grams ${l.grams ?? "none"} not in ${showRange(spec.grams)}`);
      if (spec.protein_g && !inRange(l.protein_g ?? null, spec.protein_g)) {
        bad.push(`${tag}protein ${l.protein_g ?? "none"} not in ${showRange(spec.protein_g)}`);
      }
      if (spec.source && !spec.source.includes(l.source ?? "")) bad.push(`${tag}source ${l.source ?? "none"} not in [${spec.source.join(",")}]`);
      // Strict: a spec that names a meal needs a line that says which meal it
      // is in. An adapter that drops the meal must not pass by saying nothing.
      if (spec.meal && l.meal !== spec.meal) bad.push(`${tag}meal ${l.meal ?? "missing"} is not ${spec.meal}`);
    }
    add(label, bad.length === 0, bad.join("; ") || undefined);
  }

  if (e.noDuplicates) {
    const seen = new Map<string, number>();
    for (const l of card) seen.set(nameKey(l.name), (seen.get(nameKey(l.name)) ?? 0) + 1);
    const dupNames = [...seen].filter(([, n]) => n > 1).map(([k]) => k);
    const dupSpecs = (e.lines ?? []).filter((s) => card.filter((l) => re(s.match).test(l.name)).length > 1).map((s) => s.match);
    add("noDuplicates", dupNames.length === 0 && dupSpecs.length === 0, [...dupNames, ...dupSpecs].join(", ") || undefined);
  }

  if (e.lineCount) add(`lineCount ${showRange(e.lineCount)}`, inRange(card.length, e.lineCount), `got ${card.length}`);
  if (e.totalKcal) {
    const total = Math.round(card.reduce((t, l) => t + (l.kcal || 0), 0));
    add(`totalKcal ${showRange(e.totalKcal)}`, inRange(total, e.totalKcal), `got ${total}`);
  }
  if (e.cardUnchanged) add("cardUnchanged", sameCard(c.thread.card, o.card));

  if (e.reply) {
    const text = o.reply ?? "";
    for (const m of e.reply.mustMention ?? []) add(`reply mentions /${m}/`, re(m).test(text), text.slice(0, 120) || "(no reply)");
    for (const m of e.reply.mustNotSay ?? []) add(`reply avoids /${m}/`, !re(m).test(text));
    if (e.reply.noFalseClaim) {
      const changedCard = o.actions.some((a) => CARD_ACTIONS.includes(a));
      const saved = o.actions.includes("save");
      let honest = true;
      if (text && claimsAction(text)) {
        const claimed = claimedActions(text);
        honest = claimed.size === 0
          ? changedCard || saved
          : (!claimed.has("save") || saved) && (!claimed.has("log") || changedCard);
      }
      add("reply makes no false claim", honest, text.slice(0, 120));
    }
  }

  if (e.savedMeal) {
    const s = o.savedMeal;
    if (!s) add("savedMeal", false, "nothing saved");
    else {
      const bad: string[] = [];
      if (e.savedMeal.kcal && !inRange(s.kcal, e.savedMeal.kcal)) bad.push(`kcal ${s.kcal} not in ${showRange(e.savedMeal.kcal)}`);
      if (e.savedMeal.proteinMin !== undefined && !(s.protein_g >= e.savedMeal.proteinMin)) bad.push(`protein ${s.protein_g} < ${e.savedMeal.proteinMin}`);
      if (e.savedMeal.nameMatch && !re(e.savedMeal.nameMatch).test(s.name)) bad.push(`name "${s.name}"`);
      add("savedMeal", bad.length === 0, bad.join("; ") || undefined);
    }
  }

  return { id: c.id, pass: checks.length > 0 && checks.every((k) => k.pass), checks };
}
