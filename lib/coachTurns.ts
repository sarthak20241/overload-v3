/**
 * Which turns of the coach chat go to the model, and in what order.
 *
 * Pure: no React, no network. AICoachModal's ChatScreen calls it on every send.
 */

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Set on a topic chat's hidden first turn (lib/coachTopic). */
  context?: { title: string };
}

export interface SentTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * @param chat      the chat as it stands, this turn's user message included
 * @param maxTurns  sliding window over the history, so long chats stay bounded
 * @param workoutOpener  the live session recap, in workout mode
 * @param skipIds   app-made greetings that are shown but never sent
 */
export function sentTurns(
  chat: ChatTurn[],
  opts: { maxTurns: number; workoutOpener?: string | null; skipIds?: string[] },
): SentTurn[] {
  const skip = new Set(opts.skipIds ?? []);
  const all = chat.filter((m) => !skip.has(m.id));
  // A topic chat's hidden context is its first turn: pinned ahead of the
  // window, so a long chat never forgets what it opened on.
  const pinned = all[0]?.context ? all[0] : null;
  const window = (pinned ? all.slice(1) : all).slice(-opts.maxTurns);
  const opener = opts.workoutOpener ?? pinned?.content ?? null;
  // A plain chat starts on the assistant greeting, so a window can start on an
  // assistant turn. The first message must be a user turn: drop a leading
  // assistant unless an opener (a user turn) goes ahead of it.
  const turns = !opener && window[0]?.role === 'assistant' ? window.slice(1) : window;
  const out = turns.map((m) => ({ role: m.role, content: m.content }));
  return opener ? [{ role: 'user', content: opener }, ...out] : out;
}
