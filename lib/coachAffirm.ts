/**
 * When a program, plan or workout chat may force its terminal tool.
 *
 * isPureAffirmative: the user's turn is just "yes, go" ("build it", "sounds
 * good"). RefineChatScreen then sets forceTool, so the model builds through
 * tool_use instead of writing the plan as unsaveable chat text. Conservative
 * on purpose: "yes but bump volume" is a substantive turn and must not force.
 *
 * asksToBuild: Drona's last question asks whether to build (its discuss rules
 * end a proposal with "Want me to build it now, or adjust the shape first?").
 * The goal intake's Build it / Change something buttons show only then, never
 * under a clarifying question, since BUILD_IT forces the build.
 *
 * Pure. Covered by lib/coachAffirm.test.ts.
 */

/** The goal intake's Build it button sends this; it must stay a pure affirmative. */
export const BUILD_IT = 'Build it';

export function isPureAffirmative(text: string): boolean {
  // Strip trailing punctuation and lowercase. Keep length budget tight —
  // anything past ~30 chars is almost certainly carrying additional intent
  // beyond the affirmation.
  const clean = text.trim().toLowerCase().replace(/[.!?,]+$/, '');
  if (clean.length === 0 || clean.length > 30) return false;
  const patterns: RegExp[] = [
    /^yes$/,
    /^yeah$/,
    /^yep$/,
    /^yup$/,
    /^sure$/,
    /^ok$/,
    /^okay$/,
    /^go$/,
    /^go ahead$/,
    /^do it$/,
    /^let'?s do it$/,
    /^let'?s go$/,
    /^sounds good$/,
    /^looks good$/,
    /^perfect$/,
    /^great$/,
    /^alright$/,
    /^please$/,
    /^yes please$/,
    /^yes go ahead$/,
    /^go for it$/,
    /^proceed$/,
    /^definitely$/,
    /^absolutely$/,
    /^confirm$/,
    // "build" / "build it" family — common in discuss flows where the user
    // is approving the proposed structure and asking for the build. Mirror
    // each variant for yes/yeah/yep/yup + build to catch typical phrasings
    // like "yep build", "yes build it", "yeah build it now".
    /^build$/,
    /^build it$/,
    /^build it now$/,
    /^build the (plan|workout)$/,
    /^build it please$/,
    /^(yes|yeah|yep|yup|ok|okay|sure) build$/,
    /^(yes|yeah|yep|yup|ok|okay|sure) build it$/,
    /^(yes|yeah|yep|yup|ok|okay|sure) build it now$/,
    /^(yes|yeah|yep|yup|ok|okay|sure)[, ]+(go|do it|build it)$/,
    /^make it$/,
    /^create it$/,
    /^let'?s build$/,
    /^let'?s build it$/,
    /^confirmed$/,
    /^finalize$/,
    /^finalise$/,
    /^generate$/,
    /^generate it$/,
    /^generate the (plan|workout)$/,
  ];
  return patterns.some(p => p.test(clean));
}

/**
 * True when the last question in Drona's message asks about building. A
 * clarifying question ("How many days can you train?") is not one.
 */
export function asksToBuild(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  const q = t.lastIndexOf('?');
  if (q < 0) return false;
  // The sentence that question mark closes: back to the previous . ! ? or line break.
  const before = t.slice(0, q);
  const start = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'), before.lastIndexOf('\n')) + 1;
  return /\bbuild\b/i.test(t.slice(start, q));
}
