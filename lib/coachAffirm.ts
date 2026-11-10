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
 * True when the last question in Drona's message asks whether to build the
 * plan. A clarifying question ("How many days can you train?", "Do you want
 * to build up your legs first?") is not one.
 */
export function asksToBuild(text: string | null | undefined): boolean {
  const t = (text ?? '').trim();
  // Every question in the closing paragraph: Drona may close with two
  // ("Want me to build it? Or change the days first?").
  const last = t.split(/\n\s*\n/).pop() ?? '';
  const questions = last.match(/[^.!?\n]*\?/g) ?? [];
  // An offer to build THE plan: "want me to build it", "shall I build this",
  // "should I build the program". A bare "build" ("build up your legs first?")
  // or a question that only mentions building ("can I build it around your
  // race?") is not one. Drona's discuss rules phrase the offer this way.
  const offer = /\b(want me to|shall i|should i|ready for me to|happy for me to|ok for me to|okay for me to|go ahead and) build (it|this|that|the (program|plan|phases?))\b/i;
  return questions.some((q) => offer.test(q));
}
