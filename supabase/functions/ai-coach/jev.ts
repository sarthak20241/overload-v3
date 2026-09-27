// TypeSafe "System One" client (Jev). A decision model, not a chat model: you
// hand it a state plus typed questions and it returns a typed answer with a
// CALIBRATED probability distribution. That last part is the reason it is here.
// Asking Claude "how confident are you" returns a word it chose; Jev returns a
// number you can threshold, tune on real data, and put in an if statement.
//
// What it is good at, and what it must never be asked (from TypeSafe's own
// jaggedness page for jev-1.13, which is refreshingly blunt):
//   - GOOD: picking one option from a closed list, judging whether a statement
//     holds, rating against described levels. Semantic judgement.
//   - BAD:  arithmetic of any kind ("Jev is not a calculator"), counting,
//     comparing dates, and generating text. Every one of those stays where it
//     already lives: in our code, or in Claude.
// So Jev decides WHICH; it never decides HOW MANY. Grams, Atwater and scaling
// remain untouched in verifyItems.
//
// Runtime-agnostic on purpose, exactly like parseMeal.ts: no Deno globals, no
// jsr:/https: imports, fetch injected. That is what lets the eval harness drive
// the real code from Node.

/** A single option's rubric. `null` when the name says it all. */
export type JevCriterion = string | Record<string, unknown> | unknown[] | null;

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string | Record<string, unknown>;
  /** Option key to rubric. Max 255 options per the API. */
  criteria: Record<string, JevCriterion>;
}

export interface JevNoulQuestion {
  type: "noul";
  instructions: string | Record<string, unknown>;
  criteria?: { true?: string; false?: string };
}

export interface JevScoreQuestion {
  type: "score";
  instructions: string | Record<string, unknown>;
  /** Ordered level descriptions, 2 to 10 of them. */
  criteria: string[];
}

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion | JevScoreQuestion;

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface JevNoulAnswer {
  type: "noul";
  /** 0 = no, 1 = yes. Carries NO confidence: a noul near 0.5 means "as likely
   *  as not", which is itself the uncertainty signal. */
  noul: number;
}

export interface JevScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

