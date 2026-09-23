// Keep a food-bar stream from going quiet.
//
// Seen live 2026-09-23 (02:42-02:46 UTC): three messages in a row showed "Lost
// the connection" on the phone while the server had answered every one with a
// 200 in about 5 seconds. Over the three weeks before, every failed stream was
// one that sent NOTHING until its final answer (a chat reply, a save card): 2
// of 25 such streams failed, against 0 of 68 streams that paint food rows early.
// Somewhere between the phone and us, a connection that carries no bytes for a
// few seconds gets dropped.
//
// An SSE comment line (": ping") is legal on every stream and ignored by every
// client: the app skips any frame without an `event:` and `data:` line, which
// is how every build since streaming shipped reads the stream. So this needs no
// capability flag and no app update.

export const HEARTBEAT_MS = 2000;
export const HEARTBEAT_FRAME = ": ping\n\n";

/**
 * Write a ping now and every `everyMs` until the returned stop function runs.
 * The first ping goes out at once so the response starts moving immediately,
 * not only after the first 2 seconds of silence. A write that throws (the
 * client hung up) is swallowed: a heartbeat must never fail the parse.
 */
export function startHeartbeat(write: (frame: string) => void, everyMs = HEARTBEAT_MS): () => void {
  const beat = () => {
    try {
      write(HEARTBEAT_FRAME);
    } catch {
      // Nobody is listening any more. The parse carries on regardless.
    }
  };
  beat();
  const id = setInterval(beat, everyMs);
  return () => clearInterval(id);
}
