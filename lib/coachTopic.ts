/**
 * Coach topics: the chat opened from something in the app (a "Coach noticed"
 * card, a Drona card's "Talk it through", the readiness line, a health metric,
 * a session preview).
 *
 * These used to auto-send a question in the user's voice ("My bench hasn't
 * improved in 4 sessions..."), so the chat opened on the user telling Drona
 * what Drona had just shown them. Now the app hands Drona the topic as a hidden
 * turn and Drona speaks first: he already knows, so he opens with it.
 *
 * The hidden turn is stored with the conversation (flagged by `context` on the
 * message), so a follow-up after an app restart still carries it. The chat
 * never renders it.
 *
 * Pure: no React, no network.
 */

export type CoachTopicSource =
  | 'insight'
  | 'drona_card'
  | 'readiness'
  | 'metric'
  | 'routine_preview';

export interface CoachTopic {
  /** Which surface the user tapped. Tells Drona where they came from. */
  source: CoachTopicSource;
  /** Short name of the topic. Titles the chat in Past chats. */
  title: string;
  /** What the app showed the user, as plain facts. */
  facts: string[];
  /** The question this raises, as the user might ask it. Never sent as their words. */
  ask: string;
}

const WHERE: Record<CoachTopicSource, string> = {
  insight: 'a "Coach noticed" card on their dashboard',
  drona_card: 'a card from you ("Talk it through")',
  readiness: "today's readiness line on the Health screen",
  metric: 'one of their health numbers on the Health screen',
  routine_preview: 'the Ask Drona button on a session preview',
};

/** Marks the hidden turn. The chat UI keys off the message flag, not this text. */
export const TOPIC_MARKER = '[OPENED FROM THE APP. The user did not type this.]';

/** The hidden user-role turn that opens a topic chat. */
export function coachTopicContext(topic: CoachTopic): string {
  // A fact can come from a row the type says is a string but the database
  // left empty (readiness rationale), so read it defensively.
  const facts = topic.facts.map((f) => (typeof f === 'string' ? f.trim() : '')).filter(Boolean);
  return [
    TOPIC_MARKER,
    `The user tapped ${WHERE[topic.source]} and this chat opened. Nothing has been said yet.`,
    '',
    'What the app showed them:',
    ...(facts.length ? facts.map((f) => `- ${f}`) : [`- ${topic.title}`]),
    '',
    `What they most likely want to know, as they might ask it: "${topic.ask.trim()}"`,
    '',
    'You speak first. You already know this, so open with it:',
    '- If you check their data with your tools, do it before you write anything, so your message is written once, with the numbers in hand.',
    '- Your first words are a short greeting that names what you noticed.',
    '- Then say why it matters and give one clear next step. Under about 120 words: they can ask for more.',
    '- End with one question about what they want to do.',
    '- Do not say they asked, and do not quote or mention this note.',
  ].join('\n');
}

const NARRATION_MAX = 160;
// First-person "I am about to look this up", not a word that merely appears
// in a greeting ("worth a look" stays).
const NARRATION = /\b(let me|give me a (sec|second|moment)|i'm (checking|pulling|looking|digging|grabbing|reviewing)|(checking|pulling|looking|digging|grabbing|reviewing) (up|into|through))\b/i;

/**
 * Is this Drona's "let me check your numbers" line, written before his first
 * tool call? An opening drops it, since he writes his greeting once he has
 * the numbers. One short line that says he is looking something up; a bare
 * greeting written before the tools is kept.
 */
export function isOpeningNarration(text: string): boolean {
  const said = text.trim();
  return said.length > 0 && said.length <= NARRATION_MAX && !said.includes('\n') && NARRATION.test(said);
}

/** A "Coach noticed" card. Its question is the card's own `coachPrompt`. */
export function insightTopic(insight: { title: string; body: string; coachPrompt: string }): CoachTopic {
  return {
    source: 'insight',
    title: insight.title,
    facts: [insight.title, insight.body],
    ask: insight.coachPrompt,
  };
}

/** A Drona card's "Talk it through". The card wrote its own opening question. */
export function dronaCardTopic(card: {
  title: string;
  body: string;
  evidence?: { label: string; value: string }[] | null;
  payload?: { prompt?: string } | null;
}): CoachTopic {
  return {
    source: 'drona_card',
    title: card.title,
    facts: [
      `Your card said: ${card.title}. ${card.body}`,
      ...(card.evidence ?? []).map((e) => `${e.label}: ${e.value}`),
    ],
    ask: card.payload?.prompt || card.title,
  };
}