export interface JevResponse {
  /** The versioned id that actually answered, e.g. "jev-1.13.0". Worth logging:
   *  an alias moves under you, and a confidence threshold tuned on one version
   *  is not owed to the next. */
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** Pinned rather than `jev-latest`. Aliases move when a release ships, and our
 *  thresholds are tuned against a specific version's calibration. Moving is a
 *  deliberate act with an eval run behind it, not something that happens to us
 *  overnight. */
export const JEV_MODEL = "jev-1.13.0";

export interface JevDeps {
  apiKey: string;
  model?: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
  /** Stops the call when the caller no longer wants the answer, same contract
   *  as parseMeal's: a client that navigates away should stop the work, not
   *  just stop reading it. */
  abortSignal?: AbortSignal;
  log?: (msg: string) => void;
}

/** Why a call produced nothing. Callers branch on this rather than on a thrown
 *  error, because every one of these means the same thing to them: no decision
 *  from Jev, fall down the ladder. Kept distinct so the logs can tell a missing
 *  key (our misconfiguration) from a 429 (their capacity) from a timeout. */
export type JevFailure =
  | "no_key"
  | "auth"
  | "invalid_request"
  | "rate_limited"
  | "overloaded"
  | "timeout"
  | "http_error"
  | "bad_response";

export type JevResult =
  | { ok: true; response: JevResponse }
  | { ok: false; failure: JevFailure; detail: string };

/** 429 and 529 are the two the API documents as "retry with backoff". Everything
 *  else is either our fault (401/422) or will not change on a retry. Two
 *  attempts total: this sits in front of a user waiting for a meal to parse, so
 *  a long backoff ladder would cost more than the fallback it is protecting. */
const RETRYABLE = new Set([429, 529]);
const MAX_ATTEMPTS = 2;
const RETRY_BASE_MS = 250;

function failureFor(status: number): JevFailure {
  if (status === 401 || status === 403) return "auth";
  if (status === 422 || status === 400) return "invalid_request";
  if (status === 429) return "rate_limited";
  if (status === 529 || status === 503) return "overloaded";
  return "http_error";
}

/**
 * Evaluate one state against a map of typed questions.
 *
 * Every question is answered in parallel against the same state in ONE request,
 * and the docs are explicit that adding questions barely moves the latency. So
 * the shape to reach for is a single call carrying every question a turn could
 * need, including speculative ones, with code picking which answers matter.
 * Two sequential calls are only warranted when the second question's OPTIONS
 * depend on the first one's answer.
 *
 * Never throws: a decision model that is down must degrade to the fallback,
 * never take a meal log with it.
 */
export async function askJev(
  state: string | Record<string, unknown> | unknown[],
  questions: Record<string, JevQuestion>,
  deps: JevDeps,
): Promise<JevResult> {
  if (!deps.apiKey) return { ok: false, failure: "no_key", detail: "TYPESAFE_API_KEY not set" };

  const fetchFn = deps.fetchFn ?? fetch;
  const body = JSON.stringify({ state, model: deps.model ?? JEV_MODEL, questions });

  let last: { failure: JevFailure; detail: string } = { failure: "http_error", detail: "no attempt made" };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // A fresh controller per attempt: an aborted one stays aborted, so reusing
    // it would make the retry fail instantly with the previous timeout.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), deps.timeoutMs);
    const onCallerAbort = () => controller.abort();
    if (deps.abortSignal?.aborted) controller.abort();
    deps.abortSignal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      const res = await fetchFn(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${deps.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      if (res.ok) {
        let parsed: JevResponse;
        try {
          parsed = await res.json() as JevResponse;
        } catch (e) {
          return { ok: false, failure: "bad_response", detail: `json parse: ${String(e).slice(0, 120)}` };
        }
        if (!parsed || typeof parsed !== "object" || !parsed.answers) {
          return { ok: false, failure: "bad_response", detail: "no answers in body" };
        }
        return { ok: true, response: parsed };
      }

      const failure = failureFor(res.status);
      last = { failure, detail: `HTTP ${res.status}` };
      if (!RETRYABLE.has(res.status) || attempt === MAX_ATTEMPTS - 1) {
        deps.log?.(`[jev] ${failure} (${last.detail})`);
        return { ok: false, ...last };
      }
      // Honour retry-after when they send one, else a short fixed backoff. This
      // is in front of a waiting user, so the ceiling matters more than politeness.
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 1000)
        : RETRY_BASE_MS * (attempt + 1);
      await new Promise((r) => setTimeout(r, waitMs));
    } catch (e) {
      const aborted = controller.signal.aborted;
      last = {
        failure: aborted ? "timeout" : "http_error",
        detail: aborted ? `exceeded ${deps.timeoutMs}ms` : `fetch threw: ${String(e).slice(0, 120)}`,
      };
      // A caller-driven abort is not a failure to retry around: nobody is
      // waiting for the answer any more.
      if (deps.abortSignal?.aborted || attempt === MAX_ATTEMPTS - 1) {
        deps.log?.(`[jev] ${last.failure} (${last.detail})`);
        return { ok: false, ...last };
      }
    } finally {
      clearTimeout(timeoutId);
      deps.abortSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  return { ok: false, ...last };
}

/** Narrow an answer to a Choice, or null when the shape is not what we asked
 *  for. Typed output guarantees the interface, not that the service on the other
 *  end is the one we think it is, so every read is checked. */
export function asChoice(a: JevAnswer | undefined): JevChoiceAnswer | null {
  if (!a || a.type !== "choice") return null;
  const c = a as JevChoiceAnswer;
  if (typeof c.choice !== "string" || typeof c.confidence !== "number") return null;
  if (!Number.isFinite(c.confidence)) return null;
  return c;
}

/** Narrow an answer to a Noul. Returns the 0-1 probability, or null. */
export function asNoul(a: JevAnswer | undefined): number | null {
  if (!a || a.type !== "noul") return null;
  const n = (a as JevNoulAnswer).noul;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
